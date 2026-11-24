// SPDX-License-Identifier: MIT
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { cleanup, fireEvent, render, screen } from "@/test-utils";

import { ChatCliSwitch, heldLabel, type ChatCliMode } from "./chat-cli-switch";

type Props = Partial<React.ComponentProps<typeof ChatCliSwitch>>;

function Harness({ initial = "chat", ...over }: Props & { initial?: ChatCliMode }) {
  const [mode, setMode] = useState<ChatCliMode>(initial);
  return (
    <ChatCliSwitch
      tabId="t1"
      mode={mode}
      onChange={(next) => setMode(next)}
      width={700}
      unread={0}
      heldLines={0}
      needs={null}
      shortcut="⌘I"
      {...over}
    />
  );
}

const chat = () => screen.getByRole("radio", { name: /^Chat/ });
const cli = () => screen.getByRole("radio", { name: /^CLI/ });

describe("ChatCliSwitch radio semantics", () => {
  it("is a radio group of Chat and CLI with the current mode checked", () => {
    render(<Harness />);
    expect(screen.getByRole("radiogroup")).toBeInTheDocument();
    expect(chat()).toHaveAttribute("aria-checked", "true");
    expect(cli()).toHaveAttribute("aria-checked", "false");
    // Roving tab stop: only the checked segment is in the tab order.
    expect(chat()).toHaveAttribute("tabindex", "0");
    expect(cli()).toHaveAttribute("tabindex", "-1");
  });

  it("arrow keys move the selection and keep focus on the switch", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    chat().focus();
    fireEvent.keyDown(chat(), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("cli", "keyboard");
    fireEvent.keyDown(chat(), { key: "ArrowLeft" });
    expect(onChange).toHaveBeenLastCalledWith("cli", "keyboard");
  });

  it("with state, the arrow moves focus to the newly selected segment", () => {
    function Stateful() {
      const [mode, setMode] = useState<ChatCliMode>("chat");
      return (
        <ChatCliSwitch
          tabId="t1"
          mode={mode}
          onChange={(m) => setMode(m)}
          width={700}
          unread={0}
          heldLines={0}
          needs={null}
          shortcut="⌘I"
        />
      );
    }
    render(<Stateful />);
    chat().focus();
    fireEvent.keyDown(chat(), { key: "ArrowRight" });
    expect(cli()).toHaveAttribute("aria-checked", "true");
    expect(cli()).toHaveFocus();
    fireEvent.keyDown(cli(), { key: "ArrowDown" });
    expect(chat()).toHaveAttribute("aria-checked", "true");
    expect(chat()).toHaveFocus();
  });

  it("a click on the other segment flips it as a pointer choice; the checked one does nothing", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    fireEvent.click(chat());
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(cli());
    expect(onChange).toHaveBeenCalledWith("cli", "pointer");
  });
});

describe("ChatCliSwitch measured width", () => {
  it.each([
    [479, false, false],
    [480, true, false],
    [639, true, false],
    [640, true, true],
  ])("at %i px: labels %s, hint %s", (width, labels, hint) => {
    render(<Harness width={width} />);
    expect(screen.queryByText("Chat") !== null).toBe(labels);
    expect(screen.queryByText("CLI") !== null).toBe(labels);
    // The hint rides the segment that is not showing.
    expect(screen.queryByText("⌘I") !== null).toBe(hint);
    // Icons only still name themselves.
    expect(chat()).toHaveAccessibleName(/Chat/);
    expect(cli()).toHaveAccessibleName(/CLI/);
  });

  it("the hint is on the CLI segment while chat shows, and on Chat while the CLI does", () => {
    const { unmount } = render(<Harness width={700} />);
    expect(cli()).toHaveTextContent("⌘I");
    expect(chat()).not.toHaveTextContent("⌘I");
    unmount();
    render(<Harness width={700} initial="cli" />);
    expect(chat()).toHaveTextContent("⌘I");
    expect(cli()).not.toHaveTextContent("⌘I");
  });
});

describe("ChatCliSwitch unread count", () => {
  it("shows the unread total on the Chat segment, at both widths", () => {
    const { unmount } = render(<Harness unread={3} />);
    expect(chat()).toHaveTextContent("3");
    expect(chat()).toHaveAccessibleName("Chat, 3 unread");
    unmount();
    render(<Harness unread={120} width={300} />);
    expect(chat()).toHaveTextContent("99+");
    expect(screen.queryByText("Chat")).toBeNull();
  });

  it("shows no count when nothing is unread", () => {
    render(<Harness />);
    expect(chat()).toHaveAccessibleName("Chat");
  });
});

describe("ChatCliSwitch held output", () => {
  it("shows N new on the CLI segment while the chat covers, capped at 999+", () => {
    const { unmount } = render(<Harness heldLines={214} />);
    expect(cli()).toHaveTextContent("214 new");
    expect(cli()).toHaveAccessibleName("CLI, 214 new lines");
    unmount();
    render(<Harness heldLines={5000} />);
    expect(cli()).toHaveTextContent("999+ new");
  });

  it("is a dot when icons only", () => {
    render(<Harness heldLines={214} width={300} />);
    expect(cli()).not.toHaveTextContent("214");
    expect(cli().querySelector("[data-held-dot]")).not.toBeNull();
    expect(cli()).toHaveAccessibleName("CLI, 214 new lines");
  });

  it("is gone once the CLI shows", () => {
    render(<Harness heldLines={214} initial="cli" />);
    expect(cli()).not.toHaveTextContent("new");
    expect(cli().querySelector("[data-held-dot]")).toBeNull();
  });

  it("the tooltip says nothing is lost", async () => {
    render(<Harness heldLines={214} />);
    cli().focus();
    expect((await screen.findAllByText(/nothing is lost/)).length).toBeGreaterThan(0);
  });

  it.each([
    [1, "1 new"],
    [999, "999 new"],
    [1000, "999+ new"],
  ])("labels %i lines as %s", (lines, label) => {
    expect(heldLabel(lines)).toBe(label);
  });
});

describe("ChatCliSwitch needs-you flag", () => {
  it.each(["permission", "startup", "question"] as const)(
    "a %s turns the CLI segment to the needs tone with Input needed",
    (needs) => {
      render(<Harness needs={needs} heldLines={12} />);
      expect(cli()).toHaveTextContent("Input needed");
      expect(cli()).not.toHaveTextContent("12 new");
      expect(cli()).toHaveAttribute("data-needs", "true");
      expect(cli()).toHaveAccessibleName("CLI, input needed");
    },
  );

  it("is a needs ring (no words) when icons only", () => {
    render(<Harness needs="permission" width={300} />);
    expect(cli()).toHaveAttribute("data-needs", "true");
    expect(cli()).not.toHaveTextContent("Input needed");
    expect(cli()).toHaveAccessibleName("CLI, input needed");
  });

  it("clears when the kind clears, and is never shown on the CLI itself", () => {
    const { rerender } = render(<Harness needs="permission" />);
    expect(cli()).toHaveAttribute("data-needs", "true");
    rerender(<Harness needs={null} />);
    expect(cli()).not.toHaveAttribute("data-needs");
    cleanup();
    render(<Harness needs="permission" initial="cli" />);
    expect(cli()).not.toHaveAttribute("data-needs");
  });
});
