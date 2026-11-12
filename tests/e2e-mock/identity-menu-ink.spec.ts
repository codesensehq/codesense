// SPDX-License-Identifier: MIT
import { mkdirSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * The identity menus portal to `body`, outside every `.ag-*` token scope, so their hints must take
 * the kit's muted ink (the overlay surface sets it). Reads the computed colours and checks the
 * contrast against the surface each one sits on, in light and dark. `SHOTS=<dir>` also saves the
 * captures.
 */

const SHOTS = process.env.SHOTS;
const MIN_RATIO = 4.5;
type Rgb = [number, number, number];

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

/** An element's computed colour (or the page variable behind it) as sRGB bytes, via a canvas. */
async function resolved(page: Page, target: Locator, what: "color" | "background") {
  return target.evaluate((el, what) => {
    const toRgba = (css: string): [number, number, number, number] => {
      const c = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
      c.clearRect(0, 0, 1, 1);
      c.fillStyle = "#000";
      c.fillStyle = css;
      c.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = c.getImageData(0, 0, 1, 1).data;
      return [r, g, b, a / 255];
    };
    if (what === "color") return toRgba(getComputedStyle(el).color).slice(0, 3);
    // Composite the translucent backgrounds up to the first opaque one, over white.
    const layers: [number, number, number, number][] = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const px = toRgba(getComputedStyle(n).backgroundColor);
      if (px[3] > 0) layers.push(px);
      if (px[3] === 1) break;
    }
    let out: [number, number, number] = [255, 255, 255];
    for (const [r, g, b, a] of layers.reverse())
      out = [r * a + out[0] * (1 - a), g * a + out[1] * (1 - a), b * a + out[2] * (1 - a)];
    return out.map(Math.round);
  }, what) as Promise<Rgb>;
}

/** The colour a `--muted-foreground` / `--popover-foreground` custom property resolves to at `el`. */
async function variable(target: Locator, name: string) {
  return target.evaluate((el, name) => {
    const probe = document.createElement("span");
    probe.style.color = `var(${name})`;
    el.appendChild(probe);
    const css = getComputedStyle(probe).color;
    probe.remove();
    const c = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!;
    c.fillStyle = "#000";
    c.fillStyle = css;
    c.fillRect(0, 0, 1, 1);
    return Array.from(c.getImageData(0, 0, 1, 1).data.slice(0, 3));
  }, name) as Promise<Rgb>;
}

function luminance([r, g, b]: Rgb) {
  const lin = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(a: Rgb, b: Rgb) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Under `SHOTS`, print each measured ratio so the capture run records them. */
function measured(label: string, ink: Rgb, surface: Rgb) {
  const value = ratio(ink, surface);
  if (SHOTS) console.log(`ratio ${label}: ${value.toFixed(2)} rgb(${ink}) on rgb(${surface})`);
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
      const muted = await variable(menu, "--muted-foreground");
      const popover = await variable(menu, "--popover-foreground");
      expect(muted).not.toEqual(popover);

      // Hover somewhere else so the row is at rest, then read the span on the menu's own surface.
      await page.getByRole("menuitemradio", { name: "Auto" }).first().hover();
      await expect(trigger).not.toHaveAttribute("data-highlighted", "");
      const surface = await resolved(page, menu, "background");
      const rest = await resolved(page, only, "color");
      expect(rest).toEqual(muted);
      expect(measured(`${scheme} rest`, rest, surface)).toBeGreaterThanOrEqual(MIN_RATIO);
      await shot(page, `identity-menu-${scheme}-rest`);

      // The team default pack hint sits in the Team default pack submenu.
      await page.getByRole("menuitem", { name: "Team default pack" }).click();
      const hint = page.getByText(/Agents nobody gave a face/);
      await expect(hint).toBeVisible();
      const sub = hint.locator('xpath=ancestor::*[@data-surface="overlay"][1]');
      const hintInk = await resolved(page, hint, "color");
      expect(hintInk).toEqual(await variable(sub, "--muted-foreground"));
      expect(hintInk).not.toEqual(await variable(sub, "--popover-foreground"));
      expect(
        measured(`${scheme} team hint`, hintInk, await resolved(page, sub, "background")),
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
      let fill = await resolved(page, trigger, "background");
      let ink = await resolved(page, only, "color");
      expect(ink).toEqual(await resolved(page, trigger, "color"));
      expect(measured(`${scheme} highlight`, ink, fill)).toBeGreaterThanOrEqual(MIN_RATIO);
      await shot(page, `identity-menu-${scheme}-highlighted`);

      // Submenu open: focus moves into the submenu, so the row is open without `:focus`.
      await page.keyboard.press("ArrowRight");
      await expect(trigger).toHaveAttribute("data-state", "open");
      await expect(trigger).not.toBeFocused();
      fill = await resolved(page, trigger, "background");
      ink = await resolved(page, only, "color");
      expect(ink).toEqual(await resolved(page, trigger, "color"));
      expect(measured(`${scheme} highlight`, ink, fill)).toBeGreaterThanOrEqual(MIN_RATIO);
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
      const ink = await resolved(page, only, "color");
      expect(ink).toEqual(await variable(section, "--muted-foreground"));
      expect(
        measured(`${scheme} settings`, ink, await resolved(page, only, "background")),
      ).toBeGreaterThanOrEqual(MIN_RATIO);
      await shot(page, `identity-settings-${scheme}`);
    });
  });
}
