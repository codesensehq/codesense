// SPDX-License-Identifier: MIT
// Terminal tabs on this machine's own host, driven by plain invokes in whichever window is
// current, so a spec can tell which viewer a window acts as: each window reads the host's
// layout as its own viewer (its focus, the exited tabs it hides), and a tab's pty size is
// what its shell reports through `stty size`.
import { browser } from "@wdio/globals";
import { invoke } from "./driver";

/** Where a reply's host is, as a session or workspace reference wants it. */
interface MemberTarget {
  member: unknown;
  admissionRevision: unknown;
  namespace: unknown;
}

interface ViewerLayout {
  active: Record<string, string>;
  hidden: string[];
}

interface Tab {
  session: string;
  state: { kind: string };
}

interface Seen {
  target: MemberTarget;
  viewer: ViewerLayout;
  tabs: Tab[];
}

type Reply = MemberTarget & {
  mode: string;
  snapshot?: { workspaces: Record<string, { tabs: Tab[] }>; viewer: ViewerLayout };
};

const BOOT_KEY = "codesense.terminal.clientBootId";

function ok(cmd: string, result: Awaited<ReturnType<typeof invoke>>): unknown {
  if (!result.ok) throw new Error(`${cmd}: ${result.error}`);
  return result.value;
}

/** The current window's launch id, as its terminal layout keeps it: a read under another
 *  would be a relaunch, which prunes the exited tabs the window shows. */
async function bootId(): Promise<string> {
  return await browser.execute((key) => {
    const kept = sessionStorage.getItem(key);
    if (kept) return kept;
    const minted = crypto.randomUUID();
    sessionStorage.setItem(key, minted);
    return minted;
  }, BOOT_KEY);
}

/** Workspace `workspace` as the current window's viewer sees it. */
export async function seen(workspace: string): Promise<Seen> {
  const replies = ok(
    "terminal_layout_snapshot",
    await invoke("terminal_layout_snapshot", { clientBootId: await bootId() }),
  ) as Reply[];
  const reply = replies.find((r) => r.mode === "live" && r.snapshot?.workspaces[workspace]);
  if (!reply?.snapshot) throw new Error(`no live host holds ${workspace}`);
  const { member, admissionRevision, namespace } = reply;
  return {
    target: { member, admissionRevision, namespace },
    viewer: reply.snapshot.viewer,
    tabs: reply.snapshot.workspaces[workspace].tabs,
  };
}

/** Opens a shell tab `session` in `workspace` (created at `cwd` when absent), 80x24. */
export async function openShell(workspace: string, session: string, cwd: string): Promise<void> {
  ok(
    "terminal_open_tab",
    await invoke("terminal_open_tab", {
      request: {
        machineId: "local",
        workspace,
        session,
        descriptor: { displayName: "windows e2e", kind: "root", worktreePath: cwd },
        placement: "tab",
        activate: false,
        spawn: { kind: "warm", targetCwd: cwd, size: { cols: 80, rows: 24 } },
      },
    }),
  );
}

export function sessionRef(target: MemberTarget, session: string) {
  return { ...target, session };
}

export function workspaceRef(target: MemberTarget, workspace: string) {
  return { ...target, workspace };
}

/** Runs `cmd` with `args` in the current window, throwing its refusal. */
export async function call(cmd: string, args: Record<string, unknown>): Promise<unknown> {
  return ok(cmd, await invoke(cmd, args));
}

let asked = 0;

/** `session`'s pty size as its shell reports it now, `"<rows> <cols>"`. */
async function ptySize(session: ReturnType<typeof sessionRef>): Promise<string | null> {
  const nonce = ++asked;
  // The echoed line holds `size-%s=`, never `size-<nonce>=`, so only the output matches.
  await call("write_pty", {
    sessionId: session,
    data: `printf 'size-%s=%s\\n' ${nonce} "$(stty size)"\r`,
  });
  const pattern = new RegExp(`size-${nonce}=(\\d+ \\d+)`);
  let found: string | null = null;
  await browser
    .waitUntil(
      async () => {
        const read = (await call("read_terminal_text", {
          ptyId: session,
          lines: 200,
          mode: "normal",
        })) as { text: string };
        found = pattern.exec(read.text)?.[1] ?? null;
        return found !== null;
      },
      { timeout: 10_000, interval: 200 },
    )
    .catch(() => {});
  return found;
}

/** Waits until `session`'s shell reports `expected` (`"<rows> <cols>"`), asking afresh each time. */
export async function waitForSize(
  session: ReturnType<typeof sessionRef>,
  expected: string,
  why: string,
): Promise<void> {
  let last: string | null = null;
  try {
    await browser.waitUntil(
      async () => {
        last = await ptySize(session);
        return last === expected;
      },
      { timeout: 30_000, interval: 500 },
    );
  } catch {
    throw new Error(`${why}: the shell reported ${last}, not ${expected}`);
  }
}

/** `session`'s size as its shell reports it, once it has answered. */
export async function sizeNow(session: ReturnType<typeof sessionRef>): Promise<string> {
  let size: string | null = null;
  await browser.waitUntil(async () => (size = await ptySize(session)) !== null, {
    timeout: 60_000,
    interval: 500,
    timeoutMsg: "the shell never reported its size",
  });
  return size!;
}
