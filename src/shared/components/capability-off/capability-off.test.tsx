// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { restorePlatform, setPlatform } from "@/test/platform";
import { resetPlatformCaps, setPlatformCaps } from "@/shared/lib/__test-utils__/platform-caps";
import {
  CapabilityOff,
  CapabilityOffControl,
  CapabilityOffNote,
  CapabilityOffNotice,
} from "./capability-off";

const SENTENCE = "Not yet available on Windows: connecting to other machines is not built here.";
const off = () =>
  setPlatformCaps({ "remote-machines": "connecting to other machines is not built here" });

beforeEach(() => setPlatform("Win32"));
afterEach(() => {
  resetPlatformCaps();
  restorePlatform();
});

describe("CapabilityOff (the panel or state)", () => {
  it("renders its children while the capability is on", () => {
    setPlatformCaps();
    render(
      <CapabilityOff cap="remote-machines">
        <p>the form</p>
      </CapabilityOff>,
    );
    expect(screen.getByText("the form")).toBeInTheDocument();
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("renders the note in their place while it is off", () => {
    off();
    render(
      <CapabilityOff cap="remote-machines">
        <p>the form</p>
      </CapabilityOff>,
    );
    expect(screen.queryByText("the form")).toBeNull();
    expect(screen.getByRole("note")).toHaveTextContent(SENTENCE);
  });

  it("hands the sentence to a surface that frames it its own way", () => {
    off();
    render(
      <CapabilityOff cap="remote-machines" off={(sentence) => <h3>{sentence}</h3>}>
        <p>the form</p>
      </CapabilityOff>,
    );
    expect(screen.getByRole("heading")).toHaveTextContent(SENTENCE);
  });
});

describe("CapabilityOffControl with CapabilityOffNote (the disabled control with a note)", () => {
  function Group({ onAdd }: { onAdd: () => void }) {
    return (
      <>
        <CapabilityOffControl cap="remote-machines" noteId="why">
          <button type="button" className="text-xs" onClick={onAdd}>
            Add machine
          </button>
        </CapabilityOffControl>
        <CapabilityOffNote cap="remote-machines" id="why" />
      </>
    );
  }

  it("leaves the control as it is while the capability is on, with no note", async () => {
    setPlatformCaps();
    const onAdd = vi.fn();
    render(<Group onAdd={onAdd} />);
    const add = screen.getByRole("button", { name: "Add machine" });
    expect(add).not.toHaveAttribute("aria-disabled");
    expect(add).not.toHaveAttribute("title");
    expect(screen.queryByRole("note")).toBeNull();
    await userEvent.click(add);
    expect(onAdd).toHaveBeenCalledOnce();
  });

  it("keeps the control focusable but inert, described by the note, while it is off", async () => {
    off();
    const onAdd = vi.fn();
    render(<Group onAdd={onAdd} />);
    const add = screen.getByRole("button", { name: "Add machine" });
    expect(add).toHaveAttribute("aria-disabled", "true");
    expect(add).not.toBeDisabled();
    expect(add).toHaveAttribute("title", SENTENCE);
    expect(add).toHaveAccessibleDescription(SENTENCE);
    expect(add).toHaveClass("text-xs");
    await userEvent.tab();
    expect(add).toHaveFocus();
    await userEvent.click(add);
    await userEvent.keyboard("{Enter}");
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole("note")).toHaveAttribute("id", "why");
  });
});

describe("CapabilityOffNotice (the inline amber notice)", () => {
  it("renders nothing while the capability is on", () => {
    setPlatformCaps();
    const { container } = render(
      <CapabilityOffNotice cap="mcp-bridge">It starts without tools.</CapabilityOffNotice>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("says what changes, then the sentence, while it is off", () => {
    setPlatformCaps({ "mcp-bridge": "agents can't reach CodeSense" });
    render(
      <ul>
        <CapabilityOffNotice cap="mcp-bridge" as="li" className="ls-warning">
          It starts without tools.
        </CapabilityOffNotice>
      </ul>,
    );
    const notice = screen.getByRole("listitem");
    expect(notice).toHaveClass("ls-warning");
    expect(notice).toHaveAttribute("data-code", "capability-mcp-bridge");
    expect(notice).toHaveTextContent(
      "It starts without tools. Not yet available on Windows: agents can't reach CodeSense.",
    );
  });
});
