// SPDX-License-Identifier: MIT
import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderWithProviders as render } from "../../../../tests/support/helpers/render-with-providers";
import { TitleBar } from "./title-bar";
import { restorePlatform, setPlatform } from "@/test/platform";

/**
 * With nothing posted the title bar renders as it did before the status line existed: no status
 * line and no live-region text. The snapshot was taken before the status line's first edit to
 * the title bar.
 */

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
vi.mock("@/shared/hooks/use-is-console", () => ({ useIsConsole: () => mode.console }));
vi.mock("@/features/viewer/components/viewer-tabs", () => ({
  ViewerTabs: () => <div data-testid="stub-viewer-tabs" />,
}));
vi.mock("@/features/viewer/components/cli-bottom-chrome", () => ({
  CliBottomChrome: () => <div data-testid="stub-cli-chrome" />,
}));
vi.mock("@/features/machines/components/terminal-servers-notice", () => ({
  TerminalServersTitleBarNotice: () => <div data-testid="stub-servers-notice" />,
}));
vi.mock("@/features/shell/components/identity-menu", () => ({
  IdentityMenu: () => <div data-testid="stub-identity-menu" />,
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn() }),
}));

beforeEach(() => {
  mode.console = false;
  setPlatform("MacIntel");
});

afterEach(() => {
  cleanup();
  restorePlatform();
});

describe.each([
  ["doc tabs", false],
  ["console", true],
] as const)("the title bar with nothing posted, in the %s layout", (_, isConsole) => {
  it("renders as at the base, with no status line and no live-region text", () => {
    mode.console = isConsole;
    const { container } = render(<TitleBar />);
    expect(container.firstElementChild).toMatchSnapshot();
    expect(screen.queryByTestId("status-line")).toBeNull();
    for (const region of document.querySelectorAll('[role="status"]'))
      expect(region).toHaveTextContent("");
  });
});
