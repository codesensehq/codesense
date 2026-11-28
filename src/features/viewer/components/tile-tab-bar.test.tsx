// SPDX-License-Identifier: MIT
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { TileHost, type TileBodyContext } from "@/shared/tiling/tile-host";
import { bodyCounts, FakeBody, leaf } from "@/shared/tiling/tile-host.test-util";
import { tileKindOf } from "@/shared/tiling/tile-kinds";
import { openTab, type CellTabsMap } from "@/shared/tiling/tile-tabs";

import { TileTabBar, type TileTab } from "./tile-tab-bar";
import { TileTabFrame, TileTabsContext, type TileTabsView } from "./tile-tab-frame";

vi.mock(
  "@/components/ui/resizable",
  async () => (await import("@/shared/tiling/tile-host.test-util")).resizableMock,
);

const DOC: TileTab = { key: "doc:core/team-handbook.md", kind: "file", name: "team-handbook.md" };

function bar(props: Partial<Parameters<typeof TileTabBar>[0]> = {}) {
  return render(
    <TooltipProvider>
      <TileTabBar
        tabs={[DOC]}
        activeKey={DOC.key}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        {...props}
      />
    </TooltipProvider>,
  );
}

describe("TileTabBar", () => {
  it("shows the bar for one tab: its tab, + New tab, the controls, ⋯ and ✕", () => {
    bar({
      onNewTab: vi.fn(),
      controls: <button type="button">Edit</button>,
      menuOf: () => <DropdownMenuItem>Copy path</DropdownMenuItem>,
    });
    const tabs = within(screen.getByRole("tablist", { name: "Tabs in this tile" }));
    expect(tabs.getAllByRole("tab")).toHaveLength(1);
    expect(tabs.getByRole("tab", { name: "team-handbook.md" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "New tab" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "More for team-handbook.md" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Close team-handbook.md" })).toBeTruthy();
  });

  it("draws no + New tab and no ⋯ without them", () => {
    bar();
    expect(screen.queryByRole("button", { name: "New tab" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^More for/ })).toBeNull();
  });

  it("truncates a long name before its team chip, keeping the full text as tooltip and name", () => {
    const name = "a very long agent name that cannot fit in a narrow tile at all";
    const agent: TileTab = {
      key: "agent:team-2/review.bot_1",
      kind: "agent",
      name,
      fullName: `${name}, Team 2`,
      chip: <span>Team 2</span>,
    };
    const { container } = bar({ tabs: [agent], activeKey: agent.key });
    const tab = screen.getByRole("tab", { name: `${name}, Team 2` });
    expect(tab.getAttribute("title")).toBe(`${name}, Team 2`);
    const label = tab.querySelector("[data-tile-tab-name]")!;
    const chip = tab.querySelector("[data-tile-tab-chip]")!;
    // The name shrinks and the chip, after it, never does.
    expect(label.className).toContain("min-w-0");
    expect(chip.className).toContain("flex-shrink-0");
    expect(label.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(chip as HTMLElement).getByText("Team 2")).toBeTruthy();
    expect(container.querySelector("[data-tile-tab-name]")?.textContent).not.toBe("");
  });

  it("selects on click, closes on ✕, middle-click and Delete, and moves focus with arrows", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const shell: TileTab = { key: "tab_7F3e", kind: "shell", name: "zsh" };
    bar({ tabs: [DOC, shell], onSelect, onClose });
    fireEvent.click(screen.getByRole("tab", { name: "zsh" }));
    expect(onSelect).toHaveBeenCalledWith("tab_7F3e");
    fireEvent.click(screen.getByRole("button", { name: "Close team-handbook.md" }));
    expect(onClose).toHaveBeenLastCalledWith(DOC.key);
    fireEvent.pointerDown(screen.getByRole("tab", { name: "zsh" }), { button: 1 });
    expect(onClose).toHaveBeenLastCalledWith("tab_7F3e");
    const first = screen.getByRole("tab", { name: "team-handbook.md" });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "zsh" }));
    fireEvent.keyDown(document.activeElement!, { key: "Delete" });
    expect(onClose).toHaveBeenLastCalledWith("tab_7F3e");
  });

  it("opens a right-clicked tab's own menu and leaves the active tab as it is", async () => {
    const onSelect = vi.fn();
    const shell: TileTab = { key: "tab_7F3e", kind: "shell", name: "zsh" };
    const menuOf = (key: string) => <DropdownMenuItem>Menu of {key}</DropdownMenuItem>;
    bar({ tabs: [DOC, shell], activeKey: DOC.key, onSelect, menuOf });
    fireEvent.contextMenu(screen.getByRole("tab", { name: "zsh" }));
    expect(await screen.findByRole("menuitem", { name: "Menu of tab_7F3e" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: `Menu of ${DOC.key}` })).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    // The open menu is modal, so the tabs behind it are hidden from the accessibility tree.
    const first = screen.getByRole("tab", { name: "team-handbook.md", hidden: true });
    expect(first.getAttribute("aria-selected")).toBe("true");
  });

  it("opens a focused tab's menu with Shift+F10, and ⋯ opens the active tab's", async () => {
    const shell: TileTab = { key: "tab_7F3e", kind: "shell", name: "zsh" };
    const menuOf = (key: string) => <DropdownMenuItem>Menu of {key}</DropdownMenuItem>;
    bar({ tabs: [DOC, shell], activeKey: DOC.key, menuOf });
    fireEvent.keyDown(screen.getByRole("tab", { name: "zsh" }), { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menuitem", { name: "Menu of tab_7F3e" })).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await act(async () => {});
    const more = screen.getByRole("button", { name: "More for team-handbook.md" });
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
    expect(await screen.findByRole("menuitem", { name: `Menu of ${DOC.key}` })).toBeTruthy();
  });

  it("opens no menu for a tab whose menu is empty", () => {
    bar({ menuOf: () => null });
    fireEvent.contextMenu(screen.getByRole("tab", { name: "team-handbook.md" }));
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("button", { name: /^More for/ })).toBeNull();
  });

  it("keeps one tab stop, on the active tab", () => {
    const shell: TileTab = { key: "tab_7F3e", kind: "shell", name: "zsh" };
    bar({ tabs: [DOC, shell], activeKey: shell.key });
    expect(screen.getByRole("tab", { name: "zsh" }).tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: "team-handbook.md" }).tabIndex).toBe(-1);
  });
});

