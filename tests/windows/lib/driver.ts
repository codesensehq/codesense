// SPDX-License-Identifier: MIT
// What the two-window specs share: `main`'s driver door (`window.__CODESENSE_WINDOWS_E2E__`,
// `src/app/e2e-windows-control.ts`), switching between windows (the embedded WebDriver server's
// handles are the window labels), and a plain `invoke` in whichever window is current.
import { randomUUID } from "node:crypto";
import { browser } from "@wdio/globals";

export const MAIN = "main";

/** What a spec asks the seed for beyond the probe org and team; none yet (`SeedOptions`). */
type SeedOptions = Record<string, never>;

interface Door {
  seed(options?: SeedOptions): Promise<{ probeHtml: string }>;
  open(options: { id: string; probe?: string }): Promise<string>;
}

type DriverWindow = Window & {
  __CODESENSE_WINDOWS_E2E__?: Door;
  __CODESENSE_PROBE_RESULTS__?: Record<string, string>;
  __CODESENSE_CONFIGURATION_E2E__?: { snapshot(): { principal: string | null } };
  __TAURI_INTERNALS__?: { invoke(cmd: string, args?: unknown): Promise<unknown> };
};

/** An id no other spec in this launch uses: a window's entry outlives its close. */
export function freshId(name: string): string {
  return `${name}-${randomUUID().slice(0, 8)}`;
}

/** Waits for `main`'s door, then seeds once (a second seed returns the same path). */
export async function seed(options: SeedOptions = {}): Promise<{ probeHtml: string }> {
  await browser.switchToWindow(MAIN);
  await browser.waitUntil(
    () => browser.execute(() => Boolean((window as DriverWindow).__CODESENSE_WINDOWS_E2E__)),
    { timeout: 60_000, timeoutMsg: "main never registered the windows e2e door" },
  );
  return browser.execute(
    (o) => (window as DriverWindow).__CODESENSE_WINDOWS_E2E__!.seed(o),
    options,
  );
}

/** Opens `pane-<id>` from `main` and switches to it once its root has rendered. */
export async function open(options: { id: string; probe?: string }): Promise<string> {
  await browser.switchToWindow(MAIN);
  const label = await browser.execute(
    (o) => (window as DriverWindow).__CODESENSE_WINDOWS_E2E__!.open(o),
    options,
  );
  await browser.waitUntil(async () => (await browser.getWindowHandles()).includes(label), {
    timeoutMsg: `${label} never got a window handle`,
  });
  await browser.switchToWindow(label);
  await browser.waitUntil(
    () => browser.execute(() => document.querySelector("[data-satellite-root]") !== null),
    { timeout: 30_000, timeoutMsg: `${label} never rendered its satellite root` },
  );
  return label;
}

export type Invoked = { ok: true; value: unknown } | { ok: false; error: string };

/** `invoke(cmd, args)` in the current window; a refusal is returned, not thrown. */
export async function invoke(cmd: string, args?: Record<string, unknown>): Promise<Invoked> {
  return await browser.execute(
    (c, a) =>
      (window as DriverWindow).__TAURI_INTERNALS__!.invoke(c, a).then(
        (value): Invoked => ({ ok: true, value }),
        (e: unknown): Invoked => ({ ok: false, error: String(e) }),
      ),
    cmd,
    args ?? {},
  );
}

/** `main`'s active profile principal, as its configuration door reports it. */
export async function principal(): Promise<string> {
  await browser.switchToWindow(MAIN);
  const found = await browser.execute(
    () => (window as DriverWindow).__CODESENSE_CONFIGURATION_E2E__?.snapshot().principal ?? null,
  );
  if (!found) throw new Error("main has no active profile principal");
  return found;
}

/** The current window's probe results, `{}` until its dashboard posts one. */
export async function probeResults(): Promise<Record<string, string>> {
  return await browser.execute(() => ({ ...(window as DriverWindow).__CODESENSE_PROBE_RESULTS__ }));
}
