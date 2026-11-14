// SPDX-License-Identifier: MIT
import { describe, expect, it, vi } from "vitest";

import { agentPageHash, openAgentFullView, teamAgentPage } from "./agent-full-view";

describe("openAgentFullView", () => {
  it("opens the team's declared agent page as a pinned tab, naming the session in the fragment", () => {
    const open = vi.fn();
    openAgentFullView(
      { org: "acme", team: "widgets", handle: "BUG-1#lead", page: "pages/agent.html" },
      open,
    );
    expect(open).toHaveBeenCalledWith(
      { org: "acme", team: "widgets", path: "pages/agent.html" },
      { newTab: true, hash: "#session=BUG-1%23lead" },
    );
  });

  it("encodes a handle so it survives the fragment", () => {
    expect(agentPageHash("a b&c")).toBe("#session=a%20b%26c");
  });
});

describe("teamAgentPage", () => {
  const orgs = [
    {
      slug: "acme",
      teams: [
        { name: "widgets", source_repos: [], agent_page: " pages/agent.html " },
        { name: "plain", source_repos: [] },
        { name: "blank", source_repos: [], agent_page: "  " },
      ],
    },
  ] as never;

  it("reads the page the team declares in teams.yml, trimmed", () => {
    expect(teamAgentPage(orgs, "acme", "widgets")).toBe("pages/agent.html");
  });

  it("is null when the team declares none, declares a blank one, or is unknown", () => {
    expect(teamAgentPage(orgs, "acme", "plain")).toBeNull();
    expect(teamAgentPage(orgs, "acme", "blank")).toBeNull();
    expect(teamAgentPage(orgs, "acme", "nope")).toBeNull();
    expect(teamAgentPage(orgs, "other", "widgets")).toBeNull();
  });
});
