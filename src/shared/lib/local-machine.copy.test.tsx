// SPDX-License-Identifier: MIT
/**
 * A sample of the copy that names the local machine, on each platform: "This
 * computer" off macOS, and the macOS wording unchanged on macOS. The guard keeps
 * every other site on the helper.
 */
import { afterEach, describe, expect, it } from "vitest";

import { render, screen } from "@/test-utils";
import { usageNotRecorded } from "@/features/agents/components/spend-cap";
import { machineWords } from "@/features/agents/lib/agent-routines";
import { NotesEmpty } from "@/features/notes/components/notes-empty";
import { EditorStatusBar } from "@/features/viewer/components/worktree-editor/editor-status-bar";
import { restorePlatform, setPlatform } from "@/test/platform";

afterEach(restorePlatform);

describe.each([
  ["MacIntel", "This Mac", "this Mac", "Mac"],
  ["Win32", "This computer", "this computer", "computer"],
  ["Linux x86_64", "This computer", "this computer", "computer"],
])("local machine copy on %s", (platform, label, phrase, noun) => {
  it("names the machine in labels, sentences and the bare noun", () => {
    setPlatform(platform);
    expect(machineWords(undefined, new Map())).toBe(`on ${label}`);
    expect(machineWords(undefined, new Map(), "each_mac")).toBe(`on each teammate's ${noun}`);
    expect(usageNotRecorded()).toMatch(new RegExp(`^usage not recorded: ${phrase}'s managed`));
  });

  it("names it in the notes empty state and the editor status bar", () => {
    setPlatform(platform);
    render(<NotesEmpty orgName="acme" onNew={() => {}} onRoutine={() => {}} />);
    expect(screen.getByText(new RegExp(`kept on ${phrase}, with history`))).toBeInTheDocument();
    render(
      <EditorStatusBar
        location="local"
        machineLabel={null}
        branch={null}
        status={null}
        wrap={false}
        onToggleWrap={() => {}}
        onGoToLine={() => {}}
      />,
    );
    const where = screen.getByTestId("worktree-status-location");
    expect(where).toHaveAttribute("aria-label", `On ${phrase}`);
    expect(where).toHaveTextContent(label);
  });
});
