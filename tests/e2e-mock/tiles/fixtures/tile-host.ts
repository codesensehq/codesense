// SPDX-License-Identifier: MIT
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { expect, type Page } from "@playwright/test";
import { probeCounts, watchProbeLoads, writeProbe, type ProbeCounts } from "./probe";

/**
 * The tile host harness (`?harness=tile-host`): the host alone, each tile's body the probe
 * dashboard in a live pane, driven through `window.__tileHost` with the kit's own ops.
 *
 *   const host = await mountTileHost(page, tree, ["ws-a2"]);  // every key that may be shown
 *   await host.call("split", "ws-b", "row", "after", "ws-d");
 *   await host.counts("ws-b");                               // the probe's own counts
 *   const changes = await host.watch();  ...  await changes.take();  // body and frame nodes
 */

export interface SavedLeaf {
  kind: "leaf";
  id: string;
}
export interface SavedSplit {
  kind: "split";
  axis: "row" | "column";
  children: SavedNode[];
  sizes: number[];
}
export type SavedNode = SavedLeaf | SavedSplit;

export const leaf = (id: string): SavedLeaf => ({ kind: "leaf", id });
export const split = (axis: "row" | "column", children: SavedNode[]): SavedSplit => ({
  kind: "split",
  axis,
  children,
  sizes: children.map(() => 100 / children.length),
});

const keysOf = (node: SavedNode): string[] =>
  node.kind === "leaf" ? [node.id] : node.children.flatMap(keysOf);

/** The pane a key's body shows: the harness names it the same way. */
const paneOf = (run: string, key: string) => `${run}-${key.replace(/[^a-z0-9]+/gi, "-")}`;

type Harness = Window & { __tileHost: Record<string, (...args: unknown[]) => unknown> };
type Watched = Window & { __tileChanges?: { added: string[]; removed: string[] } };

/** Body and frame nodes added to or removed from the host, by tile key. */
export interface NodeChanges {
  added: string[];
  removed: string[];
}

/** The valid shared-layer tile refs of `tests/fixtures/leaf-keys.json` with `prefix`. */
export function fixtureRefs(prefix: "agent:" | "doc:"): string[] {
  const path = new URL("../../../fixtures/leaf-keys.json", import.meta.url);
  const { refs } = JSON.parse(fs.readFileSync(path, "utf8")) as {
    refs: Array<{ leaf: string; layer: string; valid: boolean }>;
  };
  return refs
    .filter((r) => r.valid && r.layer === "shared" && r.leaf.startsWith(prefix))
    .map((r) => r.leaf);
}

/**
 * Opens the harness on `tree`, with a probe written for each of its keys and for `later` (keys
 * a step adds), and waits for every shown probe to load once.
 */
export async function mountTileHost(page: Page, tree: SavedNode, later: string[] = []) {
  const run = `t${randomUUID().slice(0, 8)}`;
  const keys = [...new Set([...keysOf(tree), ...later])];
  await watchProbeLoads(page);
  for (const key of keys) await writeProbe(page, "default", paneOf(run, key));
  await page.goto(`/?harness=tile-host&run=${run}`);
  await page.waitForFunction(() => !!(window as unknown as Harness).__tileHost);

  const call = (name: string, ...args: unknown[]) =>
    page.evaluate(
      ([name, args]) => (window as unknown as Harness).__tileHost[name as string](...(args as [])),
      [name, args] as const,
    );
  const body = (key: string) => page.locator(`[data-tile-body="${key}"]`);
  const frameOf = (key: string) => page.locator(`iframe[src*="/${paneOf(run, key)}.html"]`);
  const counts = (key: string): Promise<ProbeCounts> => probeCounts(page, paneOf(run, key));
  const loaded = async (key: string) => {
    await expect(frameOf(key)).toHaveCount(1);
    const selector = `iframe[src*="/${paneOf(run, key)}.html"]`;
    await expect(page.frameLocator(selector).locator("#in-frame")).toHaveText("1", {
      timeout: 15_000,
    });
  };
  /** Keys whose body is on screen now. */
  const shown = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-tile-body][data-tile-shown="true"]')].map(
        (el) => el.dataset.tileBody!,
      ),
    );
  /** Keys whose body is mounted, shown or not. */
  const mounted = () =>
    page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("[data-tile-body]")].map(
        (el) => el.dataset.tileBody!,
      ),
    );
  const instanceOf = (key: string) =>
    body(key).locator("[data-instance]").first().getAttribute("data-instance");

  await call("seed", tree);
  for (const key of keysOf(tree)) await loaded(key);

  return {
    run,
    call,
    body,
    frameOf,
    counts,
    loaded,
    shown,
    mounted,
    instanceOf,
    /** Starts recording body and frame nodes the host adds or removes; `take` drains them. */
    watch: async () => {
      await page.evaluate(() => {
        const changes = { added: [] as string[], removed: [] as string[] };
        (window as Watched).__tileChanges = changes;
        // A removed node has left the page, so its body is read from where it was.
        const keyOf = (node: Node, parent: Node): string[] => {
          if (!(node instanceof Element)) return [];
          const found = [node, ...node.querySelectorAll("[data-tile-body], iframe")].filter(
            (el) => el.matches("[data-tile-body], iframe"),
          );
          const around = (parent as Element).closest?.<HTMLElement>("[data-tile-body]");
          return found.map((el) =>
            el.matches("iframe")
              ? `frame:${(el.closest<HTMLElement>("[data-tile-body]") ?? around)?.dataset.tileBody ?? "?"}`
              : `body:${(el as HTMLElement).dataset.tileBody}`,
          );
        };
        new MutationObserver((records) => {
          for (const record of records) {
            record.addedNodes.forEach((node) => changes.added.push(...keyOf(node, record.target)));
            record.removedNodes.forEach((node) =>
              changes.removed.push(...keyOf(node, record.target)),
            );
          }
        }).observe(document.querySelector("[data-tile-host]")!, { childList: true, subtree: true });
      });
      return {
        take: () =>
          page.evaluate(() => {
            const changes = (window as Watched).__tileChanges!;
            const taken = { added: [...changes.added], removed: [...changes.removed] };
            changes.added.length = 0;
            changes.removed.length = 0;
            return taken as NodeChanges;
          }),
      };
    },
    /** Waits two frames, so React has committed and the observer has run. */
    settle: () =>
      page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      ),
    /** One hub delta, from the mock's live-hub fixture. */
    fire: () =>
      page.evaluate(() =>
        (window as unknown as { __liveHubFixture: { fire: () => number } }).__liveHubFixture.fire(),
      ),
    fireBurst: (n: number) =>
      page.evaluate(
        (n) =>
          (
            window as unknown as { __liveHubFixture: { fireBurst: (n: number) => number } }
          ).__liveHubFixture.fireBurst(n),
        n,
      ),
  };
}

export type TileHostPage = Awaited<ReturnType<typeof mountTileHost>>;
