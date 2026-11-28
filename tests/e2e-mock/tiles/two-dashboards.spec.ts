// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";

import { hostLoads, probeCounts, watchProbeLoads, writeProbe } from "./fixtures/probe";
import { leaf, split, type SavedNode } from "./fixtures/tile-host";

/**
 * Two dashboards side by side in the app itself, with tiles on (`?tiles=on`): the team view's
 * layout holds two dashboard tiles, the tile host mount draws each in its tab frame, and each
 * frame loads once however the layout around it changes.
 */

// The mock's first team, the one the app opens on and whose panes `/__mock-panes/` serves.
const ORG = "codesense/docs";
const TEAM = "getting-started";
const TEAM_KEY = `${ORG}:${TEAM}`;
// The mock's other team, in another org.
const OTHER_ORG = "acme/widgets";
const OTHER_TEAM = "default";
const dashboardKey = (id: string) => `dashboard:team:${ORG}:${TEAM}/${id}`;

type GroupsWindow = Window & {
  __mockGroups: { write: (teamKey: string, root: unknown) => Promise<void> };
};

/** Makes the window hold `teamKey`'s layout, so it watches the team's layout file. */
async function holdLayout(page: Page, teamKey: string) {
  await page.evaluate(
    (teamKey) => window.__stores!.useViewerStore.getState().setForegroundPreset(teamKey, "columns"),
    teamKey,
  );
  // Every layout save from the window has landed, so none lands on top of a later write.
  await page.evaluate(async () => {
    const client = "/src/shared/stores/layout-store-client.ts";
    await (await import(/* @vite-ignore */ client)).flushGroupCommits();
  });
}

/** Writes `root` to the team's layout file as another writer (an agent) would. */
const writeLayout = (page: Page, teamKey: string, root: SavedNode) =>
  page.evaluate(
    ([teamKey, root]) => (window as unknown as GroupsWindow).__mockGroups.write(teamKey, root),
    [teamKey, root] as const,
  );

const setActiveTeam = (page: Page, org: string, team: string) =>
  page.evaluate(
    ([org, team]) => {
      const store = window.__stores!.useOrgStore.getState();
      store.setActiveOrg(org);
      store.setActiveTeam(team);
    },
    [org, team] as const,
  );

const activeTeamKey = (page: Page) =>
  page.evaluate(() => {
    const { activeOrgSlug, activeTeamName } = window.__stores?.useOrgStore.getState() ?? {};
    return `${activeOrgSlug}:${activeTeamName}`;
  });

const frameSelector = (id: string) => `iframe[src*="/${id}.html"]`;

async function rectOf(page: Page, id: string) {
  const box = await page.locator(frameSelector(id)).boundingBox();
  expect(box, id).not.toBeNull();
  return box!;
}

/** Each probe shows in one frame that has loaded once, as the host page counted too. */
async function loadedOnce(page: Page, ids: string[]) {
  for (const id of ids) {
    await expect(page.locator(frameSelector(id))).toHaveCount(1);
    await expect(page.frameLocator(frameSelector(id)).locator("#in-frame")).toHaveText("1");
    const { key, inFrame } = await probeCounts(page, id);
    expect(inFrame, id).toBe(1);
    expect(await hostLoads(page, key), id).toBe(1);
  }
}

test("two dashboards side by side each load once through a split, a resize and a team change @p0", async ({
  page,
}) => {
  const run = randomUUID().slice(0, 8);
  const [a, b, c] = ["a", "b", "c"].map((n) => `board-${run}-${n}`);
  await watchProbeLoads(page);
  for (const id of [a, b, c]) await writeProbe(page, TEAM, id);
  await page.goto("/?tiles=on");
  await expect.poll(() => activeTeamKey(page)).toBe(TEAM_KEY);
  await holdLayout(page, TEAM_KEY);

  // Side by side.
  const pair = split("row", [leaf(dashboardKey(a)), leaf(dashboardKey(b))]);
  await writeLayout(page, TEAM_KEY, pair);
  await loadedOnce(page, [a, b]);
  const [a0, b0] = [await rectOf(page, a), await rectOf(page, b)];
  expect(b0.x).toBeGreaterThan(a0.x);

  // A split: b's tile splits into b over a third dashboard.
  const splitTree = split("row", [
    leaf(dashboardKey(a)),
    split("column", [leaf(dashboardKey(b)), leaf(dashboardKey(c))]),
  ]);
  await writeLayout(page, TEAM_KEY, splitTree);
  await loadedOnce(page, [a, b, c]);
  await expect.poll(async () => (await rectOf(page, b)).height).toBeLessThan(b0.height * 0.75);

  // A resize: a takes 30% of the row.
  await writeLayout(page, TEAM_KEY, { ...splitTree, sizes: [30, 70] });
  await expect.poll(async () => (await rectOf(page, a)).width).toBeLessThan(a0.width * 0.75);
  await loadedOnce(page, [a, b, c]);

  // A team change that keeps the layout: the other team already holds the same tree.
  const other = `${OTHER_ORG}:${OTHER_TEAM}`;
  await holdLayout(page, other);
  await writeLayout(page, other, { ...splitTree, sizes: [30, 70] });
  await expect
    .poll(() =>
      page.evaluate(
        ([key, team]) =>
          JSON.stringify(
            window.__stores!.useViewerStore.getState().foregroundLayout[team]?.root,
          )?.includes(key) ?? false,
        [dashboardKey(c), other] as const,
      ),
    )
    .toBe(true);
  const rects = await Promise.all([a, b, c].map((id) => rectOf(page, id)));
  await setActiveTeam(page, OTHER_ORG, OTHER_TEAM);
  await expect.poll(() => activeTeamKey(page)).toBe(other);
  await loadedOnce(page, [a, b, c]);
  expect(await Promise.all([a, b, c].map((id) => rectOf(page, id)))).toEqual(rects);
});
