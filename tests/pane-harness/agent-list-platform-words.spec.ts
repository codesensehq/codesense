// SPDX-License-Identifier: MIT
/** The agent list names the person's keys, and decides locality by machine id, not by label. */
import { expect, test } from "./harness";
import { AGENT_LIST_PANE, agentListFixtures } from "./agent-list-fixtures";

function fixtures() {
  const f = agentListFixtures(3, "teams");
  const [mac, computer, remote] = f.sessions!;
  // A local session has no machine id, whatever its machine is called.
  Object.assign(mac, { machine: "This Mac", machineId: undefined });
  Object.assign(computer, { machine: "This computer", machineId: undefined });
  Object.assign(remote, { machine: "Build box", machineId: "build-box" });
  return f;
}

for (const { platform, quickView, move } of [
  { platform: "MacIntel", quickView: "⌥-click", move: "⌥↑ / ⌥↓" },
  { platform: "Win32", quickView: "Alt+click", move: "Alt+↑ / Alt+↓" },
]) {
  test(`on ${platform}: Quick view and move hints, and machine details only for a remote session`, async ({
    page,
    mountPane,
  }) => {
    await page.addInitScript((value) => {
      Object.defineProperty(Navigator.prototype, "platform", { get: () => value });
    }, platform);
    const pane = await mountPane(AGENT_LIST_PANE, fixtures());
    const main = (id: string) => pane.frame.locator(`[data-agent-id="${id}"] .al-main`);
    for (const id of ["s0", "s1", "s2"])
      await expect(main(id)).toHaveAttribute(
        "title",
        new RegExp(`Q or ${quickView.replace("+", "\\+")} for Quick view · M for inbox`),
      );
    await expect(main("s0")).toHaveAttribute("title", /\nDeveloper · opus/);
    await expect(main("s0")).not.toHaveAttribute("title", /This Mac/);
    await expect(main("s1")).toHaveAttribute("title", /\nDeveloper · opus/);
    await expect(main("s1")).not.toHaveAttribute("title", /This computer/);
    await expect(main("s2")).toHaveAttribute("title", /\nDeveloper · Build box · opus/);
    const head = pane.frame.locator('[data-row-id="workspace:fixture:dev|ws0"] .al-ws-head');
    await expect(head).toHaveAttribute("title", `drag to move, or ${move}`);
  });
}

test("in an app without the calls: Alt hints and the same machine details", async ({
  page,
  mountPane,
}) => {
  // The frame's SDK object loses the shortcut calls the moment the shim assigns it.
  await page.addInitScript(() => {
    if (window.top === window) return;
    Object.defineProperty(window, "codesense", {
      configurable: true,
      get: () => undefined,
      set(sdk: Record<string, unknown>) {
        delete sdk.formatKeys;
        delete sdk.formatModifierClick;
        Object.defineProperty(window, "codesense", {
          value: sdk,
          writable: true,
          configurable: true,
        });
      },
    });
  });
  const pane = await mountPane(AGENT_LIST_PANE, fixtures());
  expect(await pane.frame.evaluate(() => "formatKeys" in (window as any).codesense)).toBe(false);
  const main = pane.frame.locator('[data-agent-id="s0"] .al-main');
  await expect(main).toHaveAttribute("title", /Q or Alt\+click for Quick view · M for inbox/);
  await expect(main).toHaveAttribute("title", /\nDeveloper · opus/);
  const head = pane.frame.locator('[data-row-id="workspace:fixture:dev|ws0"] .al-ws-head');
  await expect(head).toHaveAttribute("title", "drag to move, or Alt+↑ / Alt+↓");
});
