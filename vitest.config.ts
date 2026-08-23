import { defineConfig } from "vitest/config";

/**
 * Two projects, no overlap.
 *
 * `unit` is fast and touches no network or package manager. `e2e` builds real
 * repositories, runs real installs, and drives a real browser, so it runs one
 * file at a time. The globs live only inside the projects: a root-level
 * `include` would be merged into both and every file would run twice.
 */
export default defineConfig({
  test: {
    environment: "node",
    // Materialization and proof execution shell out to real package managers.
    testTimeout: 300_000,
    hookTimeout: 120_000,
    pool: "forks",
    reporters: process.env["CI"] ? ["default"] : ["dot"],
    exclude: ["**/node_modules/**", "**/dist/**", "apps/console/**", "artifacts/**"],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "apps/cli/src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "e2e",
          include: ["tests/**/*.test.ts"],
          fileParallelism: false,
        },
      },
    ],
  },
});
