// SPDX-License-Identifier: MIT
// The driver itself: `main` opens a satellite, the spec drives it, then closes it.
import { browser, expect } from "@wdio/globals";
import { freshId, invoke, MAIN, open, seed } from "./lib/driver";
import {
  call,
  openShell,
  seen,
  sessionRef,
  sizeNow,
  waitForSize,
  workspaceRef,
} from "./lib/terminal";

describe("two windows", () => {
  before(async () => {
    await seed();
  });

  it("opens a registered satellite, drives it and closes it", async () => {
    const id = freshId("smoke");
    const label = await open({ id });
    expect(label).toBe(`pane-${id}`);
    expect(await browser.getWindowHandle()).toBe(label);

    // Driven in the satellite: it reads its own registry entry, which `e2e_open_window`
    // created before the window, with no items and no Layout.
    const own = await invoke("window_get_slice", { label });
    expect(own).toMatchObject({
      ok: true,
      value: { label, kind: "satellite", items: [], layoutRef: null },
    });

    await browser.closeWindow();
    await browser.switchToWindow(MAIN);
    await browser.waitUntil(async () => !(await browser.getWindowHandles()).includes(label), {
      timeoutMsg: `${label} still has a window handle after its close`,
    });
    expect(await browser.getWindowHandles()).toContain(MAIN);
  });

  it("seeds the same probe twice", async () => {
    const first = await seed();
    expect(await seed()).toEqual(first);
  });

  // #462's QA trace proves these parts of one terminal viewer per window only from the source
  // text or with the window's viewer passed in directly; each row here drives one from a real
  // satellite. `main` opens shell tabs A and B and sizes A 80x24 as the most recently active
  // viewer; the satellite then acts on them as its own viewer.
  describe("one terminal viewer per window", () => {
    const workspace = `root:windows-e2e/${freshId("ws")}`;
    const [a, b] = [freshId("tab-a"), freshId("tab-b")];
    let label = "";
    let target: Awaited<ReturnType<typeof seen>>["target"];
    let mainSize = "";
    const streams: number[] = [];
    const ref = (session: string) => sessionRef(target, session);

    before(async () => {
      await browser.switchToWindow(MAIN);
      const cwd = process.env.HOME!;
      await openShell(workspace, a, cwd);
      await openShell(workspace, b, cwd);
      ({ target } = await seen(workspace));
      await call("resize_pty", { sessionId: ref(a), cols: 80, rows: 24 });
      await call("terminal_set_active", {
        workspace: workspaceRef(target, workspace),
        session: ref(a),
      });
      mainSize = await sizeNow(ref(a));
      label = await open({ id: freshId("viewer") });
      // The satellite's first read of the layout makes it a viewer with a launch of its own.
      await seen(workspace);
    });

    after(async () => {
      if ((await browser.getWindowHandles()).includes(label)) {
        await browser.switchToWindow(label);
        for (const streamId of streams) await invoke("unsubscribe_terminal", { streamId });
        await browser.closeWindow();
      }
      await browser.switchToWindow(MAIN);
      for (const session of [a, b]) {
        await invoke("terminal_close_tab", { session: ref(session), mode: "kill" });
      }
    });

    it("#462 AC 3 gap: resize_pty from a satellite sizes as its own viewer", async () => {
      await browser.switchToWindow(label);
      // The satellite subscribes as a real one would before it sizes. That the subscription is
      // its own viewport, and leaves main's stream alone, is not asserted: a spec sees no stream
      // without an output channel.
      const subscribed = (await call("subscribe_terminal", { ptyId: ref(a) })) as {
        streamId: number;
      };
      streams.push(subscribed.streamId);
      await call("resize_pty", { sessionId: ref(a), cols: 101, rows: 31 });
      // A second viewer's size waits until it is the most recently active; as `main`'s, the
      // request would have resized A at once.
      expect(await sizeNow(ref(a))).toBe(mainSize);
    });

    it("#462 AC 3 gap: terminal_set_active from a satellite makes it the size owner and leaves main's focus alone", async () => {
      await browser.switchToWindow(label);
      await call("terminal_set_active", {
        workspace: workspaceRef(target, workspace),
        session: ref(b),
      });
      await waitForSize(ref(a), "31 101", "after the satellite became the active viewer");
      expect((await seen(workspace)).viewer.active[workspace]).toBe(b);
      await browser.switchToWindow(MAIN);
      expect((await seen(workspace)).viewer.active[workspace]).toBe(a);
    });

    it("#462 AC 3 gap: terminal_close_tab from a satellite closes as its own viewer", async () => {
      await browser.switchToWindow(MAIN);
      await call("write_pty", { sessionId: ref(b), data: "exit\r" });
      await browser.waitUntil(
        async () =>
          (await seen(workspace)).tabs.find((t) => t.session === b)?.state.kind === "exited",
        { timeout: 30_000, timeoutMsg: "tab B's shell never exited" },
      );
      await browser.switchToWindow(label);
      expect(await call("terminal_close_tab", { session: ref(b), mode: "kill" })).toBe("removed");
      expect((await seen(workspace)).viewer.hidden).toContain(b);
      await browser.switchToWindow(MAIN);
      const main = await seen(workspace);
      expect(main.viewer.hidden).not.toContain(b);
      expect(main.tabs.map((t) => t.session)).toContain(b);
    });

    it("#462 AC 2 gap: closing the satellite hands the size back to main through its Destroyed path", async () => {
      await browser.switchToWindow(label);
      await browser.closeWindow();
      await browser.switchToWindow(MAIN);
      await waitForSize(ref(a), mainSize, "after the satellite closed");
    });

    // Not drivable by one app on one Linux host; each stays pending until a job can.
    it(
      "#462 AC 3 gap: a remote attach from a satellite uses its own viewer, and window-less callers use main's (needs a second machine; owner: the move-between-windows follow-up)",
    );
    it(
      "#462 AC 2 gap: after a crash with no Destroyed, the next launch's sweep detaches the viewer (needs the app killed and relaunched against the same host; owner: the crash-safe window persistence follow-up)",
    );
    it(
      "#462 AC 2 gap: two installs on one host keep each other's viewers (needs a second install; owner: the crash-safe window persistence follow-up)",
    );
  });
});
