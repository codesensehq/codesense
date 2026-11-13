// SPDX-License-Identifier: MIT
import { mkdirSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  compositeOver,
  CONTRAST_THRESHOLDS,
  contrastRatio,
} from "../../src/shared/lib/color-contrast";
import { hex } from "../pane-harness/colors";

/**
 * The identity menus portal to `body`, outside every `.ag-*` token scope, so their hints must take
 * the kit's muted ink (the overlay surface sets it). Reads the computed colours and checks the
 * contrast against the surface each one sits on, in light and dark. `SHOTS=<dir>` also saves the
 * captures.
 */

const SHOTS = process.env.SHOTS;
const MIN_RATIO = CONTRAST_THRESHOLDS.text;

async function boot(page: Page, scheme: "light" | "dark") {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: scheme });
  await page.addInitScript((t) => window.localStorage.setItem("theme", t), scheme);
  // The mock has no personal avatar pack: add one to the team's list.
  await page.addInitScript(() => {
    type Internals = {
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
    let installed: Internals;
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      get: () => installed,
      set: (internals: Internals) => {
        installed = internals;
        const original = internals.invoke.bind(internals);
        internals.invoke = async (command, args = {}) => {
          const result = await original(command, args);
          if (command !== "avatar_packs_list_for_team") return result;
          const list = result as { packs?: unknown[] };
          const face = { id: "sketch", ref: "mine:sketch", label: "Sketch", src: "data:," };
          const mine = { id: "mine", name: "My sketches", scope: "personal", faces: [face] };
          return { ...list, packs: [mine, ...(list.packs ?? [])] };
        };
      },
    });
  });
  await page.goto("/?agents=teams");
  await page.waitForFunction(() => Boolean(window.__stores?.useViewerStore));
  await expect(page.locator("html")).toHaveClass(new RegExp(`\\b${scheme}\\b`));
}

/** An element's computed text colour, as opaque hex. */
async function inkOf(page: Page, target: Locator) {
  const css = await target.evaluate((el) => getComputedStyle(el).color);
  return (await hex(page, [css]))[0].slice(0, 7);
}

/** The surface under an element: its ancestors' backgrounds composited over white, as hex. */
async function surfaceOf(page: Page, target: Locator) {
  const layers = await target.evaluate((el) => {
    const out: string[] = [];
    for (let n: Element | null = el; n; n = n.parentElement)
      out.push(getComputedStyle(n).backgroundColor);
    return out.reverse();
  });
  return (await hex(page, layers)).reduce((under, top) => compositeOver(top, under), "#ffffff");
}

/** What a custom property (`--muted-foreground`) resolves to as a colour inside `target`. */
async function variable(page: Page, target: Locator, name: string) {
  const css = await target.evaluate((el, name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    el.appendChild(probe);
    const resolved = getComputedStyle(probe).color;
    probe.remove();
    return resolved;
  }, name);
  return (await hex(page, [css]))[0].slice(0, 7);
}

