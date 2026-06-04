/**
 * The provider factory: maps the configured `FETCHER` name to a concrete
 * {@link ForecastFetcher}.
 *
 * This is the *only* place that knows about concrete fetchers or the `FETCHER`
 * environment variable. Adding a provider means adding a `case` here and a class
 * implementing {@link ForecastFetcher} — nothing in the tool layer changes
 * (Open/Closed).
 *
 * It lives in its own module (rather than inside the Worker entry point) so it
 * can be unit-tested in plain Node, without importing the Workers-only MCP
 * handler and JSON-schema validator that `index.ts` depends on.
 */

import type { ForecastFetcher } from "./interface.js";
import { OpenMeteoFetcher } from "./openmeteo.js";
import { MetServiceFetcher } from "./metservice.js";

/**
 * Environment bindings the factory reads. Declared `wrangler.toml` (vars) and
 * `.dev.vars` / Worker secrets (the key). Kept narrow so misconfiguration
 * surfaces at the type level.
 */
export interface Env {
  /** Selects the active forecast provider. See {@link createFetcher}. */
  readonly FETCHER?: string;
  /** MetService API key — required only when `FETCHER=metservice`. */
  readonly METSERVICE_API_KEY?: string;
}

/** The provider used when `FETCHER` is unset. */
export const DEFAULT_FETCHER = "openmeteo";

/**
 * Maps the configured provider name to a concrete fetcher.
 *
 * @throws Error if `FETCHER` names a provider we don't recognise, or if a
 *   provider is selected without the configuration it requires.
 */
export function createFetcher(env: Env): ForecastFetcher {
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
