# msmcp

A remote [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server
that exposes **New Zealand weather forecasts** as tools an LLM can call. It runs
on **Cloudflare Workers** and speaks MCP over **Streamable HTTP**.

It is intentionally small: two tools, a pluggable forecast provider, no auth, no
caching, no persistence. The deployed worker is backed by **MetService** (NZ's
national forecaster); a free, key-less **Open-Meteo** provider is also built in
and selectable via config (see [Configuration](#configuration)).

## Tools

| Tool           | Purpose                                                            |
| -------------- | ------------------------------------------------------------------ |
| `geocode`      | Resolve an NZ place name / suburb / address to lat/lon (NZ-only).  |
| `get_forecast` | Return an hourly forecast for a lat/lon, plus derived advice flags. |

The model is expected to call `geocode` first when it has a place name, then
pass the coordinates to `get_forecast`.

## Example

Connected to an MCP client (e.g. as a custom connector in Claude), the model
chains the two tools on its own. Asking _"check the weather in Timaru"_:

1. `geocode("Timaru")` resolves the place to coordinates in Canterbury.
2. `get_forecast(lat, lon)` returns the hourly series plus derived flags:

   ```json
   {
     "rain_expected": false,
     "overnight_min_temp_c": 11.11,
     "summary": "Mostly dry with gusts to 18 km/h, overnight low 11°C.",
     "fetcher_used": "metservice"
   }
   ```

3. The model answers from the `summary` and flags, without re-reading the
   hourly array:

   > Timaru's mostly dry today, peaking around 13–14°C, with cloud building
   > through the day but no real rain. Wind is barely there, gusting only to
   > about 18 km/h.

The `fetcher_used` field reports which provider produced the data — here,
`metservice`.

## Architecture

```
src/
  index.ts            Worker entry point. Builds the MCP server, selects the
                      active fetcher (Factory), serves it via createMcpHandler.
  tools/
    geocode.ts        geocode tool: Nominatim lookup + MCP registration.
    forecast.ts       get_forecast tool: defaults, derived flags, summary.
  fetchers/
    interface.ts      ForecastFetcher interface + ForecastParams/RawForecast.
    openmeteo.ts      OpenMeteoFetcher (free, key-less fallback provider).
    metservice.ts     MetServiceFetcher (active in production; needs an API key).
  types.ts            Public domain types (GeocodedLocation, ForecastResult…).
```

The key boundary is **`ForecastFetcher`**. The tool layer depends only on that
interface, so swapping providers is a config change (`FETCHER` env var), not a
code change. `src/index.ts` is the single place that knows which concrete
fetcher is active.

### Transport: why not the MCP SDK's own HTTP transport?

The SDK's `StreamableHTTPServerTransport` is built on Node's
`IncomingMessage`/`ServerResponse`, which the Workers V8 isolate does not
provide. We therefore use `createMcpHandler` from Cloudflare's `agents`
package, which adapts an SDK `McpServer` to a Web-standard `fetch` handler.

We run it **statelessly** — no `sessionIdGenerator`, `enableJsonResponse: true`
— so there is no session state and **no Durable Object**, which is what keeps it
on the Workers **free tier**.

## Configuration

| Variable             | Where            | Default      | Notes                                      |
| -------------------- | ---------------- | ------------ | ------------------------------------------ |
| `FETCHER`            | `wrangler.toml`  | `openmeteo`  | `openmeteo` or `metservice`. The deployed worker is set to `metservice`. |
| `METSERVICE_API_KEY` | secret / `.dev.vars` | _(unset)_ | Required when `FETCHER=metservice`. In production it is a **Cloudflare Worker secret** (`wrangler secret put METSERVICE_API_KEY`), encrypted at Cloudflare and never stored in the repo. For local `wrangler dev`, put it in `.dev.vars` (gitignored). |

## Running locally

> **Prerequisite:** Node.js 20+ and npm. (Wrangler pulls the Workers runtime.)

```bash
npm install
npm run dev          # wrangler dev — serves http://localhost:8787/mcp
```

`npm run typecheck` runs `tsc --noEmit` against the strict config.

## Smoke testing the two tools

`wrangler dev` serves the MCP endpoint at `http://localhost:8787/mcp`. Because
the server is stateless JSON-RPC, you can exercise it with plain `curl` — no MCP
client required. Streamable HTTP requires the `Accept` header to advertise both
JSON and SSE.

A reusable header set:

```bash
H=(-H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream')
URL=http://localhost:8787/mcp
```

### 1. Initialize

```bash
curl -s "${H[@]}" "$URL" -d '{
  "jsonrpc":"2.0","id":1,"method":"initialize",
  "params":{
    "protocolVersion":"2025-06-18",
    "capabilities":{},
    "clientInfo":{"name":"curl","version":"0"}
  }
}'
```

Expect a result advertising `serverInfo.name = "msmcp"`.

### 2. List tools

```bash
curl -s "${H[@]}" "$URL" -d '{
  "jsonrpc":"2.0","id":2,"method":"tools/list","params":{}
}'
```

Expect `geocode` and `get_forecast` with their descriptions and input schemas.

### 3. Call `geocode`

```bash
curl -s "${H[@]}" "$URL" -d '{
  "jsonrpc":"2.0","id":3,"method":"tools/call",
  "params":{"name":"geocode","arguments":{"place":"Wellington"}}
}'
```

Expect `structuredContent` with a lat near `-41.29` and lon near `174.78`.

### 4. Call `get_forecast`

Using those coordinates:

```bash
curl -s "${H[@]}" "$URL" -d '{
  "jsonrpc":"2.0","id":4,"method":"tools/call",
  "params":{"name":"get_forecast","arguments":{"lat":-41.29,"lon":174.78}}
}'
```

Expect `structuredContent` with an `hourly` array, a `rain_expected` boolean,
`overnight_min_temp_c`, a one-sentence `summary`, and a `fetcher_used` field
naming the active provider (`metservice` or `openmeteo`).

### 5. Verify error handling

A place with no New Zealand match should produce a tool error (not a crash).
Note that a foreign city name alone is *not* enough to trigger this: the
`countrycodes=nz` filter only restricts results to NZ, so a name that happens to
match an NZ street or locality still resolves (e.g. there is a "Tokyo" in
Albany, Auckland). Use a string with no NZ match at all:

```bash
curl -s "${H[@]}" "$URL" -d '{
  "jsonrpc":"2.0","id":5,"method":"tools/call",
  "params":{"name":"geocode","arguments":{"place":"Zzqwxnowhereville"}}
}'
```

Expect a result with `isError: true` and a clear message about no NZ match.

## Out of scope (for now)

Auth / OAuth, caching, and rate limiting / metering are deliberately out of
scope and arrive in later phases. (Real MetService API calls were earlier
out of scope but are now live — the worker runs against MetService.)
