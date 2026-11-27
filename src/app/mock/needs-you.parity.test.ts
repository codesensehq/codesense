// SPDX-License-Identifier: MIT
// needs-you parity: every TS surface that counts or lists what needs the person equals the
// one needs-you set, narrowed by its place, on the 14:02 sample day.
//
// The split by runtime: the mock backend serves the `needsYou` topic from
// `tests/fixtures/sample-day-1402.json`, and this harness checks the TS surfaces against it.
// The Rust surfaces (`codesense_overview` and the Inbox counts row's `needsYouBySender`)
// are proven equal to the same set in cargo (`live_hub/needs_you_tests.rs`). The routines
// count measures runs, not the set, so it is in neither.
//
// To add a surface: append a row to `SURFACES` with its name and a `read(place)` that
// renders or calls the surface over the mock backend and returns the needs-you ids it
// shows for that place. A surface that shows only a count returns ids anyway, from the
// rows it counts, so the parity is on the items and not only their number. A surface on
// the Rust side gets its row in `needs_you_tests.rs` instead.
import { describe, expect, it } from "vitest";
import { createMockBackend } from "./mock-backend";
import { resolveScenario } from "./scenario";
import { SAMPLE_DAY } from "./sample-day";
import type { HubSnapshot } from "@/features/dashboard/lib/live-hub";

/** A place a surface is narrowed to: every team, or one team's view. */
type Place = "all" | `team:${string}/${string}`;

const PLACES: Place[] = [
  "all",
  ...SAMPLE_DAY.teams.map((team) => `team:${team.org}/${team.team}` as Place),
];

const invoke = createMockBackend(resolveScenario(""), "");

async function topicIds(place: Place): Promise<string[]> {
  const view = (await invoke("live_hub_subscribe", {
    topic: "needsYou",
    viewKey: place,
  })) as HubSnapshot;
  return view.snapshot.map((row) => row.id).sort();
}

/** The set narrowed by place, from the fixture's expectations. */
function expected(place: Place): string[] {
  const teams = new Map(SAMPLE_DAY.agents.map((agent) => [agent.session, agent]));
  return SAMPLE_DAY.expect.needsYou
    .filter((item) => {
      if (place === "all") return true;
      const agent = teams.get(item.session);
      return agent?.team != null && place === `team:${agent.org}/${agent.team}`;
    })
    .map((item) => item.id)
    .sort();
}

const SURFACES: { name: string; read: (place: Place) => Promise<string[]> }[] = [
  { name: "the needsYou topic", read: topicIds },
];

describe("needs-you parity on the 14:02 sample day", () => {
  it("holds four items in all, four in Delivery and none in Steward or Quick fix", () => {
    expect(PLACES.map((place) => [place, expected(place).length])).toEqual([
      ["all", 4],
      ["team:acme/delivery", 4],
      ["team:acme/steward", 0],
      ["team:acme/quick-fix", 0],
    ]);
  });

  for (const surface of SURFACES)
    for (const place of PLACES)
      it(`${surface.name} equals the set in ${place}`, async () => {
        expect(await surface.read(place)).toEqual(expected(place));
      });

  it("places each topic row by its session's team and work item", async () => {
    const view = (await invoke("live_hub_subscribe", {
      topic: "needsYou",
      viewKey: "all",
    })) as HubSnapshot;
    const question = view.snapshot.find((row) => row.id === "inbox:9102");
    expect(question).toMatchObject({
      kind: "question",
      org: "acme",
      team: "delivery",
      workItem: "wi_00000000000000a1",
      question: "pins per window or per group?",
      messageId: 9102,
    });
  });
});
