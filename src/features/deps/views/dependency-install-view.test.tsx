// SPDX-License-Identifier: MIT
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DependencyInstallView } from "./dependency-install-view";
import type { DependencyStatus, GitInstallHint } from "@/tauri/commands";

// ---------- Mocks ----------

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ startDragging: vi.fn() }),
}));

// The rows `git_install_hint` in deps.rs returns for each OS.
const macosHint: GitInstallHint = {
  installer: true,
  install: [{ label: "Prefer a newer git?", commands: ["brew install git"] }],
  upgrade: [{ label: "Prefer a newer git?", commands: ["brew install git"] }],
};

const windowsHint: GitInstallHint = {
  installer: false,
  install: [{ label: "Run", commands: ["winget install --id Git.Git -e --source winget"] }],
  upgrade: [{ label: "Run", commands: ["winget upgrade --id Git.Git -e --source winget"] }],
};

const linuxLines = [
  {
    label: "Ubuntu (Git 2.44 or newer comes from the git-core PPA):",
    commands: ["sudo add-apt-repository ppa:git-core/ppa", "sudo apt install git"],
  },
  { label: "Fedora:", commands: ["sudo dnf install git"] },
];
const linuxHint: GitInstallHint = { installer: false, install: linuxLines, upgrade: linuxLines };

const emptyHint: GitInstallHint = { installer: false, install: [], upgrade: [] };

// codesense no longer installs git — it detects the user's system git. This view
// is a guidance gate offering a Re-check that re-runs detection off the main thread.
let mockRecheckResult: DependencyStatus = {
  git: { available: false, path: null, version: null },
  gitInstall: macosHint,
  gh: { available: false, path: null, version: null, resolving: false },
  agents: {},
};
let mockCltResult: { status: string; message?: string } = { status: "triggered" };

vi.mock("@/tauri/commands", () => ({
  recheckDependencies: vi.fn(() => Promise.resolve(mockRecheckResult)),
  installCommandLineTools: vi.fn(() => Promise.resolve(mockCltResult)),
}));

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: vi.fn(() => Promise.resolve()),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));

// ---------- Helpers ----------

const gitMissing: DependencyStatus = {
  git: { available: false, path: null, version: null },
  gitInstall: macosHint,
  gh: { available: false, path: null, version: null, resolving: false },
  agents: {},
};

const gitBelowFloor: DependencyStatus = {
  git: { available: false, path: "/usr/bin/git", version: "2.39.3" },
  gitInstall: macosHint,
  gh: { available: false, path: null, version: null, resolving: false },
  agents: {},
};

const gitReady: DependencyStatus = {
  git: { available: true, path: "/usr/bin/git", version: "2.51.0" },
  gitInstall: macosHint,
  gh: { available: true, path: "/opt/homebrew/bin/gh", version: "2.50.0", resolving: false },
  agents: {},
};

/** The guidance list items' text, in order. */
function listItems(): string[] {
  return screen.getAllByRole("listitem").map((li) => li.textContent ?? "");
}

/** Off macOS: no installer button and no Apple or brew copy anywhere. */
function expectNoMacOsGuidance() {
  expect(screen.queryByRole("button", { name: /Install Git/ })).not.toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/Apple|brew/);
}

// ---------- Tests ----------

