// SPDX-License-Identifier: MIT
// The mock's needs-you rows follow the host's rules where the sample day cannot show them:
// which ended agents stay, and how a long question is cut.
import { describe, expect, it } from "vitest";
import type { HubSnapshot } from "@/features/dashboard/lib/live-hub";
import { SAMPLE_DAY } from "../sample-day";
import type { SampleDay, SampleDayAgent } from "../sample-day";
import type { HandlerRegistry } from "../mock-router";
import { needsYouHandlers } from "./needs-you";

const fallback = {} as HandlerRegistry;

function topic(day: SampleDay): HubSnapshot["snapshot"] {
  const view = needsYouHandlers(fallback, day).live_hub_subscribe({
    topic: "needsYou",
    viewKey: "all",
  }) as HubSnapshot;
  return view.snapshot;
}

function ended(session: string, signals: SampleDayAgent["signals"], capped = false) {
  const base = SAMPLE_DAY.agents.find((agent) => agent.state === "ended")!;
  return { ...base, session, handle: session, signals, capped };
}

describe("the mock's needs-you rows", () => {
  it("keeps an ended agent only while it is marked failed or crashed, asking nothing else", () => {
    const day: SampleDay = {
      ...SAMPLE_DAY,
      inbox: [],
      agents: [
        ended("tab-failed", { needsYouKind: "failed", question: null }, true),
        ended("tab-crashed", { needsYouKind: "crashed", question: null }),
        ended("tab-asked", { needsYouKind: "question", question: "Which branch?" }),
        ended("tab-permission", { needsYouKind: "permission", question: null }),
        ended("tab-capped", { needsYouKind: null, question: null }, true),
      ],
    };
    expect(topic(day).map((row) => row.id)).toEqual([
      "agent:tab-crashed:failed",
      "agent:tab-failed:failed",
    ]);
  });

  it("cuts a long question at 199 code points, as the host counts chars", () => {
    const card = SAMPLE_DAY.inbox.find((c) => c.messageId === 9102)!;
    const long = "😀".repeat(250);
    const day: SampleDay = { ...SAMPLE_DAY, agents: [], inbox: [{ ...card, summary: long }] };
    const question = String(topic(day)[0]!.question);
    expect(Array.from(question)).toHaveLength(200);
    expect(question).toBe(`${"😀".repeat(199)}…`);
  });
});
