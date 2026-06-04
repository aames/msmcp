/**
 * Tests for {@link createFetcher}: the mapping from the `FETCHER` env var to a
 * concrete provider, including the default, the MetService key requirement, and
 * rejection of unknown names.
 */

import { describe, expect, it } from "vitest";
import { createFetcher } from "../src/fetchers/factory.js";

describe("createFetcher", () => {
  it("defaults to Open-Meteo when FETCHER is unset", () => {
    expect(createFetcher({}).id).toBe("openmeteo");
  });

  it("selects Open-Meteo explicitly", () => {
    expect(createFetcher({ FETCHER: "openmeteo" }).id).toBe("openmeteo");
  });

  it("selects MetService when a key is provided", () => {
    expect(
      createFetcher({ FETCHER: "metservice", METSERVICE_API_KEY: "a-key" }).id,
    ).toBe("metservice");
  });

  it("throws a clear error when MetService is selected without a key", () => {
    expect(() => createFetcher({ FETCHER: "metservice" })).toThrow(
      /requires METSERVICE_API_KEY/,
    );
  });

  it("treats an empty-string key as missing", () => {
    expect(() => createFetcher({ FETCHER: "metservice", METSERVICE_API_KEY: "" })).toThrow(
      /requires METSERVICE_API_KEY/,
    );
  });

  it("rejects an unknown provider name", () => {
    expect(() => createFetcher({ FETCHER: "accuweather" })).toThrow(
      /Unknown FETCHER "accuweather"/,
    );
  });
});
