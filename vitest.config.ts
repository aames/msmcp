import { defineConfig } from "vitest/config";

/**
 * Unit/logic test configuration.
 *
 * These tests run in plain Node (not the Workers `workerd` runtime): every
 * module under test depends only on Web-standard globals (`fetch`, `URL`,
 * `Response`, `JSON`), all of which Node 20+ provides. Provider HTTP calls are
 * mocked, so no network access is required. Integration tests that exercise the
 * MCP handler inside `workerd` are a separate, later layer.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
