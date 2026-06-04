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
 * This module is the *only* place that knows about concrete fetchers or the
 * `FETCHER` environment variable. {@link createFetcher} is a small factory
 * (the Factory pattern) that maps the configured name to a concrete
 * {@link ForecastFetcher}; the tool layer receives the result through the
 * interface and never learns which provider it got.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker";
import { createMcpHandler } from "agents/mcp";

import { registerGeocodeTool } from "./tools/geocode.js";
import { registerGetForecastTool } from "./tools/forecast.js";
import type { ForecastFetcher } from "./fetchers/interface.js";
import { OpenMeteoFetcher } from "./fetchers/openmeteo.js";
import { MetServiceFetcher } from "./fetchers/metservice.js";

/** The route this server answers MCP requests on. */
const MCP_ROUTE = "/mcp";

const SERVER_INFO = {
  name: "msmcp",
  version: "0.1.0",
} as const;

/**
 * Environment bindings declared in `wrangler.toml` (and `.dev.vars` for local
 * secrets). Kept narrow and explicit so misconfiguration surfaces at the type
 * level.
 */
export interface Env {
  /** Selects the active forecast provider. See {@link createFetcher}. */
  readonly FETCHER?: string;
  /** MetService API key — unused until the MetService fetcher is activated. */
  readonly METSERVICE_API_KEY?: string;
}

/** The provider used when `FETCHER` is unset. */
const DEFAULT_FETCHER = "openmeteo";

/**
 * Factory mapping the configured provider name to a concrete fetcher.
 *
 * Adding a provider means adding a `case` here and a class implementing
 * {@link ForecastFetcher} — nothing in the tool layer changes (Open/Closed).
 *
 * @throws Error if `FETCHER` names a provider we don't recognise, or if a
 *   provider is selected without the configuration it requires.
 */
function createFetcher(env: Env): ForecastFetcher {
  const name = env.FETCHER ?? DEFAULT_FETCHER;

  switch (name) {
    case "openmeteo":
      return new OpenMeteoFetcher();

    case "metservice": {
      const apiKey = env.METSERVICE_API_KEY;
      if (apiKey === undefined || apiKey.length === 0) {
        throw new Error(
          "FETCHER=metservice requires METSERVICE_API_KEY to be set.",
        );
      }
      return new MetServiceFetcher(apiKey);
    }

    default:
      throw new Error(
        `Unknown FETCHER "${name}". Expected "openmeteo" or "metservice".`,
      );
  }
}

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