/** Under `SHOTS`, print each measured ratio so the capture run records them. */
function measured(label: string, ink: string, surface: string) {
  const value = contrastRatio(ink, surface);
  if (SHOTS) console.log(`ratio ${label}: ${value.toFixed(2)} ${ink} on ${surface}`);
  return value;
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/** Right-click the first agent row and open its Face submenu. */
async function openFaceMenu(page: Page) {
  const row = page.locator(".ag-row:not(.ag-ghost)").first();
  await expect(row).toBeVisible();
  await row.click({ button: "right" });
  const face = page.getByRole("menuitem", { name: "Face", exact: true });
  await face.click();
  const trigger = page.getByRole("menuitem", { name: /My sketches/ });
  await expect(trigger).toBeVisible();
  return trigger;
}

for (const scheme of ["light", "dark"] as const) {
  test.describe(`identity menu ink (${scheme})`, () => {
    test("the 'only you' suffix and the team default hint read as secondary ink", async ({
      page,
    }) => {
      await boot(page, scheme);
      const trigger = await openFaceMenu(page);
      const only = trigger.getByText("· only you");
      const menu = trigger.locator('xpath=ancestor::*[@data-surface="overlay"][1]');
      const muted = await variable(page, menu, "--muted-foreground");
      const popover = await variable(page, menu, "--popover-foreground");
      expect(muted).not.toEqual(popover);

      // Hover somewhere else so the row is at rest, then read the span on the menu's own surface.
      await page.getByRole("menuitemradio", { name: "Auto" }).first().hover();
      await expect(trigger).not.toHaveAttribute("data-highlighted", "");
      const surface = await surfaceOf(page, menu);
      const rest = await inkOf(page, only);
      expect(rest).toEqual(muted);
      expect(measured(`${scheme} rest`, rest, surface)).toBeGreaterThanOrEqual(MIN_RATIO);
      await shot(page, `identity-menu-${scheme}-rest`);

      // The team default pack hint sits in the Team default pack submenu.
      await page.getByRole("menuitem", { name: "Team default pack" }).click();
      const hint = page.getByText(/Agents nobody gave a face/);
      await expect(hint).toBeVisible();
      const sub = hint.locator('xpath=ancestor::*[@data-surface="overlay"][1]');
      const hintInk = await inkOf(page, hint);
      expect(hintInk).toEqual(await variable(page, sub, "--muted-foreground"));
      expect(hintInk).not.toEqual(await variable(page, sub, "--popover-foreground"));
      expect(
        measured(`${scheme} team hint`, hintInk, await surfaceOf(page, sub)),
      ).toBeGreaterThanOrEqual(MIN_RATIO);
      await shot(page, `identity-menu-${scheme}-team-hint`);
    });

    test("the suffix takes the row's ink while the row is focused or its submenu is open", async ({
      page,
    }) => {
      await boot(page, scheme);
      const trigger = await openFaceMenu(page);
      const only = trigger.getByText("· only you");

      // Keyboard-focused.
      await trigger.focus();
      await expect(trigger).toBeFocused();
      await expect(trigger).toHaveAttribute("data-state", "closed");
      let fill = await surfaceOf(page, trigger);
      let ink = await inkOf(page, only);
      expect(ink).toEqual(await inkOf(page, trigger));
      expect(measured(`${scheme} focused`, ink, fill)).toBeGreaterThanOrEqual(MIN_RATIO);
      await shot(page, `identity-menu-${scheme}-highlighted`);

      // Submenu open: focus moves into the submenu, so the row is open without `:focus`.
      await page.keyboard.press("ArrowRight");
      await expect(trigger).toHaveAttribute("data-state", "open");
      await expect(trigger).not.toBeFocused();
      fill = await surfaceOf(page, trigger);
      ink = await inkOf(page, only);
      expect(ink).toEqual(await inkOf(page, trigger));
      expect(measured(`${scheme} submenu open`, ink, fill)).toBeGreaterThanOrEqual(MIN_RATIO);
      await shot(page, `identity-menu-${scheme}-submenu-open`);
    });

    test("Settings keeps the secondary ink on its own surface", async ({ page }) => {
      await boot(page, scheme);
      await page.evaluate(async () => {
        const { openSettingsTab } = await new Function(
          "return import('/src/features/settings/lib/open-settings-tab.ts')",
        )();
        openSettingsTab("identity");
      });
      const section = page.getByTestId("identity-section");
      await expect(section).toBeVisible();
      // The mock squeezes the Settings viewer to a sliver; give it room (layout only).
      await page.evaluate(() => {
        for (let n = document.querySelector("[data-testid=identity-section]"); n; ) {
          const el = n as HTMLElement;
          if (el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== "visible")
            el.style.minHeight = `${el.scrollHeight}px`;
          n = n.parentElement;
        }
      });
      const only = section.getByText("· only you");
      await only.scrollIntoViewIfNeeded();
      const ink = await inkOf(page, only);
      expect(ink).toEqual(await variable(page, section, "--muted-foreground"));
      expect(
        measured(`${scheme} settings`, ink, await surfaceOf(page, only)),
      ).toBeGreaterThanOrEqual(MIN_RATIO);
      await shot(page, `identity-settings-${scheme}`);
    });
  });
}
