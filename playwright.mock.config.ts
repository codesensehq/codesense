// SPDX-License-Identifier: MIT
import { defineConfig, devices } from "@playwright/test";

/**
 * Layout specs against the frontend mock backend (`pnpm dev:mock`, see
 * src/app/mock/README.md) — real browser geometry, no Rust. Starts its own
 * mock vite on `PORT` (default 5198, never the shared :1420) unless one is
 * already up there; or point `BASE_URL` at a server you started yourself.
 *
 *   npm run test:e2e:mock              # self-hosted on :5198
 *   PORT=5311 npm run test:e2e:mock    # another free port
 *
 * A server already on the port must belong to this worktree (checked via the dev-only
 * `/__cs-worktree` marker, SV-PBF-163); a foreign or unverifiable one fails the run. Stop it,
 * change `PORT`, or start your own server and set `BASE_URL` to it.
 */
const PORT = Number(process.env.PORT ?? 5198);
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;

export default defineConfig({
  globalSetup: "./scripts/playwright-guard-mock.ts",
  testDir: "./tests/e2e-mock",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
  },
  timeout: 90_000,
  // A cold boot on a CI runner can take longer than the 5 s default to draw its first view:
  // assertions wait as long as actions do there.
  expect: { timeout: process.env.CI ? 15_000 : 5_000 },
  // Tile specs (tests/e2e-mock/tiles/, see its README) run on both engines in their own projects;
  // the older projects leave them alone. Only `.spec.ts` files are specs, not the probe's fixtures.
  projects: [
    { name: "chromium", testIgnore: /tiles\//, use: { ...devices["Desktop Chrome"] } },
    {
      name: "webkit",
      testMatch: /(?:agent-list-qa-live|pane-save)\.spec\.ts/,
      testIgnore: /tiles\//,
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "tiles-webkit",
      testMatch: /tiles\/.*\.spec\.ts$/,
      use: { ...devices["Desktop Safari"] },
    },
    {
      name: "tiles-chromium",
      testMatch: /tiles\/.*\.spec\.ts$/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: process.env.BASE_URL
    ? undefined
    : {
        command: `pnpm run dev:mock --port ${PORT} --strictPort`,
        url: BASE_URL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
