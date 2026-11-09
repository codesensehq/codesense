// SPDX-License-Identifier: MIT
import { expect, test } from "../pane-harness/harness";
import { AGENT_LIST_PANE, agentListFixtures } from "../pane-harness/agent-list-fixtures";

test("the dock pane receives team changes without reminting", async ({ mountPane }) => {
  const pane = await mountPane(AGENT_LIST_PANE, agentListFixtures(5));
  await expect(pane.frame.locator("button").first()).toBeVisible();
  const mints = await pane.page.evaluate(() => (window as any).mints);
  await pane.frame.evaluate(() => {
    (window as any).slotContexts = [];
    window.codesense.onSlotContext((context) => (window as any).slotContexts.push(context));
  });
  await pane.setTeam("fixture", "ops");
  await expect
    .poll(() => pane.frame.evaluate(() => (window as any).slotContexts.at(-1)?.team?.team))
    .toBe("ops");
  expect(await pane.page.evaluate(() => (window as any).mints)).toBe(mints);
});

const PANE = "codesense-docs/getting-started/panes/explain-this-surface.html";
for (const [file, explanation] of [
  ["inbox-flows.html", /inbox-flows\.html/i],
  ["notes.md", /markdown doc/i],
  ["diagram.excalidraw", /Excalidraw canvas/i],
] as const) {
  test(`the docs pane explains the host's selected ${file}`, async ({ mountPane }) => {
    const pane = await mountPane(PANE, {
      activeTab: { "fixture:dev": `/fixture/${file}` },
    });
    await expect(pane.frame.locator(".pane__why")).toContainText(explanation);
  });
}

test("the docs pane keeps its rendered view across maximize and focus context pushes", async ({
  mountPane,
}) => {
  const pane = await mountPane(PANE, {
    activeTab: { "fixture:dev": "/fixture/notes.md" },
  });
  await pane.frame.waitForLoadState("load");
  const why = pane.frame.locator(".pane__why");
  const kept = pane.frame.locator("#pane-body [data-kept]");
  await expect(why).toContainText("notes.md");
  // A marker inside the rendered body disappears if the pane re-renders.
  await pane.frame.evaluate(() => {
    const marker = document.createElement("span");
    marker.dataset.kept = "";
    document.querySelector("#pane-body")!.append(marker);
  });
  // Enter the pane through the host's focus path, then focus a control in it.
  const focusIns = async () =>
    (await pane.probe()).messages.filter((type) => type === "codesense:focus-in").length;
  expect(await focusIns()).toBe(0);
  await pane.page.locator("#terminal").focus();
  await pane.focus();
  await expect.poll(focusIns).toBe(1);
  // Where focus lands is the pane's choice (this pane has no onFocusIn), so only delivery is asserted.
  // Moving between controls inside the entered pane is not another hand-off.
  await pane.frame.locator(".pane__collapse").focus();
  await pane.page.waitForTimeout(300);
  expect(await focusIns()).toBe(1);
  await pane.maximize(true);
  await expect(pane.page.getByTestId("overlay-strip")).toBeVisible();
  // Allow the host's slot-context push and the pane's animation frames to render.
  await pane.page.waitForTimeout(600);
  await expect(kept).toHaveCount(1);
  await pane.maximize(false);
  // Move focus to a different control so the host sends a focus context push.
  await pane.frame.locator(".pane__ctas button").first().focus();
  await pane.page.waitForTimeout(600);
  await expect(kept).toHaveCount(1);
  // A different selected document with the same basename still reapplies context.
  await pane.page.evaluate(() => {
    (window as any).viewer.setState({ activeTab: { "fixture:dev": "/fixture/other/notes.md" } });
  });
  await expect(kept).toHaveCount(0);
});
