// SPDX-License-Identifier: MIT
import { expect, it } from "vitest";
import { createMockBackend } from "./mock-backend";
import { MOCK_ORG_SLUG } from "./fixtures";
import { resolveScenario } from "./scenario";

type AppState = {
  org: { activeOrgSlug: string };
  viewer: { settings?: { openForemanOnStart?: boolean } };
};
const startState = async (search: string) =>
  JSON.parse(
    String(await createMockBackend(resolveScenario(search), search)("load_app_state")),
  ) as AppState;

it.each([
  "?agents=team",
  "?agents=teams",
  "?terminals=demo",
  "?nav=demo",
  "?perf=tiles12",
  "?perf=nav5k",
])(
  "the %s world starts in its own team, without the Foreman landing that opens the docs team over it",
  async (search) => {
    const state = await startState(search);
    expect(state.org.activeOrgSlug).toBe(MOCK_ORG_SLUG);
    expect(state.viewer.settings?.openForemanOnStart).toBe(false);
  },
);

it.each(["", "?scenario=onboarded", "?agents=none"])(
  "the %s world keeps the default start: the Foreman opens",
  async (search) => {
    expect((await startState(search)).viewer.settings?.openForemanOnStart).toBeUndefined();
  },
);
