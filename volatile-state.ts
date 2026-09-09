/**
 * volatile-state.ts
 *
 * Zero-data-at-rest, in-memory state store for active call sessions.
 *
 * Design constraints:
 *  - Everything lives in a JS `Map` in process RAM only. Nothing is ever
 *    written to disk, no database client is imported, and no logger writes
 *    raw transcript/audio content anywhere.
 *  - Each session carries a TTL. A single sweeper interval evicts expired
 *    or terminated sessions so memory never grows unbounded across the
 *    life of the process.
 *  - On process shutdown (`shutdown()`), all in-memory state is explicitly
 *    cleared before exit — belt-and-suspenders against anything lingering
 *    in RAM after the process is asked to stop.
 */

export type CallState = "initiated" | "active" | "escalated" | "completed" | "failed";

export interface ExecutedActionRecord {
  actionRecordId: string;
  actionType: string;
  executedAtMs: number;
  latencyMs: number;
}

export interface CallSession {
  callId: string;
  sipSessionId: string;
  toPhoneNumber: string;
  workflowId: string;
  /** Arbitrary key-value context for the call runtime. Kept in RAM only. */
  context: Record<string, unknown>;
  state: CallState;
  createdAtMs: number;
  /** Absolute epoch ms after which this session is eligible for eviction. */
  expiresAtMs: number;
  maxDurationSeconds: number;
  turnCount: number;
  executedActions: ExecutedActionRecord[];
  lastLatencyMs: number | null;
  lastPacketLossPct: number | null;
}

export interface CreateSessionInput {
  callId: string;
  sipSessionId: string;
  toPhoneNumber: string;
  workflowId: string;
  context: Record<string, unknown>;
  maxDurationSeconds: number;
}

const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
/** Grace period appended to maxDurationSeconds before hard eviction. */
const EVICTION_GRACE_MS = 60_000;

export class MemoryStore {
  private readonly sessions = new Map<string, CallSession>();
  private readonly sweepTimer: ReturnType<typeof setInterval>;
  private isShutDown = false;

  constructor(sweepIntervalMs: number = DEFAULT_SWEEP_INTERVAL_MS) {
    this.sweepTimer = setInterval(() => this.sweep(), sweepIntervalMs);
    // Do not let the sweeper keep the process alive on its own.
    this.sweepTimer.unref?.();
  }

  createSession(input: CreateSessionInput): CallSession {
    this.assertAlive();
    const now = Date.now();
    const session: CallSession = {
      callId: input.callId,
      sipSessionId: input.sipSessionId,
      toPhoneNumber: input.toPhoneNumber,
      workflowId: input.workflowId,
      context: { ...input.context },
      state: "initiated",
      createdAtMs: now,
      expiresAtMs: now + input.maxDurationSeconds * 1000 + EVICTION_GRACE_MS,
      maxDurationSeconds: input.maxDurationSeconds,
      turnCount: 0,
      executedActions: [],
      lastLatencyMs: null,
      lastPacketLossPct: null,
    };
    this.sessions.set(session.callId, session);
    return session;
  }

  getSession(callId: string): CallSession | undefined {
    this.assertAlive();
    const session = this.sessions.get(callId);
    if (session && session.expiresAtMs <= Date.now()) {
      this.sessions.delete(callId);
      return undefined;
    }
    return session;
  }

  requireSession(callId: string): CallSession {
    const session = this.getSession(callId);
    if (!session) {
      throw new SessionNotFoundError(callId);
    }
    return session;
  }

  updateState(callId: string, state: CallState): CallSession {
    const session = this.requireSession(callId);
    session.state = state;
    if (state === "completed" || state === "failed") {
      // Terminated sessions still linger briefly for telemetry reads,
      // but shrink their TTL so they are swept promptly.
      session.expiresAtMs = Math.min(session.expiresAtMs, Date.now() + 15_000);
    }
    return session;
  }

  recordAction(callId: string, record: ExecutedActionRecord): CallSession {
    const session = this.requireSession(callId);
    session.executedActions.push(record);
    session.turnCount += 1;
    return session;
  }

  recordTelemetry(callId: string, latencyMs: number, packetLossPct: number): CallSession {
    const session = this.requireSession(callId);
    session.lastLatencyMs = latencyMs;
    session.lastPacketLossPct = packetLossPct;
    return session;
  }

  deleteSession(callId: string): boolean {
    return this.sessions.delete(callId);
  }

  size(): number {
    return this.sessions.size;
  }

  /** Evicts every session whose TTL has elapsed. Runs on a timer. */
  private sweep(): void {
    const now = Date.now();
    for (const [callId, session] of this.sessions) {
      if (session.expiresAtMs <= now) {
        this.sessions.delete(callId);
      }
    }
  }

  private assertAlive(): void {
    if (this.isShutDown) {
      throw new Error("MemoryStore has been shut down; no further state operations are permitted.");
    }
  }

  /** Clears all in-memory state and stops the sweeper. Call on process shutdown. */
  shutdown(): void {
    clearInterval(this.sweepTimer);
    this.sessions.clear();
    this.isShutDown = true;
  }
}

export class SessionNotFoundError extends Error {
  readonly code = "SESSION_NOT_FOUND";
  constructor(callId: string) {
    super(`No active call session found for call_id "${callId}". It may have completed, expired, or never existed.`);
    this.name = "SessionNotFoundError";
  }
}

/** Process-wide singleton store shared by all tool handlers. */
export const memoryStore = new MemoryStore();