describe("TileTabFrame in the tile host", () => {
  const counts = bodyCounts();
  const renderBody = (key: string, context: TileBodyContext) => (
    <FakeBody tileKey={key} context={context} counts={counts} />
  );
  const SHELL = "tab_7F3e";

  function Window({ cells }: { cells: CellTabsMap }) {
    const view: TileTabsView = {
      cells,
      describe: (key) => ({ key, kind: tileKindOf(key), name: key }),
      onSelect: vi.fn(),
      onClose: vi.fn(),
    };
    return (
      <TileTabsContext.Provider value={view}>
        <TileHost
          node={leaf(DOC.key)}
          renderBody={renderBody}
          wrapBody={TileTabFrame}
          cellTabs={cells}
          onSizesCommit={vi.fn()}
        />
      </TileTabsContext.Provider>
    );
  }

  it("a one-tab tile shows its bar; a second tab changes the bar only and keeps the body node", () => {
    const one: CellTabsMap = new Map();
    const view = render(<Window cells={one} />);
    const body = screen.getByTestId(`body-${DOC.key}`);
    const frame = body.closest("[data-tile-frame]") as HTMLElement;
    expect(within(frame).getAllByRole("tab")).toHaveLength(1);
    counts.reset();

    act(() => view.rerender(<Window cells={openTab(one, DOC.key, SHELL)} />));

    expect(screen.getByTestId(`body-${DOC.key}`)).toBe(body);
    expect(counts.mounts[DOC.key]).toBeUndefined();
    expect(counts.unmounts[DOC.key]).toBeUndefined();
    // The shown tab's frame draws the cell's bar with both tabs; the first body is now hidden.
    const shown = within(screen.getByTestId(`body-${SHELL}`).closest("[data-tile-frame]")!);
    expect(shown.getAllByRole("tab").map((t) => t.getAttribute("aria-label"))).toEqual([
      DOC.key,
      SHELL,
    ]);
    expect(shown.getByRole("tab", { name: SHELL }).getAttribute("aria-selected")).toBe("true");
    expect(body.getAttribute("data-visible")).toBe("false");
  });
});
