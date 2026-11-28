// SPDX-License-Identifier: MIT
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TooltipProvider } from "@/components/ui/tooltip";
import { revealPath } from "@/tauri/commands";

import { TileTabBar, type TileTabBarProps } from "./tile-tab-bar";
import {
  DiffNavControls,
  DiffTabMenu,
  DiffWorktreePicker,
  HtmlSourceIdentity,
  diffTabFace,
  fileTabFace,
  htmlTabFace,
  storyTabFace,
  type DiffWorktreeRow,
} from "./tile-tab-faces";

vi.mock("@/tauri/commands", async (original) => ({
  ...(await original<typeof import("@/tauri/commands")>()),
  revealPath: vi.fn(async () => {}),
}));

function bar(props: Pick<TileTabBarProps, "tabs"> & Partial<TileTabBarProps>) {
  return render(
    <TooltipProvider>
      <TileTabBar activeKey={props.tabs[0].key} onSelect={vi.fn()} onClose={vi.fn()} {...props} />
    </TooltipProvider>,
  );
}

const openMenu = (name: RegExp | string) =>
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });

describe("story page tab", () => {
  it("shows its stage as the only pill", () => {
    bar({
      tabs: [
        storyTabFace({
          key: "story-page:DEMO-63",
          storyId: "DEMO-63",
          title: "Simplify the board",
          status: "dev",
        }),
      ],
    });
    const tab = screen.getByRole("tab");
    expect(tab.querySelectorAll("[data-tile-tab-chip]")).toHaveLength(0);
    expect(within(tab).getAllByLabelText("dev")).toHaveLength(1);
    expect(screen.queryByTestId("tile-caption")).toBeNull();
  });

  it("keeps its full title as the tab's tooltip and accessible name when cut off", () => {
    const title = "A long title that the narrow tab cuts off well before its end";
    bar({ tabs: [storyTabFace({ key: "story-page:DEMO-63", storyId: "DEMO-63", title })] });
    const tab = screen.getByRole("tab", { name: `DEMO-63 ${title}` });
    expect(tab).toHaveAttribute("title", `DEMO-63 ${title}`);
  });
});

describe("HTML tab", () => {
  it("shows its source, team and unread badge", () => {
    bar({
      tabs: [
        htmlTabFace({
          key: "doc:alpha/panes/board.html",
          name: "Board",
          source: "alpha panes",
          team: "alpha",
          badge: { count: 3, severity: "info" },
        }),
      ],
    });
    const tab = screen.getByRole("tab", { name: "Board · alpha panes · alpha · 3 unread" });
    expect(tab).toHaveAttribute("title", "Board · alpha panes · alpha · 3 unread");
    expect(tab.querySelector("[data-tile-tab-chip]")).toHaveTextContent("alpha");
    expect(tab.querySelector("[data-tile-tab-badge]")).toHaveTextContent("3");
  });

  it("names its source in the bar, in full when cut off", () => {
    const source = "alpha/panes/reports/quarterly";
    bar({
      tabs: [htmlTabFace({ key: "doc:alpha/board.html", name: "Board", source })],
      identity: <HtmlSourceIdentity source={source} />,
    });
    const identity = screen.getByTestId("tile-tab-bar").querySelector("[data-tile-identity]")!;
    expect(within(identity as HTMLElement).getByLabelText(source)).toHaveAttribute("title", source);
  });

  it("draws no badge with nothing unread and no chip for the team on screen", () => {
    bar({
      tabs: [
        htmlTabFace({
          key: "doc:alpha/board.html",
          name: "Board",
          source: "alpha",
          badge: { count: 0, severity: "info" },
        }),
      ],
    });
    const tab = screen.getByRole("tab", { name: "Board · alpha" });
    expect(tab.querySelector("[data-tile-tab-badge]")).toBeNull();
    expect(tab.querySelector("[data-tile-tab-chip]")).toBeNull();
  });
});

