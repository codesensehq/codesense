// SPDX-License-Identifier: MIT
/**
 * The 14:02 sample day: one frozen moment shared by cargo, Vitest and the mock backend
 * (`tests/fixtures/sample-day-1402.json`). Counts any surface shows for it come from the one
 * needs-you set and the agent rows below; a test reads this file and never edits its counts.
 */
import sampleDay from "../../../tests/fixtures/sample-day-1402.json";

export type SampleDayTeam = { org: string; team: string; name: string };

export type SampleDayWorkItem = {
  id: string;
  org: string;
  /** `null` for a cross-team lead, such as the Foreman. */
  team: string | null;
  leadAgent: string;
  leadSession: string;
  sprintId: string | null;
  contextWorktree: string | null;
};

export type SampleDayAgent = {
  session: string;
  handle: string;
  name: string;
  agent: string | null;
  org: string;
  team: string | null;
  /** The launcher's handle, `routine:<org>/<team>/<id>`, or `null` when a person launched it. */
  launchedBy: string | null;
  workItem: string | null;
  /** Registered agents appear in the list arrangements; hand-started ones never do. */
  registered: boolean;
  startedByYou?: boolean;
  shell?: boolean;
  state: "busy" | "idle" | "ended";
  doing: string | null;
  worktree: string | null;
  spendToday: number;
  signals: { needsYouKind: string | null; question: string | null };
  capped: boolean;
  capUsd?: number;
};

export type SampleDayCard = {
  messageId: number;
  from: string;
  fromName: string;
  to: string;
  org: string;
  team: string;
  kind: "needs-you" | "update";
  summary: string;
  text: string;
  createdAtMs: number;
  read: boolean;
  answered: boolean;
};

export type SampleDayNeedsYouItem = {
  id: string;
  kind: "question" | "permission" | "merge" | "capped" | "failed";
  session: string;
  question?: string;
};

export type SampleDay = {
  about: string;
  nowMs: number;
  org: string;
  teams: SampleDayTeam[];
  workItems: SampleDayWorkItem[];
  agents: SampleDayAgent[];
  inbox: SampleDayCard[];
  permissionAsks: { session: string; tool: string; text: string }[];
  strip: { key: string; kind: string; name: string; worktree?: string }[];
  leadChanges: { lead: string; branches: { worktree: string; files: number }[] };
  expect: {
    needsYou: SampleDayNeedsYouItem[];
    listStatus: { needsYou: number; busy: number; idle: number; endedToday: number };
    inboxNeedsYou: number;
    unreadByAgent: Record<string, number>;
    leadChangedFiles: number;
    spendToday: number;
  };
};

export const SAMPLE_DAY = sampleDay as SampleDay;
