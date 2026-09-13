/**
 * src/server.ts
 *
 * voxaphone-mcp — the official Model Context Protocol server for Voxana AI.
 *
 * Wires up the MCP `Server`, registers the four voxa_* tools, dispatches
 * incoming tool calls to their handlers via `safeExecute` (so failures come
 * back as structured JSON rather than crashing the transport), and installs
 * clean shutdown routines that flush the zero-disk in-memory store.
 *
 * Transport:
 *   - Default: stdio (StdioServerTransport) — the standard way an MCP host
 *     (Claude Desktop, Claude Code, etc.) launches this server as a
 *     subprocess.
 *   - Optional: SSE (StreamableHTTPServerTransport-style) when
 *     VOXA_TRANSPORT=sse, for hosts that connect over HTTP instead of
 *     spawning a subprocess.
 */

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import { toolDefinitions, safeExecute } from "./tools/index.js";
import { memoryStore } from "./store/volatile-state.js";

const SERVER_NAME = "voxaphone-mcp";
const SERVER_VERSION = "1.0.0";

function createServer(): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: zodToJsonSchema(tool.inputSchema, { target: "jsonSchema7" }),
      // Per the MCP spec, behavioral hints live under `annotations` on the
      // Tool object (not as flat top-level fields). All four hints are
      // declared explicitly and set to real, non-default values reflecting
      // each tool's actual behavior — see src/tools/index.ts for the
      // per-tool rationale.
      annotations: {
        readOnlyHint: tool.annotations.readOnlyHint,
        destructiveHint: tool.annotations.destructiveHint,
        idempotentHint: tool.annotations.idempotentHint,
        openWorldHint: tool.annotations.openWorldHint,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const tool = toolDefinitions.find((t) => t.name === name);
    if (!tool) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: "${name}"`);
    }

    const result = await safeExecute(() => tool.handler(args ?? {}));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
      isError: result.error,
    };
  });

  server.onerror = (err: unknown) => {
    // Structured, single-line diagnostics only — never logs raw call
    // context, transcripts, or audio payloads, in keeping with the
    // zero-data-at-rest requirement.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[${SERVER_NAME}] server error: ${message}\n`);
  };

  return server;
}

async function main(): Promise<void> {
  const server = createServer();
  const transportMode = (process.env.VOXA_TRANSPORT ?? "stdio").toLowerCase();

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[${SERVER_NAME}] received ${signal}, shutting down cleanly...\n`);
    try {
      await server.close();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[${SERVER_NAME}] error while closing server: ${message}\n`);
    } finally {
      // Guarantees no call context, transcript fragments, or action
      // records remain resident in RAM after the process is asked to
      // stop.
      memoryStore.shutdown();
      process.exit(0);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[${SERVER_NAME}] uncaught exception: ${err.message}\n`);
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    process.stderr.write(`[${SERVER_NAME}] unhandled rejection: ${message}\n`);
  });

  if (transportMode === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    process.stderr.write(`[${SERVER_NAME}] v${SERVER_VERSION} connected over stdio.\n`);
  } else if (transportMode === "sse") {
    // SSE/HTTP transport requires an HTTP server host (e.g. Express) to
    // bind StreamableHTTPServerTransport to a listening port. Wiring that
    // up is deployment-specific, so we surface a clear, actionable error
    // rather than a silent no-op if this mode is selected without the
    // accompanying HTTP host being configured.
    throw new Error(
      "VOXA_TRANSPORT=sse requires an HTTP host wiring StreamableHTTPServerTransport to a listening port. " +
        "See README.md for an example Express integration, or unset VOXA_TRANSPORT to use stdio."
    );
  } else {
    throw new Error(`Unknown VOXA_TRANSPORT value: "${transportMode}". Use "stdio" or "sse".`);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[${SERVER_NAME}] fatal startup error: ${message}\n`);
  memoryStore.shutdown();
  process.exit(1);
});
