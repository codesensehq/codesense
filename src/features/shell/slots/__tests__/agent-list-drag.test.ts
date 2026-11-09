// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { stepSlot } from "@/features/viewer/lib/workspace-order";
import expected from "../__fixtures__/agent-list-card-math.json";

const html = readFileSync("src/features/shell/slots/__fixtures__/agent-list-pane.html", "utf8");
const source = html.match(/<script id="al-card-math">([\s\S]*?)<\/script>/)?.[1];
const context = { window: {} as any };
if (source) runInNewContext(source, context);
const math = context.window.agentListCardMath;
const rows = [
  { kind: "heading", height: 26 },
  { kind: "team", team: "a", height: 30 },
  { kind: "workspace", workspace: "one", height: 34 },
  { kind: "agent", height: 92 },
  { kind: "workspace", workspace: "", height: 34 },
  { kind: "agent", height: 52 },
  { kind: "workspace", workspace: "no-pill", height: 34 },
  { kind: "workspace", workspace: "two", height: 34 },
  { kind: "agent", height: 5000 },
  { kind: "workspace", workspace: "three", height: 34 },
  { kind: "team", team: "b", height: 30 },
  { kind: "workspace", workspace: "other", height: 34 },
];
// The pane's card math must answer as the native agents pane it replaced did. Those answers are
// frozen in the fixture: per order and card, one character per sampled point (an index into
// `values`), plus the card slots and the keyboard steps.
const CARD_MOVE_REFUSED = {
  filtered: "Cards can't move while a search or filter is on. Clear them to move it.",
  byStatus: "Cards move in the By team arrangement. Switch to it to move this one.",
  noPill: "This card has no pill in the tray, so it has no place in the order to move.",
  nowhere: "This card has no other card in its team to move past.",
};
const DIGITS = "0123456789abcdefghijklmnopqrstuvwxyz";
type Case = { drops: string; cards: unknown; up: unknown; down: unknown };
const cases = expected.cases as Record<string, Case>;
describe("pane card math at native parity", () => {
  it("provides the pane math", () => expect(math).toBeDefined());
  it("uses native refusal words", () => expect(math.CARD_MOVE_REFUSED).toEqual(CARD_MOVE_REFUSED));
  for (const order of [["one", "two", "three"], ["one", "three"], ["one"], []]) {
    it(`matches every boundary, midpoint and horizontal slack for ${order}`, () => {
      const boxes = math.boxes(rows);
      const ys = boxes.flatMap((b: any) => [
        b.start - 25,
        b.start - 8,
        b.start,
        (b.start + b.end) / 2,
        b.end,
        b.end + 24,
      ]);
      for (const id of ["one", "two", "three", "no-pill"]) {
        const want = cases[`${order.join(",")}|${id}`]!;
        const drops = ys.flatMap((y: number) =>
          [-49, -48, 118, 284, 285].map((x) =>
            math.cardDropTarget(rows, boxes, "a", id, y, order, { x, left: 0, right: 236 }),
          ),
        );
        expect(drops).toEqual([...want.drops].map((c) => expected.values[DIGITS.indexOf(c)]));
        const cards = math.teamSlotCards(rows, "a", order);
        expect(cards).toEqual(want.cards);
        expect(math.stepSlot(cards, id, "up")).toEqual(want.up);
        expect(math.stepSlot(cards, id, "down")).toEqual(want.down);
        for (const dir of ["up", "down"] as const)
          expect(math.stepSlot(cards, id, dir)).toEqual(stepSlot(cards, id, dir));
      }
    });
  }
});
