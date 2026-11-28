// SPDX-License-Identifier: MIT
import { expect, test } from "@playwright/test";
import { mountTileHost } from "./fixtures/tile-host";
import { T1_ACTIONS, T1_LATER_KEYS, T1_TREE } from "./t1-actions";

/**
 * Every gesture of the action table leaves each live body where it was: the host removes and
 * inserts no body or frame (only a step's new key is inserted), no probe loads twice, its
 * in-frame state survives, and it still hears the hub after the step.
 */

test("no gesture in the action table moves a live body @p0", async ({ page }) => {
  test.setTimeout(120_000);
  const host = await mountTileHost(page, T1_TREE, T1_LATER_KEYS);
  const changes = await host.watch();
  const instances = new Map<string, string | null>();
  const record = async () => {
    for (const key of await host.mounted())
      if (!instances.has(key)) instances.set(key, await host.instanceOf(key));
  };
  await record();

  for (const action of T1_ACTIONS) {
    await test.step(action.name, async () => {
      await action.run(host);
      await host.settle();
      const { added, removed } = await changes.take();
      // A body this step adds may swap its first frame while it first loads (the viewer's own
      // start); nothing already shown may lose a node.
      const fresh = new Set(action.adds.map((key) => `frame:${key}`));
      expect(
        removed.filter((node) => !fresh.has(node)),
        `${action.name} removed`,
      ).toEqual([]);
      const expected = action.adds.flatMap((key) => [`body:${key}`, `frame:${key}`]);
      expect([...new Set(added)].sort(), `${action.name} added`).toEqual(expected.sort());

      for (const [key, instance] of instances)
        expect(await host.instanceOf(key), `${key} instance`).toBe(instance);
      await record();
      for (const key of await host.mounted())
        expect(await host.counts(key), `${key} after ${action.name}`).toMatchObject({
          inFrame: 1,
          stored: 1,
        });

      // Each shown body still hears the hub.
      const shown = await host.shown();
      const before = new Map<string, number>();
      for (const key of shown) before.set(key, (await host.counts(key)).deltas.length);
      await host.fire();
      for (const key of shown)
        await expect
          .poll(async () => (await host.counts(key)).deltas.length, { message: key })
          .toBeGreaterThan(before.get(key)!);
    });
  }
});
