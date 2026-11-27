// SPDX-License-Identifier: MIT
import { Profiler } from "react";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders as render } from "../../../../tests/support/helpers/render-with-providers";
import {
  holdStatusLine,
  postStatusLine,
  releaseStatusLine,
  resetStatusLineForTests,
  STATUS_LINE_MS,
} from "@/shared/stores/status-line-store";
import { TitleBar } from "./title-bar";

/**
 * Posting, expiring, hovering, focusing and holding a line re-render the status line only: the
 * rest of the title bar, its doc tabs and its CLI controls render 0 times. With nothing posted
 * the bar renders as it did before the status line existed.
 */

const renders = vi.hoisted(() => ({ titleBar: 0, viewerTabs: 0, cliChrome: 0, notice: 0 }));
const mode = vi.hoisted(() => ({ console: false }));

vi.mock("@/shared/lib/team-key", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/team-key")>()),
  useActiveTeamKey: () => "acme:web",
}));
vi.mock("@/shared/hooks/use-active-workspace-context", () => ({
  useActiveWorkspaceContext: () => ({
    workspace: { id: "w1", kind: "root" },
    repoPath: "/r",
  }),
}));
vi.mock("@/shared/hooks/use-team-pipeline-repo-path", () => ({
  useTeamPipelineRepoPath: () => "/r",
}));
// Counts the title bar's own renders: it reads this hook once per render.
vi.mock("@/shared/hooks/use-is-console", () => ({
  useIsConsole: () => {
    renders.titleBar += 1;
    return mode.console;
  },
}));
vi.mock("@/features/viewer/components/viewer-tabs", () => ({
  ViewerTabs: () => {
    renders.viewerTabs += 1;
    return <div data-testid="stub-viewer-tabs" />;
  },
}));
vi.mock("@/features/viewer/components/cli-bottom-chrome", () => ({
  CliBottomChrome: () => {
    renders.cliChrome += 1;
    return <div data-testid="stub-cli-chrome" />;
  },
}));
vi.mock("@/features/machines/components/terminal-servers-notice", () => ({
  TerminalServersTitleBarNotice: () => {
    renders.notice += 1;
    return <div data-testid="stub-servers-notice" />;
  },
}));
vi.mock("@/features/shell/components/identity-menu", () => ({
  IdentityMenu: () => <div data-testid="stub-identity-menu" />,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn() }),
}));

function resetCounts() {
  for (const k of Object.keys(renders) as (keyof typeof renders)[]) renders[k] = 0;
}

beforeEach(() => {
  vi.useFakeTimers();
  resetStatusLineForTests();
  mode.console = false;
});

afterEach(() => {
  cleanup();
  resetStatusLineForTests();
  vi.useRealTimers();
});

describe.each([
  ["doc tabs", false, "viewerTabs"],
  ["console", true, "cliChrome"],
] as const)("in the %s layout", (_, isConsole, sibling) => {
  it("re-renders the status line only", () => {
    mode.console = isConsole;
    let commits = 0;
    render(
      <Profiler id="title-bar" onRender={() => (commits += 1)}>
        <TitleBar />
      </Profiler>,
    );
    expect(renders[sibling]).toBeGreaterThan(0);
    resetCounts();
    commits = 0;

    act(
      () =>
        void postStatusLine({
          text: "design opened critique-log.html",
          kind: "offer",
          action: { label: "Show", run: vi.fn() },
        }),
    );
    const slot = screen.getByTestId("status-line");
    // It sits in the right cluster, before the CLI controls and the servers notice.
    const cluster = slot.parentElement!;
    expect(cluster.firstElementChild).toBe(slot);
    fireEvent.pointerEnter(slot);
    fireEvent.pointerLeave(slot);
    act(() => screen.getByRole("button", { name: "Show" }).focus());
    act(() => (document.activeElement as HTMLElement).blur());
    act(() => holdStatusLine());
    act(() => releaseStatusLine());
    act(() => vi.advanceTimersByTime(STATUS_LINE_MS));
    expect(screen.queryByTestId("status-line")).toBeNull();

    expect(commits).toBeGreaterThan(0);
    expect(renders).toEqual({ titleBar: 0, viewerTabs: 0, cliChrome: 0, notice: 0 });
  });
});
