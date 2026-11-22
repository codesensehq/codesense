// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
/** The page SDK's shortcut and machine wording equals the app's own helpers, on both platforms. */
import { viewerScript } from "../../../../tests/support/page-shim";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatKeystrokeDisplay,
  formatModifierClick,
  type ClickModifier,
} from "@/shared/lib/shortcuts/keystroke";
import { localMachineLabel, localMachinePhrase } from "@/shared/lib/local-machine";
import { restorePlatform, setPlatform } from "@/test/platform";

const shim = viewerScript("LINK_INTERCEPTOR_JS");
const KEYS = [
  "CmdOrCtrl+O",
  "CmdOrCtrl+N",
  "CmdOrCtrl+Enter",
  "CmdOrCtrl+Alt+Enter",
  "Alt+ArrowUp",
  "Alt+ArrowDown",
  "CmdOrCtrl+Shift+Alt+P",
  "Shift+Tab",
  "CmdOrCtrl+k",
  "Escape",
  "Backspace",
  "Delete",
  "ArrowLeft",
  "ArrowRight",
  " CmdOrCtrl + Enter ",
  "",
  // Not a keystroke: two keys. The app's parser throws; the page gets no hint.
  "CmdOrCtrl+A+B",
];
const CLICKS: ClickModifier[] = ["CmdOrCtrl", "Shift", "Alt"];

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
  vi.restoreAllMocks();
  restorePlatform();
  document.body.replaceChildren();
});

/** Runs the shim in this window, keeping its listeners so the next test starts clean. */
function install() {
  const added: [EventTarget, string, EventListenerOrEventListenerObject][] = [];
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, "addEventListener").mockImplementation(
      (
        type: string,
        handler: EventListenerOrEventListenerObject,
        opts?: boolean | AddEventListenerOptions,
      ) => {
        added.push([target, type, handler]);
        add(type, handler, opts);
      },
    );
  }
  vi.spyOn(window.parent, "postMessage").mockImplementation(() => {});
  window.eval(shim);
  dispose = () =>
    added.forEach(([target, type, handler]) => target.removeEventListener(type, handler));
  return (window as unknown as { codesense: Record<string, (...args: unknown[]) => string> })
    .codesense;
}
function slotContext(mac: boolean) {
  window.dispatchEvent(
    new MessageEvent("message", {
      source: window.parent,
      data: { type: "codesense:slot-context", context: { slotId: "right-pane" }, mac },
    }),
  );
}
const app = (keys: string) => {
  try {
    return formatKeystrokeDisplay(keys);
  } catch {
    return "";
  }
};

it("names no keys and no machine before the slot context says which platform it is", () => {
  const cs = install();
  for (const keys of KEYS) expect(cs.formatKeys(keys)).toBe("");
  expect(cs.formatModifierClick("Alt")).toBe("");
  expect(cs.localMachineLabel()).toBe("");
  expect(cs.localMachinePhrase()).toBe("");
});

describe.each([
  { platform: "MacIntel", mac: true },
  { platform: "Win32", mac: false },
])("on $platform", ({ platform, mac }) => {
  it("formats every keystroke, click and machine word as the app's helpers do", () => {
    setPlatform(platform);
    const cs = install();
    slotContext(mac);
    expect(KEYS.map((keys) => cs.formatKeys(keys))).toEqual(KEYS.map(app));
    expect(CLICKS.map((mod) => cs.formatModifierClick(mod))).toEqual(
      CLICKS.map(formatModifierClick),
    );
    expect(cs.localMachineLabel()).toBe(localMachineLabel());
    expect(cs.localMachinePhrase()).toBe(localMachinePhrase());
    expect(() => formatKeystrokeDisplay("CmdOrCtrl+A+B")).toThrow();
  });

  it("fills hint text and {keys} templates under a root, the root itself included", () => {
    setPlatform(platform);
    const cs = install();
    slotContext(mac);
    const button = document.createElement("button");
    button.setAttribute("aria-label", "New note");
    button.setAttribute("data-keys-keys", "CmdOrCtrl+N");
    button.setAttribute("data-keys-aria-label", "New note ({keys})");
    button.setAttribute("data-keys-title", "New note ({keys})");
    const kbd = document.createElement("kbd");
    kbd.dataset.keys = "CmdOrCtrl+Alt+Enter";
    const broken = document.createElement("kbd");
    broken.dataset.keys = "CmdOrCtrl+A+B";
    button.append(kbd, broken);
    document.body.append(button);
    cs.fillKeys(button);
    expect(button.getAttribute("aria-label")).toBe(`New note (${app("CmdOrCtrl+N")})`);
    expect(button.title).toBe(`New note (${app("CmdOrCtrl+N")})`);
    expect(kbd.textContent).toBe(app("CmdOrCtrl+Alt+Enter"));
    expect(broken.textContent).toBe("");
  });
});

it("refills the document when a later slot context changes the platform", () => {
  const cs = install();
  document.body.innerHTML = '<kbd data-keys="CmdOrCtrl+Enter"></kbd>';
  cs.fillKeys();
  expect(document.querySelector("kbd")!.textContent).toBe("");
  slotContext(true);
  expect(document.querySelector("kbd")!.textContent).toBe("⌘⏎");
  slotContext(false);
  expect(document.querySelector("kbd")!.textContent).toBe("Ctrl+⏎");
});
