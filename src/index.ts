/**
 * Worker entry point and MCP server wiring for msmcp — a remote MCP server
 * exposing New Zealand weather forecasts over Streamable HTTP.
 *
 * ## Why this transport
 *
 * The MCP SDK's own `StreamableHTTPServerTransport` is built on Node's
 * `IncomingMessage`/`ServerResponse` and does not run in the Cloudflare Workers
 * V8 isolate. Cloudflare's `agents` package provides `createMcpHandler`, which
 * adapts an SDK `McpServer` to a Web-standard `fetch` handler.
 *
 * We run it **statelessly**: by omitting `sessionIdGenerator` and enabling
 * `enableJsonResponse`, each request is handled as a self-contained JSON-RPC
 * request/response with no session state and no Durable Object — which is what
 * lets this server run on the Cloudflare Workers free tier.
 *
 * ## Fetcher selection
 *
 * Provider selection lives in `fetchers/factory.ts` (`createFetcher`), kept
 * separate so it can be unit-tested without this module's Workers-only
 * dependencies. This entry point just hands it the `env` and wires the result
 * into the tool layer, which only ever sees the `ForecastFetcher` interface.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { createMcpHandler } from "agents/mcp";

import { registerGeocodeTool } from "./tools/geocode.js";
import { registerGetForecastTool } from "./tools/forecast.js";
import { createFetcher, type Env } from "./fetchers/factory.js";

/** The route this server answers MCP requests on. */
const MCP_ROUTE = "/mcp";

const SERVER_INFO = {
  name: "msmcp",
  version: "0.1.0",
} as const;

/**
 * Builds an MCP server with both tools registered against the active fetcher.
 *
 * A fresh server is constructed per request (the stateless model), which keeps
 * request handling isolated and avoids any shared mutable state in the isolate.
 */
function buildServer(env: Env): McpServer {
  const server = new McpServer(SERVER_INFO, {
    // The isolate forbids the `eval`/`new Function` that AJV (the SDK default)
    // relies on, so we supply the edge-safe validator explicitly.
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  });

  const fetcher = createFetcher(env);
  registerGeocodeTool(server);
  registerGetForecastTool(server, fetcher);

  return server;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const handler = createMcpHandler(buildServer(env), {
      route: MCP_ROUTE,
      // Stateless: no sessionIdGenerator, plain JSON responses (no SSE stream).
      enableJsonResponse: true,
    });

    return handler(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
