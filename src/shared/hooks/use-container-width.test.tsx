// SPDX-License-Identifier: MIT
import { afterEach, describe, expect, it } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { stubResizeObserver } from "@/test/resize-observer-stub";
import { useContainerWidth } from "./use-container-width";

function Probe() {
  const [ref, width] = useContainerWidth<HTMLDivElement>();
  return (
    <div ref={ref} data-testid="probe">
      {width ?? "unmeasured"}
    </div>
  );
}

describe("useContainerWidth", () => {
  let stub: ReturnType<typeof stubResizeObserver> | null = null;
  afterEach(() => {
    stub?.restore();
    stub = null;
  });

  it("reports the measured element's width and follows a resize", () => {
    stub = stubResizeObserver(899);
    render(<Probe />);
    expect(screen.getByTestId("probe")).toHaveTextContent("899");
    act(() => stub!.setWidth(900));
    expect(screen.getByTestId("probe")).toHaveTextContent("900");
  });

  it("stops observing on unmount", () => {
    stub = stubResizeObserver(500);
    const { unmount } = render(<Probe />);
    unmount();
    // A resize after unmount must not reach the unmounted component.
    expect(() => stub!.setWidth(1200)).not.toThrow();
  });
});
