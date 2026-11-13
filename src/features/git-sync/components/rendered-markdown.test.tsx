// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { Root as HastRoot } from "hast";

const parseMarkdownMock = vi.fn();
vi.mock("@/shared/lib/markdown-worker/client", () => ({
  parseMarkdown: (text: string) => parseMarkdownMock(text),
}));

import { RenderedMarkdown } from "./rendered-markdown";

function pHast(text: string): HastRoot {
  return {
    type: "root",
    children: [
      { type: "element", tagName: "p", properties: {}, children: [{ type: "text", value: text }] },
    ],
  };
}

describe("RenderedMarkdown", () => {
  it("renders one side's markdown through the worker", async () => {
    parseMarkdownMock.mockReturnValue({
      promise: Promise.resolve(pHast("rendered")),
      cancel: vi.fn(),
    });
    render(<RenderedMarkdown text="# hi" />);
    expect(await screen.findByText("rendered")).toBeInTheDocument();
    expect(parseMarkdownMock).toHaveBeenCalledWith("# hi");
  });

  it("shows a parse failure in place", async () => {
    parseMarkdownMock.mockReturnValue({
      promise: Promise.reject(new Error("bad")),
      cancel: vi.fn(),
    });
    render(<RenderedMarkdown text="x" />);
    expect(await screen.findByText(/Couldn’t render: bad/)).toBeInTheDocument();
  });
});
