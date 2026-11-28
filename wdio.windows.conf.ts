// SPDX-License-Identifier: MIT
// The two-window e2e runner: WebdriverIO drives the real `e2e-webdriver` app (built by
// `pnpm build:e2e:windows`) through its embedded WebDriver server, and runs
// `tests/windows/**/*.e2e.ts` against it. The `windows-e2e-linux` job runs it under xvfb.
//
// The app launches once per run, in a fresh home, with the launch environment its harness
// guard requires (`CODESENSE_E2E=1` and a nonzero `TAURI_WEBDRIVER_PORT`, here a free port the
// service also connects to). WebdriverIO loads this file again in each worker, which inherits
// the launcher's environment, so the home and the port are chosen once and kept there.
//
// Env: CODESENSE_WINDOWS_E2E_APP names another app binary (default: the debug build).
import { mkdirSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

/** A TCP port free on this machine now. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

if (!process.env.CODESENSE_WINDOWS_E2E_HOME) {
  const home = mkdtempSync(path.join(tmpdir(), "codesense-windows-e2e-"));
  process.env.CODESENSE_WINDOWS_E2E_HOME = home;
  // Both ~/.codesense and the app's data dir follow these, so nothing of the runner's own
  // home is read or written.
  process.env.HOME = home;
  for (const [name, dir] of [
    ["XDG_CONFIG_HOME", ".config"],
    ["XDG_DATA_HOME", ".local/share"],
    ["XDG_CACHE_HOME", ".cache"],
    ["XDG_STATE_HOME", ".local/state"],
  ]) {
    process.env[name] = path.join(home, dir);
    mkdirSync(process.env[name], { recursive: true });
  }
  process.env.CODESENSE_E2E = "1";
  process.env.TAURI_WEBDRIVER_PORT = String(await freePort());
  // WebKitGTK under xvfb has no DMA-BUF renderer to use.
  process.env.WEBKIT_DISABLE_DMABUF_RENDERER ??= "1";
}
const port = Number(process.env.TAURI_WEBDRIVER_PORT);

const application =
  process.env.CODESENSE_WINDOWS_E2E_APP ?? path.join(root, "target", "debug", "codesense");

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./tests/windows/**/*.e2e.ts"],
  // One app, so one worker.
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application },
      "wdio:tauriServiceOptions": {
        driverProvider: "embedded",
        embeddedPort: port,
        captureBackendLogs: true,
        captureFrontendLogs: true,
      },
    } as WebdriverIO.Capabilities,
  ],
  services: [["@wdio/tauri-service", {}]],
  logLevel: "info",
  outputDir: path.join(root, "tests", "windows", "logs"),
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 120_000 },
  waitforTimeout: 20_000,
};
