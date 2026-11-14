// SPDX-License-Identifier: MIT
import { StatusMark } from "@/shared/components/status-mark";

/** The unread mark on the Foreman's reopen entries: mail waits and no Foreman is live. The
 *  entry's own label says so; the mark is decoration. */
export function ForemanMailDot({ testId }: { testId: string }) {
  return <StatusMark data-testid={testId} mark="question" size="sm" />;
}
