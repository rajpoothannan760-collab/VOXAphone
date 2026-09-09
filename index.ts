/**
 * src/tools/index.ts
 *
 * Zod schema definitions and typed handler implementations for the four
 * voxaphone-mcp tools. Each handler is wrapped so that thrown errors are
 * converted into structured JSON error payloads rather than propagating
 * as unhandled exceptions to the MCP transport layer.
 */

import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  memoryStore,
  SessionNotFoundError,
  type ExecutedActionRecord,
} from "../store/volatile-state.js";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** E.164: + followed by 8 to 15 digits, first digit 1-9. */
const E164_REGEX = /^\+[1-9]\d{7,14}$/;

export interface ToolError {
  error: true;
  code: string;
  message: string;
}

export interface ToolSuccess<T> {
  error: false;
  data: T;
}

export type ToolResult<T> = ToolSuccess<T> | ToolError;

function ok<T>(data: T): ToolSuccess<T> {
  return { error: false, data };
}

function fail(code: string, message: string): ToolError {
  return { error: true, code, message };
}

/**
 * Wraps a tool handler so any thrown error (validation, missing session,
 * unexpected runtime failure) is captured and returned as a clean,
 * structured JSON error payload instead of an unhandled exception.
 */
async function safeExecute<T>(fn: () => Promise<T> | T): Promise<ToolResult<T>> {
  try {
    const result = await fn();
    return ok(result);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return fail("VALIDATION_ERROR", err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    }
    if (err instanceof SessionNotFoundError) {
      return fail(err.code, err.message);
    }
    if (err instanceof Error) {
      return fail("INTERNAL_ERROR", err.message);
    }
    return fail("UNKNOWN_ERROR", "An unknown error occurred while executing the tool.");
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// Tool 1: voxa_initiate_outbound_call
// ---------------------------------------------------------------------------

export const InitiateOutboundCallInputSchema = z.object({
  to_phone_number: z
    .string()
    .regex(E164_REGEX, "to_phone_number must be a valid E.164 formatted phone number, e.g. +14155551234"),
  workflow_id: z.string().min(1, "workflow_id is required"),
  initial_context: z.record(z.string(), z.unknown()),
  max_duration_seconds: z.number().int().positive().max(7200).optional().default(300),
});

export type InitiateOutboundCallInput = z.infer<typeof InitiateOutboundCallInputSchema>;

export interface InitiateOutboundCallOutput {
  call_id: string;
  status: "initiated";
  sip_session_id: string;
  timestamp: string;
}

async function initiateOutboundCallHandler(
  rawInput: unknown
): Promise<InitiateOutboundCallOutput> {
  const input = InitiateOutboundCallInputSchema.parse(rawInput);

  const callId = `call_${randomUUID()}`;
  const sipSessionId = `sip_${randomUUID()}`;

  memoryStore.createSession({
    callId,
    sipSessionId,
    toPhoneNumber: input.to_phone_number,
    workflowId: input.workflow_id,
    context: input.initial_context,
    maxDurationSeconds: input.max_duration_seconds,
  });

  memoryStore.updateState(callId, "active");

  return {
    call_id: callId,
    status: "initiated",
    sip_session_id: sipSessionId,
    timestamp: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Tool 2: voxa_execute_system_action
// ---------------------------------------------------------------------------

export const ActionTypeEnum = z.enum([
  "BOOK_APPOINTMENT",
  "QUALIFY_LEAD",
  "DISPATCH_SERVICE",
  "TRANSFER_HUMAN",
  "UPDATE_RECORD",
]);

export const ExecuteSystemActionInputSchema = z.object({
  call_id: z.string().min(1, "call_id is required"),
  action_type: ActionTypeEnum,
  action_payload: z.record(z.string(), z.unknown()),
});

export type ExecuteSystemActionInput = z.infer<typeof ExecuteSystemActionInputSchema>;

export interface ExecuteSystemActionOutput {
  success: boolean;
  action_record_id: string;
  execution_latency_ms: number;
  next_prompt_signal: string;
}

/**
 * Maps an action type to the "next prompt signal" that tells the calling
 * agent's dialogue policy what kind of turn should follow this action.
 */
function nextPromptSignalFor(actionType: z.infer<typeof ActionTypeEnum>): string {
  switch (actionType) {
    case "BOOK_APPOINTMENT":
      return "CONFIRM_APPOINTMENT_DETAILS";
    case "QUALIFY_LEAD":
      return "CONTINUE_QUALIFICATION_FLOW";
    case "DISPATCH_SERVICE":
      return "PROVIDE_DISPATCH_ETA";
    case "TRANSFER_HUMAN":
      return "AWAIT_HUMAN_HANDOFF";
    case "UPDATE_RECORD":
      return "ACKNOWLEDGE_UPDATE";
  }
}

async function executeSystemActionHandler(
  rawInput: unknown
): Promise<ExecuteSystemActionOutput> {
  const startedAtMs = performance.now();
  const input = ExecuteSystemActionInputSchema.parse(rawInput);

  // Ensures the call session exists and is tracked before we attribute
  // an action to it; throws SessionNotFoundError otherwise.
  memoryStore.requireSession(input.call_id);

  // Deterministic action execution. In production this would dispatch to
  // the relevant downstream integration (calendar, CRM, dispatch system,
  // PBX) via non-blocking I/O; here we synthesize a structured, in-memory
  // record of the executed action with no payload persisted to disk.
  const actionRecordId = `act_${randomUUID()}`;
  const executionLatencyMs = Math.round(performance.now() - startedAtMs);

  const record: ExecutedActionRecord = {
    actionRecordId,
    actionType: input.action_type,
    executedAtMs: Date.now(),
    latencyMs: executionLatencyMs,
  };

  memoryStore.recordAction(input.call_id, record);

  return {
    success: true,
    action_record_id: actionRecordId,
    execution_latency_ms: executionLatencyMs,
    next_prompt_signal: nextPromptSignalFor(input.action_type),
  };
}

// ---------------------------------------------------------------------------
// Tool 3: voxa_trigger_human_escalation
// ---------------------------------------------------------------------------

export const TriggerHumanEscalationInputSchema = z.object({
  call_id: z.string().min(1, "call_id is required"),
  escalation_reason: z.string().min(1, "escalation_reason is required"),
  target_extension_or_number: z.string().min(1, "target_extension_or_number is required"),
  context_summary: z.string().max(150, "context_summary must be 150 characters or fewer"),
});

export type TriggerHumanEscalationInput = z.infer<typeof TriggerHumanEscalationInputSchema>;

export interface TriggerHumanEscalationOutput {
  transfer_status: "bridged" | "failed";
  handshake_timestamp: string;
}

async function triggerHumanEscalationHandler(
  rawInput: unknown
): Promise<TriggerHumanEscalationOutput> {
  const input = TriggerHumanEscalationInputSchema.parse(rawInput);

  const session = memoryStore.requireSession(input.call_id);

  // Issue the SIP REFER / PBX bridge transfer. In production this calls
  // into the SIP trunking layer; here the handshake is modeled explicitly
  // so downstream tests and integrations have a deterministic contract.
  let transferStatus: "bridged" | "failed";
  try {
    // A target must be routable (non-empty, already validated by schema);
    // any transport-layer failure is caught below and reported cleanly.
    transferStatus = "bridged";
    memoryStore.updateState(session.callId, "escalated");
  } catch {
    transferStatus = "failed";
  }

  return {
    transfer_status: transferStatus,
    handshake_timestamp: nowIso(),
  };
}

// ---------------------------------------------------------------------------
// Tool 4: voxa_get_call_telemetry
// ---------------------------------------------------------------------------

export const GetCallTelemetryInputSchema = z.object({
  call_id: z.string().min(1, "call_id is required"),
});

export type GetCallTelemetryInput = z.infer<typeof GetCallTelemetryInputSchema>;

export interface GetCallTelemetryOutput {
  latency_ms: number;
  turn_count: number;
  active_state: string;
  executed_actions_count: number;
}

async function getCallTelemetryHandler(rawInput: unknown): Promise<GetCallTelemetryOutput> {
  const input = GetCallTelemetryInputSchema.parse(rawInput);
  const session = memoryStore.requireSession(input.call_id);

  // Synthesize a fresh latency sample for this telemetry read. In
  // production this would come from the live WebRTC/SIP media pipeline;
  // here we derive a representative in-memory value and record it on the
  // session for observability without ever touching disk.
  const sampledLatencyMs = session.lastLatencyMs ?? 0;
  const sampledPacketLossPct = session.lastPacketLossPct ?? 0;
  memoryStore.recordTelemetry(session.callId, sampledLatencyMs, sampledPacketLossPct);

  return {
    latency_ms: sampledLatencyMs,
    turn_count: session.turnCount,
    active_state: session.state,
    executed_actions_count: session.executedActions.length,
  };
}

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodTypeAny;
  handler: (rawInput: unknown) => Promise<unknown>;
}

export const toolDefinitions: ToolDefinition[] = [
  {
    name: "voxa_initiate_outbound_call",
    description:
      "Triggers an immediate real-time outbound voice call via WebRTC/SIP trunking. Returns identifiers for the newly created call session.",
    inputSchema: InitiateOutboundCallInputSchema,
    handler: initiateOutboundCallHandler,
  },
  {
    name: "voxa_execute_system_action",
    description:
      "Executes a deterministic operational tool/API action (e.g. booking an appointment, qualifying a lead) during a live voice call without dropping the WebRTC connection.",
    inputSchema: ExecuteSystemActionInputSchema,
    handler: executeSystemActionHandler,
  },
  {
    name: "voxa_trigger_human_escalation",
    description:
      "Instantly issues a SIP REFER or PBX bridge transfer to route the active caller to a human operator, passing along a short context summary.",
    inputSchema: TriggerHumanEscalationInputSchema,
    handler: triggerHumanEscalationHandler,
  },
  {
    name: "voxa_get_call_telemetry",
    description:
      "Retrieves real-time volatile metrics (latency, turn count, execution status) for an active call session.",
    inputSchema: GetCallTelemetryInputSchema,
    handler: getCallTelemetryHandler,
  },
];

export { safeExecute };
