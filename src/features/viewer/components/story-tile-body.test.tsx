// SPDX-License-Identifier: MIT
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { DerivedPipelineTree } from "@/shared/lib/pipeline-graph/types";
import { useOrgStore } from "@/shared/stores/org-store";

import { publishTeamTree, useTeamSurfaceStore } from "../lib/team-surface-store";
import { StoryTileBody } from "./story-tile-body";

const page = vi.hoisted(() => ({ props: null as any }));
vi.mock("@/features/dashboard/components/story-aware-markdown", () => ({
  StoryAwareMarkdown: (p: any) => {
    page.props = p;
    return <div data-testid="story-page" />;
  },
}));
vi.mock("@/shared/lib/pipeline-graph/resolve-story-file-path", () => ({
  storyFilePathFromTree: (tree: any, id: string) => tree.files[id] ?? null,
}));

const tree = (files: Record<string, string>) => ({ files }) as unknown as DerivedPipelineTree;
const context = { visible: true, reportLoading: vi.fn() };
const ORG_ROOT = "/home/me/code/acme";

beforeEach(() => {
  page.props = null;
  context.reportLoading.mockClear();
  useTeamSurfaceStore.setState({ trees: {} });
  useOrgStore.setState({ activeOrgSlug: "acme", activeTeamName: "alpha" });
});

describe("StoryTileBody", () => {
  it("opens the story's file as the team's story page", () => {
    publishTeamTree("acme:alpha", tree({ "DEMO-63": `${ORG_ROOT}/alpha/content/stories/demo.md` }));
    render(<StoryTileBody tileKey="story-page:DEMO-63" context={context} orgRoot={ORG_ROOT} />);
    expect(page.props.hostTeamKey).toBe("acme:alpha");
    expect(page.props.filePath).toBe(`${ORG_ROOT}/alpha/content/stories/demo.md`);
    expect(page.props.teamContentPath).toBe(`${ORG_ROOT}/alpha/content`);
  });

  it("reads the story workspace's team, not the team on screen", () => {
    publishTeamTree("acme:alpha", tree({}));
    publishTeamTree("acme:beta", tree({ "DEMO-63": `${ORG_ROOT}/beta/content/demo.md` }));
    render(
      <StoryTileBody
        tileKey="story-page:DEMO-63"
        context={context}
        orgRoot={ORG_ROOT}
        storyTeam={{ org: "acme", team: "beta" }}
      />,
    );
    expect(page.props.hostTeamKey).toBe("acme:beta");
  });

  it("waits for the team's tree, then says when the story isn't there", () => {
    render(<StoryTileBody tileKey="story-page:DEMO-64" context={context} orgRoot={ORG_ROOT} />);
    expect(context.reportLoading).toHaveBeenLastCalledWith(true);
    act(() => publishTeamTree("acme:alpha", tree({})));
    expect(context.reportLoading).toHaveBeenLastCalledWith(false);
    expect(screen.getByRole("status")).toHaveTextContent("DEMO-64 isn't in alpha's stories.");
    expect(page.props).toBeNull();
  });
});
