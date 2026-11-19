// SPDX-License-Identifier: MIT
// @vitest-environment jsdom
/** Off macOS the notes editor's send chords are the Ctrl ones its hints name. */
import { expect, it, vi } from "vitest";
import { setPlatform } from "@/test/platform";

it("Ctrl+Enter sends the line and Ctrl+Alt+Enter pastes it; Cmd does neither", async () => {
  // The editor's keymap reads the platform once, when it loads.
  setPlatform("Win32");
  const { createEditor } = await import("./kit-entry");
  const onSend = vi.fn();
  const element = document.createElement("div");
  document.body.append(element);
  const editor = createEditor(element, { markdown: "Words", onSend });
  const root = element.querySelector<HTMLElement>(".scratch-note-editor")!;
  const press = (init: KeyboardEventInit) => {
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 13,
      bubbles: true,
      cancelable: true,
      ...init,
    });
    root.dispatchEvent(event);
    return event.defaultPrevented;
  };
  expect(press({ ctrlKey: true })).toBe(true);
  expect(press({ ctrlKey: true, altKey: true })).toBe(true);
  expect(onSend.mock.calls).toEqual([[false], [true]]);
  press({ metaKey: true });
  expect(onSend).toHaveBeenCalledTimes(2);
  editor.destroy();
});