describe("file tab", () => {
  it("names the file and keeps its path in full", () => {
    bar({ tabs: [fileTabFace({ key: "doc:core/guides/setup.md", path: "guides/setup.md" })] });
    expect(screen.getByRole("tab", { name: "guides/setup.md" })).toHaveTextContent("setup.md");
  });
});

const ctxRow: DiffWorktreeRow = {
  kind: "context",
  id: "ctx-demo",
  branch: "ctx/DEMO-63",
  files: 12,
  path: "/home/me/code/ctx-demo",
  repo: { kind: "local", cwd: "/home/me/code/ctx-demo" },
};
const machineRow: DiffWorktreeRow = {
  kind: "source",
  id: "remote-demo",
  branch: "feat/DEMO-63",
  files: 3,
  path: "/srv/work/demo",
  machine: "build-box",
  repo: { kind: "remote", machineId: "m1", handle: "h1" },
};

function diffBar(
  picked: DiffWorktreeRow,
  tabs = [diffTabFace({ key: "diff:context:ctx-demo", row: picked })],
) {
  const onPick = vi.fn();
  const nav = { onPrev: vi.fn(), onNext: vi.fn() };
  bar({
    tabs,
    identity: (
      <DiffWorktreePicker
        rows={[ctxRow, picked.machine ? picked : machineRow]}
        picked={picked}
        onPick={onPick}
      />
    ),
    controls: <DiffNavControls {...nav} />,
    menu: <DiffTabMenu row={picked} />,
  });
  return { onPick, nav };
}

describe("diff tab", () => {
  beforeEach(() => vi.mocked(revealPath).mockClear());

  it("puts the worktree picker before ‹ ›", () => {
    diffBar(ctxRow);
    const picker = screen.getByRole("button", { name: "Worktree: ctx/DEMO-63 (context)" });
    const prev = screen.getByRole("button", { name: "Previous change" });
    expect(picker.compareDocumentPosition(prev) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps ‹ › drawn, with one tab or several", () => {
    const { nav } = diffBar(ctxRow, [
      diffTabFace({ key: "diff:context:ctx-demo", row: ctxRow }),
      fileTabFace({ key: "doc:core/a.md", path: "a.md" }),
      fileTabFace({ key: "doc:core/b.md", path: "b.md" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Next change" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous change" }));
    expect(nav.onNext).toHaveBeenCalledTimes(1);
    expect(nav.onPrev).toHaveBeenCalledTimes(1);
  });

  it("lists the story's worktrees and picks one", async () => {
    const { onPick } = diffBar(ctxRow);
    openMenu(/^Worktree:/);
    expect(
      await screen.findByRole("menuitem", { name: /ctx\/DEMO-63 \(context\)/ }),
    ).toHaveTextContent("12 files");
    const remote = screen.getByRole("menuitem", { name: /build-box, feat\/DEMO-63/ });
    expect(remote).toHaveTextContent("3 files, remote");
    fireEvent.click(remote);
    expect(onPick).toHaveBeenCalledWith(machineRow);
  });

  it("shows a machine's offline state in place of its count", async () => {
    diffBar({ ...machineRow, files: null, offline: "Offline" });
    openMenu(/^Worktree:/);
    const items = await screen.findAllByRole("menuitem");
    expect(items[1]).toHaveTextContent("Offline");
    expect(items[1]).not.toHaveTextContent("files");
  });

  it("offers Open in Finder and Copy path in ⋯ for a worktree on this Mac", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    diffBar(ctxRow);
    openMenu(/^More for/);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in Finder" }));
    expect(revealPath).toHaveBeenCalledWith("/home/me/code/ctx-demo");
    openMenu(/^More for/);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Copy path" }));
    expect(writeText).toHaveBeenCalledWith("/home/me/code/ctx-demo");
  });

  it("offers only Copy path, on the machine, for a machine's worktree", async () => {
    diffBar(machineRow, [diffTabFace({ key: "diff:source:remote-demo", row: machineRow })]);
    openMenu(/^More for/);
    expect(await screen.findByRole("menuitem", { name: "Copy path · On build-box" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Open in Finder" })).toBeNull();
  });
});