describe("DependencyInstallView (git guidance gate)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecheckResult = { ...gitMissing };
    mockCltResult = { status: "triggered" };
  });

  it("Install Git triggers the Command Line Tools installer and shows a note", async () => {
    const { installCommandLineTools } = await import("@/tauri/commands");
    const user = userEvent.setup();
    render(<DependencyInstallView initialStatus={gitMissing} onComplete={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Install Git/ }));

    await waitFor(() => {
      expect(installCommandLineTools).toHaveBeenCalledOnce();
      expect(screen.getByText(/Apple's installer is opening/)).toBeInTheDocument();
    });
  });

  it("surfaces an error when the installer can't start", async () => {
    const { installCommandLineTools } = await import("@/tauri/commands");
    vi.mocked(installCommandLineTools).mockResolvedValueOnce({
      status: "error",
      message: "boom",
    });
    const user = userEvent.setup();
    render(<DependencyInstallView initialStatus={gitMissing} onComplete={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /Install Git/ }));

    await waitFor(() => expect(screen.getByText("boom")).toBeInTheDocument());
  });

  it("opens the git download page when the link is clicked", async () => {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    const user = userEvent.setup();
    render(<DependencyInstallView initialStatus={gitMissing} onComplete={vi.fn()} />);

    await user.click(screen.getByText("git-scm.com/downloads"));

    expect(openUrl).toHaveBeenCalledWith("https://git-scm.com/downloads");
  });

  it("renders the git-required guidance when git is missing", () => {
    render(<DependencyInstallView initialStatus={gitMissing} onComplete={vi.fn()} />);

    expect(screen.getByText("Git is required")).toBeInTheDocument();
    expect(screen.getByText(/couldn't find Git/)).toBeInTheDocument();
    expect(screen.getByText("Re-check")).toBeInTheDocument();
  });

  it("shows the detected-but-too-old message when git is below the floor", () => {
    render(<DependencyInstallView initialStatus={gitBelowFloor} onComplete={vi.fn()} />);

    expect(screen.getByText(/Found v2\.39\.3/)).toBeInTheDocument();
  });

  // SW-AN-3: Claude is optional — it must never be framed as required here.
  it("never renders any Claude-required framing", () => {
    render(<DependencyInstallView initialStatus={gitMissing} onComplete={vi.fn()} />);

    expect(screen.queryByText(/Claude/)).not.toBeInTheDocument();
  });

  it("completes immediately when git is already available", async () => {
    const onComplete = vi.fn();
    render(<DependencyInstallView initialStatus={gitReady} onComplete={onComplete} />);

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalled();
    });
  });

  it("re-check calls detection and completes once git becomes available", async () => {
    const { recheckDependencies } = await import("@/tauri/commands");
    const onComplete = vi.fn();
    const user = userEvent.setup();
    render(<DependencyInstallView initialStatus={gitMissing} onComplete={onComplete} />);

    // Detection now finds git.
    mockRecheckResult = { ...gitReady };
    await user.click(screen.getByText("Re-check"));

    await waitFor(() => {
      expect(recheckDependencies).toHaveBeenCalledOnce();
      expect(onComplete).toHaveBeenCalled();
    });
  });

  it("stays on the gate when re-check still finds no git", async () => {
    const { recheckDependencies } = await import("@/tauri/commands");
    const onComplete = vi.fn();
    const user = userEvent.setup();
    render(<DependencyInstallView initialStatus={gitMissing} onComplete={onComplete} />);

    await user.click(screen.getByText("Re-check"));

    await waitFor(() => {
      expect(recheckDependencies).toHaveBeenCalledOnce();
    });
    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByText("Git is required")).toBeInTheDocument();
  });

  it("surfaces an error when detection throws", async () => {
    const { recheckDependencies } = await import("@/tauri/commands");
    vi.mocked(recheckDependencies).mockRejectedValueOnce(new Error("probe failed"));
    const user = userEvent.setup();
    render(<DependencyInstallView initialStatus={gitMissing} onComplete={vi.fn()} />);

    await user.click(screen.getByText("Re-check"));

    await waitFor(() => {
      expect(screen.getByText(/probe failed/)).toBeInTheDocument();
    });
  });

  it("SW-FU-C1: a failure is the shared inline alert, the actions shared buttons", async () => {
    const { recheckDependencies } = await import("@/tauri/commands");
    vi.mocked(recheckDependencies).mockRejectedValueOnce(
      new Error("unavailable: the login shell timed out"),
    );
    const user = userEvent.setup();
    render(<DependencyInstallView initialStatus={gitMissing} onComplete={vi.fn()} />);
    expect(screen.getByRole("button", { name: /Install Git/ })).toHaveAttribute(
      "data-variant",
      "default",
    );
    expect(screen.getByRole("button", { name: /Re-check/ })).toHaveAttribute(
      "data-variant",
      "outline",
    );
    await user.click(screen.getByText("Re-check"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveAttribute("data-slot", "inline-alert");
    expect(alert).toHaveTextContent("Couldn't check for Git");
    expect(alert).toHaveTextContent("the login shell timed out");
    expect(alert).not.toHaveTextContent("unavailable:");
  });
});

describe("DependencyInstallView (per-OS install hints)", () => {
  it("macOS keeps the installer item, the brew line and the Install Git button", () => {
    render(<DependencyInstallView initialStatus={gitMissing} onComplete={vi.fn()} />);

    expect(screen.getByText("Install Git, then re-check. The quickest way:")).toBeInTheDocument();
    expect(listItems()).toEqual([
      "Click Install Git below — it opens Apple's Command Line Tools installer.",
      "Prefer a newer git? brew install git",
      "Or download from git-scm.com/downloads",
    ]);
    expect(screen.getByRole("button", { name: /Install Git/ })).toBeInTheDocument();
  });

  it("Windows with git missing names the winget install line", () => {
    const status: DependencyStatus = { ...gitMissing, gitInstall: windowsHint };
    render(<DependencyInstallView initialStatus={status} onComplete={vi.fn()} />);

    expect(screen.getByText("Install Git, then re-check. The quickest way:")).toBeInTheDocument();
    expect(listItems()).toEqual([
      "Run winget install --id Git.Git -e --source winget",
      "Or download from git-scm.com/downloads",
    ]);
    expectNoMacOsGuidance();
  });

  it("Windows with git below the floor names the winget upgrade line", () => {
    const status: DependencyStatus = { ...gitBelowFloor, gitInstall: windowsHint };
    render(<DependencyInstallView initialStatus={status} onComplete={vi.fn()} />);

    expect(listItems()).toEqual([
      "Run winget upgrade --id Git.Git -e --source winget",
      "Or download from git-scm.com/downloads",
    ]);
    expectNoMacOsGuidance();
  });

  it("Linux names the Ubuntu PPA and Fedora lines", () => {
    const status: DependencyStatus = { ...gitMissing, gitInstall: linuxHint };
    render(<DependencyInstallView initialStatus={status} onComplete={vi.fn()} />);

    expect(listItems()).toEqual([
      "Ubuntu (Git 2.44 or newer comes from the git-core PPA): sudo add-apt-repository ppa:git-core/ppa then sudo apt install git",
      "Fedora: sudo dnf install git",
      "Or download from git-scm.com/downloads",
    ]);
    expectNoMacOsGuidance();
  });

  it("an empty row offers the git-scm download only", () => {
    const status: DependencyStatus = { ...gitMissing, gitInstall: emptyHint };
    render(<DependencyInstallView initialStatus={status} onComplete={vi.fn()} />);

    expect(screen.getByText("Install Git, then re-check.")).toBeInTheDocument();
    expect(listItems()).toEqual(["Download from git-scm.com/downloads"]);
    expectNoMacOsGuidance();
  });

  it("a status without a row offers the git-scm download only", () => {
    const status: DependencyStatus = {
      git: { available: false, path: null, version: null },
      gh: { available: false, path: null, version: null, resolving: false },
      agents: {},
    };
    render(<DependencyInstallView initialStatus={status} onComplete={vi.fn()} />);

    expect(screen.getByText("Install Git, then re-check.")).toBeInTheDocument();
    expect(listItems()).toEqual(["Download from git-scm.com/downloads"]);
    expectNoMacOsGuidance();
  });
});
