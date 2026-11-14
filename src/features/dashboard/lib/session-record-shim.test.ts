// SPDX-License-Identifier: MIT
import { expect, it, vi } from "vitest";
import { loadShim } from "../../../../tests/support/page-shim";

const nudge = (sessionId?: string) => ({
  type: "codesense:session-record-changed",
  ...(sessionId ? { sessionId } : {}),
});

it("onSessionRecordChanged runs for its own session's nudge and a broad one, not another's", () => {
  const { codesense, deliver } = loadShim();
  const onChanged = codesense.onSessionRecordChanged as (
    cb: () => void,
    ids?: string | string[],
  ) => () => void;
  const mine = vi.fn();
  const everything = vi.fn();
  const off = onChanged(mine, ["tab-1", "native-1"]);
  onChanged(everything);
  deliver(nudge("tab-2"));
  expect(mine).not.toHaveBeenCalled();
  expect(everything).toHaveBeenCalledTimes(1);
  deliver(nudge("native-1"));
  deliver(nudge());
  expect(mine).toHaveBeenCalledTimes(2);
  off();
  deliver(nudge("tab-1"));
  expect(mine).toHaveBeenCalledTimes(2);
});
