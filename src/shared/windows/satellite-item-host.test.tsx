// SPDX-License-Identifier: MIT
/**
 * The one-item host (`satellite-item-host.tsx`): an item whose kind has a renderer shows
 * full-window, alone, when the window has no layout; any other item is not mounted.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { ItemKey } from "./item-key";
import {
  registerSatelliteItemRenderer,
  resetSatelliteItemRenderersForTests,
  SatelliteItemHost,
} from "./satellite-item-host";

const fake: ItemKey = { kind: "fake", team: "acme", id: "notes/plan.md" };
const unknown: ItemKey = { kind: "unregistered", team: "acme", id: "notes/plan.md" };

afterEach(() => {
  cleanup();
  resetSatelliteItemRenderersForTests();
});

describe("SatelliteItemHost", () => {
  it("registers no kind of its own", () => {
    const { container } = render(
      <SatelliteItemHost layoutRef={null} item={{ ...fake, kind: "tab" }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders a registered kind full-window with no tab strip", () => {
    registerSatelliteItemRenderer("fake", (item) => <p>body of {item.id}</p>);
    const { container } = render(<SatelliteItemHost layoutRef={null} item={fake} />);
    const host = container.querySelector("[data-satellite-item]");
    expect(host).toHaveClass("h-full", "w-full");
    expect(host?.children).toHaveLength(1);
    expect(screen.getByText("body of notes/plan.md")).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("does not mount a key with no registered renderer", () => {
    registerSatelliteItemRenderer("fake", () => <p>fake body</p>);
    const { container } = render(<SatelliteItemHost layoutRef={null} item={unknown} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("leaves a window with a layout to the layout", () => {
    registerSatelliteItemRenderer("fake", () => <p>fake body</p>);
    const { container } = render(<SatelliteItemHost layoutRef="layout-1" item={fake} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing without an item", () => {
    registerSatelliteItemRenderer("fake", () => <p>fake body</p>);
    const { container } = render(<SatelliteItemHost layoutRef={null} item={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("refuses a second renderer for one kind", () => {
    registerSatelliteItemRenderer("fake", () => <p>first</p>);
    expect(() => registerSatelliteItemRenderer("fake", () => <p>second</p>)).toThrow(
      "a renderer for fake is already registered",
    );
  });
});
