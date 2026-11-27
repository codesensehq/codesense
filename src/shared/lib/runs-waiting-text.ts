// SPDX-License-Identifier: MIT
/** "1 run waiting" / "3 runs waiting": routine runs that ended needing the person. They
 *  are not the needs-you set (a run that waits has posted an Inbox card, which is). */
export function runsWaitingText(n: number): string {
  return `${n > 99 ? "99+" : n} ${n === 1 ? "run" : "runs"} waiting`;
}
