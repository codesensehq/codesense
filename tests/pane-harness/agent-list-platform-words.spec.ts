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
