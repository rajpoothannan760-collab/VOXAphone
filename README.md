[![M8ven Score](https://m8ven.ai/badge/mcp/rajpoothannan760-collab/voxaphone)](https://m8ven.ai/mcp/rajpoothannan760-collab/voxaphone)

# voxaphone-mcp

The official Model Context Protocol (MCP) server for **Voxana AI** — a sub-800ms,
zero-data-at-rest voice execution substrate. It bridges LLM reasoning agents
(Claude, Vapi, Retell, OpenAI, etc.) to real-time telephony and business
action workflows.

## Design principles

- **Zero data-at-rest.** Call state, context, and action records live only in
  a process-local `Map` (`src/store/volatile-state.ts`). Nothing is ever
  written to disk or a database, and no raw transcript/audio content is
  logged.
- **TTL-bounded memory.** Every session carries an expiry derived from
  `max_duration_seconds`; a background sweeper evicts stale sessions so
  memory usage stays bounded for the life of the process.
- **Strict validation.** Every tool input is validated with Zod before any
  handler logic runs.
- **Clean error contracts.** All handlers are wrapped in `safeExecute`, so
  callers always get back structured `{ error, data }` / `{ error, code,
  message }` JSON — never an unhandled exception.

## Tools

| Tool | Purpose |
|---|---|
| `voxa_initiate_outbound_call` | Starts a real-time outbound WebRTC/SIP call and creates its session. |
| `voxa_execute_system_action` | Runs a deterministic operational action (booking, qualification, dispatch, transfer, record update) mid-call. |
| `voxa_trigger_human_escalation` | Issues a SIP REFER / PBX bridge transfer to a human operator. |
| `voxa_get_call_telemetry` | Reads live, volatile metrics for an active call. |

## Tool annotations

Every tool declares all four MCP behavioral hints under `annotations`
(`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`),
set to values reflecting actual runtime behavior rather than defaults:

| Tool | readOnly | destructive | idempotent | openWorld |
|---|---|---|---|---|
| `voxa_initiate_outbound_call` | `false` | `false` | `false` | `true` |
| `voxa_execute_system_action` | `false` | `true` | `false` | `true` |
| `voxa_trigger_human_escalation` | `false` | `false` | `false` | `true` |
| `voxa_get_call_telemetry` | `true` | `false` | `true` | `false` |

These are advisory metadata consumed by MCP hosts and directory trust
indexes — they do not themselves enforce safety. The actual guarantees
(schema validation, session existence checks, structured error handling)
live in the handler code in `src/tools/index.ts`.

## Getting started

```bash
npm install
npm run build
npm start
```

For local development with live reload:

```bash
npm run dev
```

By default the server speaks MCP over **stdio**, which is how hosts like
Claude Desktop or Claude Code launch it as a subprocess. Point your MCP
host config at `dist/server.js` (or `src/server.ts` via `tsx` in dev mode).

### Example MCP host config (stdio)

```json
{
  "mcpServers": {
    "voxaphone": {
      "command": "node",
      "args": ["/absolute/path/to/voxaphone-mcp/dist/server.js"]
    }
  }
}
```

### SSE / HTTP transport

Setting `VOXA_TRANSPORT=sse` signals intent to run over HTTP instead of
stdio. Because that mode requires binding `StreamableHTTPServerTransport`
to a listening HTTP server (e.g. via Express), which is deployment-specific,
`src/server.ts` raises a clear error telling you to wire that host yourself
rather than silently doing nothing.

## Project layout

```
voxaphone-mcp/
├── package.json
├── tsconfig.json
└── src/
    ├── server.ts              # MCP Server wiring, transport, shutdown
    ├── store/
    │   └── volatile-state.ts  # In-memory, TTL-bounded session store
    └── tools/
        └── index.ts           # Zod schemas + handlers for all 4 tools
```

## Compliance note

This server is built to avoid persisting call content, which is a
necessary but not sufficient condition for HIPAA/GDPR alignment — full
compliance also depends on your deployment environment (network
transport encryption, upstream telephony provider agreements, access
controls, etc.), which are outside the scope of this codebase.
