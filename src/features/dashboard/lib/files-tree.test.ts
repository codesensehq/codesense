// SPDX-License-Identifier: MIT
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/dom";
import { NAV_TEXT_MATCH_CASES } from "../../../../tests/support/fixtures/nav-text-match";
const html = readFileSync("src/features/shell/slots/builtin/files-tree.html", "utf8");
const kit = readFileSync("src-tauri/src/http/routes/dashboard_kit/kit.js", "utf8");
const virtual = readFileSync("src-tauri/src/http/routes/dashboard_kit/virtual-list.js", "utf8");
let teardown: (() => void) | undefined;
// Lets a test answer a topic itself; return `undefined` to fall through to the default rows.
let subscribeHook: ((topic: string, options: any, call: number) => unknown) | null = null;
afterEach(() => {
  subscribeHook = null;
  teardown?.();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});
async function boot(
  inherited = false,
  saved: Record<string, unknown> = {},
  pendingFiles = false,
  rootRows?: any[],
  pagination?: { first: any; page: () => Promise<any> },
  directoryRows?: any[],
  deferFiles = false,
  storyRows: any[] = [],
) {
  document.body.innerHTML = html.slice(html.indexOf("<body>") + 6, html.indexOf("<script>"));
  const folder = {
    id: "/content/folder",
    path: "/content/folder",
    name: "folder",
    kind: "dir",
    root: "/content",
    relativePath: "folder",
  };
  const child = {
    id: inherited ? "/parent/content/folder/a.md" : "/content/folder/a.md",
    path: inherited ? "/parent/content/folder/a.md" : "/content/folder/a.md",
    name: "a.md",
    kind: "file",
    root: "/content",
  };
  let uiChanged: (s: any) => void = () => {};
  let slotChanged: (s: any) => void = () => {};
  let command: (s: any) => void = () => {};
  let resolveFiles!: (snapshot: any) => void;
  const filesSnapshot = deferFiles
    ? new Promise<any>((resolve) => {
        resolveFiles = resolve;
      })
    : null;
  let storiesChanged: (snapshot: any, delta: any) => void = () => {};
  const calls = new Map<string, number>();
  const subscribe = vi.fn(async (topic, options) => {
    const call = (calls.get(topic) || 0) + 1;
    calls.set(topic, call);
    if (topic === "stories") storiesChanged = options.onChange;
    const hooked = subscribeHook?.(topic, options, call);
    if (hooked !== undefined) return hooked;
    if (topic === "ui:file-nav") {
      uiChanged = options.onChange;
      return {
        snapshot: [
          { scope: "team", expanded: [], ...(inherited ? { selected: child.path } : {}), ...saved },
        ],
      };
    }
    if (topic === "stories") return { snapshot: storyRows, rev: 1 };
    if (pendingFiles) return new Promise(() => {});
    if (filesSnapshot) return filesSnapshot;
    if (pagination && !options.dir) return pagination.first;
    return { snapshot: options.dir ? directoryRows || [child] : rootRows || [folder], rev: 1 };
  });
  const cs = {
    subscribe,
    unsubscribe: vi.fn(),
    page: vi.fn(pagination?.page || (async () => ({ snapshot: [] }))),
    setUiState: vi.fn(async (_topic: string, _patch: any) => {}),
    commands: { register: vi.fn(async () => {}) },
    onCommand: (f: any) => {
      command = f;
    },
    onFocusIn: vi.fn(),
    onFlush: vi.fn((_callback: () => Promise<void>) => {}),
    onTeardown: (f: () => void) => {
      teardown = f;
    },
    onSlotContext: (f: any) => {
      slotChanged = f;
    },
    theme: vi.fn(async () => {}),
    ready: vi.fn(),
  };
  (window as any).codesense = cs;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  window.eval(kit);
  window.eval(virtual);
  window.eval(html.slice(html.indexOf("<script>") + 8, html.indexOf("</script>")));
  slotChanged({ team: { org: "acme", team: "child" } });
  if (!deferFiles)
    await waitFor(() =>
      expect(
        document.querySelector(`[data-path="${rootRows?.[0].path || "/content/folder"}"]`),
      ).toBeTruthy(),
    );
  return {
    subscribe,
    unsubscribe: cs.unsubscribe,
    stories: (snapshot: any, delta: any = null) => storiesChanged(snapshot, delta),
    flush: () => cs.onFlush.mock.calls[0][0](),
    writeUi: cs.setUiState,
    ready: cs.ready,
    resolveFiles,
    rebind: () =>
      slotChanged({ team: { org: "acme", team: "other-child" }, currentFile: child.path }),
    collapse: () => command({ id: "collapse-all" }),
    reveal: () => command({ id: "nav.reveal-file", args: { path: child.path } }),
    select: () => uiChanged({ snapshot: [{ selected: child.path }] }),
    slotSelect: () =>
      slotChanged({ team: { org: "acme", team: "child" }, currentFile: child.path }),
  };
}
it("does not report ready until the first Files snapshot has rendered", async () => {
  const pane = await boot(false, {}, false, undefined, undefined, undefined, true);
  await waitFor(() => expect(pane.subscribe).toHaveBeenCalledWith("files", expect.anything()));
  expect(pane.ready).not.toHaveBeenCalled();

  pane.resolveFiles({
    snapshot: [
      {
        id: "/content/folder",
        path: "/content/folder",
        name: "folder",
        kind: "dir",
        root: "/content",
      },
    ],
    rev: 1,
  });
  await waitFor(() => expect(document.querySelector('[data-path="/content/folder"]')).toBeTruthy());
  await waitFor(() => expect(pane.ready).toHaveBeenCalledTimes(1));
});

it("keeps the complete cached listing and scroll while replacement pages arrive", async () => {
  const rows = ["a.md", "z.md"].map((name) => ({
    id: `/content/${name}`,
    path: `/content/${name}`,
    name,
    kind: "file",
    root: "/content",
  }));
  let release!: (page: any) => void;
  const page = vi.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  await boot(
    false,
    {
      listings: { scope: "team", root: "/content", directories: [["", rows]], scrollTop: 24 },
    },
    false,
    rows,
    { first: { snapshot: [rows[0]], rev: 1, cursor: "next" }, page },
  );
  await waitFor(() => expect(page).toHaveBeenCalledOnce());
  expect(document.querySelector('[data-path="/content/z.md"]')).toBeTruthy();
  expect(document.getElementById("tree")!.scrollTop).toBe(24);
  release({ snapshot: [rows[1]], cursor: null });
  await waitFor(() => expect(document.querySelector('[data-path="/content/z.md"]')).toBeTruthy());
  expect(document.getElementById("tree")!.scrollTop).toBe(24);
});
it("subscribes only expanded folders in the kit window and releases folders scrolled away", async () => {
  const folders = Array.from({ length: 40 }, (_, i) => ({
    id: `/content/folder-${i}`,
    path: `/content/folder-${i}`,
    name: `folder-${i}`,
    kind: "dir",
    root: "/content",
  }));
  const pane = await boot(false, { expanded: folders.map((row) => row.id) }, false, folders);
  await waitFor(() =>
    expect(pane.subscribe).toHaveBeenCalledWith(
      "files",
      expect.objectContaining({ dir: folders[0].path }),
    ),
  );
  expect(pane.subscribe).not.toHaveBeenCalledWith(
    "files",
    expect.objectContaining({ dir: folders[39].path }),
  );
  const box = document.getElementById("tree")!;
  box.scrollTop = 24 * 45;
  box.dispatchEvent(new Event("scroll"));
  await waitFor(() =>
    expect(pane.unsubscribe).toHaveBeenCalledWith(
      "files",
      expect.any(Function),
      expect.objectContaining({ dir: folders[0].path }),
    ),
  );
});
it("keeps the listing live when its folder header scrolls away but its children remain visible", async () => {
  const rows = Array.from({ length: 100 }, (_, index) => {
    const name = `file-${String(index).padStart(3, "0")}.md`;
    return {
      id: `/content/folder/${name}`,
      path: `/content/folder/${name}`,
      name,
      kind: "file",
      root: "/content",
    };
  });
  const pane = await boot(
    false,
    { expanded: ["/content/folder"] },
    false,
    undefined,
    undefined,
    rows,
  );
  await waitFor(() =>
    expect(document.querySelector('[data-path="/content/folder/file-000.md"]')).toBeTruthy(),
  );
  const box = document.getElementById("tree")!;
  box.scrollTop = 24 * 40;
  box.dispatchEvent(new Event("scroll"));
  await waitFor(() => expect(document.querySelector('[data-path="/content/folder"]')).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(pane.unsubscribe).not.toHaveBeenCalledWith(
    "files",
    expect.any(Function),
    expect.objectContaining({ dir: "/content/folder" }),
  );
  const changed = {
    ...rows[40],
    id: "/content/folder/file-040-renamed.md",
    path: "/content/folder/file-040-renamed.md",
    name: "file-040-renamed.md",
  };
  const options = pane.subscribe.mock.calls.find(
    ([topic, options]) => topic === "files" && options.dir === "/content/folder",
  )![1];
  options.onChange(
    { snapshot: rows.map((row, index) => (index === 40 ? changed : row)), rev: 2 },
    { upserts: [changed], removes: [rows[40].id] },
  );
  await waitFor(() => expect(document.querySelector(`[data-path="${changed.path}"]`)).toBeTruthy());
});
it("paints persisted listings before live reads resolve, without skeletons", async () => {
  const folder = {
    id: "/content/folder",
    path: "/content/folder",
    name: "folder",
    kind: "dir",
    root: "/content",
  };
  const child = {
    id: "/content/folder/a.md",
    path: "/content/folder/a.md",
    name: "a.md",
    kind: "file",
    root: "/content",
  };
  await boot(
    false,
    {
      expanded: [folder.id],
      listings: {
        scope: "team",
        root: "/content",
        directories: [
          ["", [folder]],
          [folder.path, [child]],
        ],
      },
    },
    true,
  );
  expect(document.querySelector('[data-path="/content/folder/a.md"]')).toBeTruthy();
  expect(document.querySelector(".skeleton")).toBeNull();
});
it("repeats an explicit reveal after the selected file's ancestors were folded", async () => {
  const pane = await boot();
  pane.select();
  await waitFor(() =>
    expect(document.querySelector('[data-path="/content/folder/a.md"]')).toBeTruthy(),
  );
  pane.collapse();
  pane.reveal();
  await waitFor(() =>
    expect(
      document.querySelector('[data-path="/content/folder/a.md"][aria-selected="true"]'),
    ).toBeTruthy(),
  );
});
it("R3 loads unopened ancestors when shared active selection changes", async () => {
  const pane = await boot();
  pane.select();
  await waitFor(() =>
    expect(
      document.querySelector('[data-path="/content/folder/a.md"][aria-selected="true"]'),
    ).toBeTruthy(),
  );
  expect(pane.subscribe).toHaveBeenCalledWith(
    "files",
    expect.objectContaining({ dir: "/content/folder" }),
  );
});
it("R3 loads unopened ancestors when same-team slot selection changes", async () => {
  const pane = await boot();
  pane.slotSelect();
  await waitFor(() =>
    expect(
      document.querySelector('[data-path="/content/folder/a.md"][aria-selected="true"]'),
    ).toBeTruthy(),
  );
});
it("R4 allows folding a selected file's parent and Collapse all", async () => {
  const pane = await boot();
  const parent = document.querySelector<HTMLElement>('[data-path="/content/folder"]')!;
  parent.click();
  await waitFor(() =>
    expect(document.querySelector('[data-path="/content/folder/a.md"]')).toBeTruthy(),
  );
  pane.select();
  document.querySelector<HTMLElement>('[data-path="/content/folder"]')!.click();
  await waitFor(() =>
    expect(
      document.querySelector('[data-path="/content/folder"]')?.getAttribute("aria-expanded"),
    ).toBe("false"),
  );
  expect(document.querySelector('[data-path="/content/folder/a.md"]')).toBeNull();
  document.querySelector<HTMLElement>('[data-path="/content/folder"]')!.click();
  pane.collapse();
  expect(
    document.querySelector('[data-path="/content/folder"]')?.getAttribute("aria-expanded"),
  ).toBe("false");
  expect(document.querySelector('[data-path="/content/folder/a.md"]')).toBeNull();
});

it("R2-1 reveals the same inherited active path after a team rebind", async () => {
  const pane = await boot(true);
  const selected = () =>
    document.querySelector('[data-path="/parent/content/folder/a.md"][aria-selected="true"]');
  await waitFor(() => expect(selected()).toBeTruthy());
  pane.rebind();
  await waitFor(() =>
    expect(
      pane.subscribe.mock.calls.filter(
        ([topic, args]) => topic === "files" && args.dir === "/content/folder",
      ),
    ).toHaveLength(2),
  );
  await waitFor(() => expect(selected()).toBeTruthy());
});

it("persists own rows only and never replays withdrawn inherited rows while fresh gating is pending", async () => {
  const folder = {
    id: "/content/folder",
    path: "/content/folder",
    name: "folder",
    kind: "dir",
    root: "/content",
  };
  const own = {
    id: folder.path + "/own.md",
    path: folder.path + "/own.md",
    name: "own.md",
    kind: "file",
  };
  const withdrawn = {
    id: "/parent/content/folder/SV-1.md",
    path: "/parent/content/folder/SV-1.md",
    name: "SV-1.md",
    kind: "story",
    storyId: "SV-1",
    inheritedFrom: "parent",
  };
  const pane = await boot(false, { expanded: [folder.id] }, false, [folder], undefined, [
    own,
    withdrawn,
  ]);
  await waitFor(() =>
    expect(document.querySelector(`[data-path="${withdrawn.path}"]`)).toBeTruthy(),
  );
  await pane.flush();
  const saved = [...pane.writeUi.mock.calls].reverse().find(([, patch]) => patch.listings)![1];
  expect(saved.listings.directories).toEqual([
    ["", [{ id: folder.id, path: folder.path, name: folder.name, kind: "dir", isDirectory: true }]],
    [folder.path, [own]],
  ]);
  teardown?.();
  // Older saved state can contain inherited metadata. A tightened sharing gate
  // has not answered yet, so even legacy cache must never paint it.
  await boot(
    false,
    {
      expanded: [folder.id],
      ...saved,
      listings: {
        ...saved.listings,
        directories: [
          ["", [folder]],
          [folder.path, [own, withdrawn]],
        ],
      },
    },
    true,
  );
  expect(document.querySelector(`[data-path="${own.path}"]`)).toBeTruthy();
  expect(document.querySelector(`[data-path="${withdrawn.path}"]`)).toBeNull();
});

it.each(["save", "legacy replay"])(
  "normalizes an own folder enriched by the real merged inherited epic on %s",
  async (stage) => {
    // Checked against the real Rust files projection by
    // own_folder_inherited_epic_matches_first_paint_fixture.
    const folder = JSON.parse(
      readFileSync("tests/support/fixtures/files-tree-inherited-epic.json", "utf8"),
    );
    const saved = { listings: { scope: "team", root: "/content", directories: [["", [folder]]] } };
    const pane = await boot(false, stage === "save" ? {} : saved, stage !== "save", [folder]);
    if (stage === "legacy replay") {
      expect(document.querySelector(`[data-path="${folder.path}"]`)?.textContent).toBe("folder");
      expect(document.getElementById("tree")!.textContent).not.toContain("Parent roadmap");
      expect(document.querySelector(".count")).toBeNull();
    } else expect(document.getElementById("tree")!.textContent).toContain("Parent roadmap");
    await pane.flush();
    const patch = [...pane.writeUi.mock.calls].reverse().find(([, patch]) => patch.listings)![1];
    expect(patch.listings.directories[0][1]).toEqual([
      { id: folder.id, path: folder.path, name: folder.name, kind: "dir", isDirectory: true },
    ]);
  },
);

const folderRow = (name: string, extra: Record<string, unknown> = {}) => ({
  id: `/content/${name}`,
  path: `/content/${name}`,
  name,
  kind: "dir",
  root: "/content",
  ...extra,
});
const type = (value: string) => {
  const field = document.getElementById("filter") as HTMLInputElement;
  field.value = value;
  field.dispatchEvent(new Event("input"));
};

it("a story id narrows to the story through the story index while its folder is unlisted", async () => {
  const storyRows = [
    {
      id: "/content/epic-a/deep/story.md",
      path: "/content/epic-a/deep/story.md",
      name: "story.md",
      kind: "story",
      storyId: "DEMO-12",
      title: "Wire the thing",
      ownerPath: "/content/epic-a/deep",
    },
    {
      id: "/content/epic-a/other.md",
      path: "/content/epic-a/other.md",
      name: "other.md",
      kind: "story",
      storyId: "DEMO-13",
      ownerPath: "/content/epic-a",
    },
  ];
  // Listing a folder never resolves, so only the index can answer.
  const pane = await boot(
    false,
    {},
    false,
    [folderRow("epic-a"), folderRow("epic-b")],
    undefined,
    undefined,
    false,
    storyRows,
  );
  await waitFor(() => expect(pane.subscribe).toHaveBeenCalledWith("files", expect.anything()));
  type("DEMO-12");
  await waitFor(() =>
    expect(document.querySelector('[data-path="/content/epic-a/deep/story.md"]')).toBeTruthy(),
  );
  expect(document.querySelector('[data-path="/content/epic-a/deep"]')).toBeTruthy();
  expect(document.querySelector('[data-path="/content/epic-b"]')).toBeNull();
  expect(document.querySelector('[data-path="/content/epic-a/other.md"]')).toBeNull();
  type("");
  await waitFor(() =>
    expect(pane.unsubscribe).toHaveBeenCalledWith("stories", expect.any(Function)),
  );
});

it("only an id-shaped filter subscribes to the story index", async () => {
  const pane = await boot(false, {}, false, [folderRow("epic-a")], undefined, undefined, false, []);
  await waitFor(() => expect(pane.subscribe).toHaveBeenCalledWith("files", expect.anything()));
  const storyReads = () => pane.subscribe.mock.calls.filter(([topic]) => topic === "stories");
  // Each name filters the one folder row out, so the paint that follows has run the gate.
  for (const name of ["meeting", "my-notes", "2024", "-3"]) {
    type(name);
    await waitFor(() => expect(document.querySelector('[data-path="/content/epic-a"]')).toBeNull());
    expect(storyReads()).toHaveLength(0);
  }
  type("DEMO-1");
  await waitFor(() => expect(storyReads()).toHaveLength(1));
});

it("a failed story-index read is retried by the next keystroke", async () => {
  subscribeHook = (topic, _options, call) =>
    topic === "stories" && call === 1 ? Promise.reject(new Error("down")) : undefined;
  const pane = await boot(false, {}, false, [folderRow("epic-a")], undefined, undefined, false, []);
  const storyReads = () => pane.subscribe.mock.calls.filter(([topic]) => topic === "stories");
  type("DEMO-1");
  await waitFor(() => expect(storyReads()).toHaveLength(1));
  type("DEMO-12");
  await waitFor(() => expect(storyReads()).toHaveLength(2));
});

it("a story index whose first paint throws is unsubscribed before it is forgotten", async () => {
  // A null row makes the paint's bucketing throw after the subscription resolved.
  subscribeHook = (topic) => (topic === "stories" ? { snapshot: [null], rev: 1 } : undefined);
  const pane = await boot(false, {}, false, [folderRow("epic-a")], undefined, undefined, false, []);
  const storyUnsubscribes = () =>
    pane.unsubscribe.mock.calls.filter(([topic]) => topic === "stories");
  type("DEMO-12");
  await waitFor(() => expect(storyUnsubscribes()).toHaveLength(1));
});

it("a story index that resolves after the filter was cleared is unsubscribed", async () => {
  let resolveStories!: (snapshot: any) => void;
  subscribeHook = (topic) =>
    topic === "stories"
      ? new Promise((resolve) => {
          resolveStories = resolve;
        })
      : undefined;
  const pane = await boot(false, {}, false, [folderRow("epic-a")], undefined, undefined, false, []);
  const storyUnsubscribes = () =>
    pane.unsubscribe.mock.calls.filter(([topic]) => topic === "stories");
  type("DEMO-12");
  await waitFor(() => expect(pane.subscribe).toHaveBeenCalledWith("stories", expect.anything()));
  type("");
  await waitFor(() => expect(document.querySelector('[data-path="/content/epic-a"]')).toBeTruthy());
  expect(storyUnsubscribes()).toHaveLength(0);
  resolveStories({ snapshot: [], rev: 1 });
  await waitFor(() => expect(storyUnsubscribes()).toHaveLength(1));
});

const indexed = (id: string, path = `/content/epic-a/${id}/story.md`) => ({
  id: path,
  path,
  name: "story.md",
  kind: "story",
  storyId: id,
});
const indexedRow = (id: string) =>
  document.querySelector(`[data-path="/content/epic-a/${id}/story.md"]`);

it("applies live story-index deltas, then reads the new team's index after a team switch", async () => {
  const pane = await boot(false, {}, false, [folderRow("epic-a")], undefined, undefined, false, [
    indexed("DEMO-12"),
  ]);
  type("DEMO-1");
  await waitFor(() => expect(indexedRow("DEMO-12")).toBeTruthy());

  pane.stories(
    { snapshot: [indexed("DEMO-12")], rev: 2 },
    { upserts: [indexed("DEMO-13")], removes: [] },
  );
  await waitFor(() => expect(indexedRow("DEMO-13")).toBeTruthy());
  pane.stories(
    { snapshot: [indexed("DEMO-12"), indexed("DEMO-13")], rev: 3 },
    { upserts: [], removes: [indexed("DEMO-12").id] },
  );
  await waitFor(() => expect(indexedRow("DEMO-12")).toBeNull());
  expect(indexedRow("DEMO-13")).toBeTruthy();

  // A team switch drops that index and reads the new team's while the filter stays.
  subscribeHook = (topic) =>
    topic === "stories" ? { snapshot: [indexed("DEMO-15")], rev: 1 } : undefined;
  pane.rebind();
  await waitFor(() =>
    expect(pane.unsubscribe).toHaveBeenCalledWith("stories", expect.any(Function)),
  );
  await waitFor(() => expect(indexedRow("DEMO-15")).toBeTruthy());
  expect(indexedRow("DEMO-13")).toBeNull();
});

it("a reset snapshot replaces the story index", async () => {
  const pane = await boot(false, {}, false, [folderRow("epic-a")], undefined, undefined, false, [
    indexed("DEMO-12"),
  ]);
  type("DEMO-1");
  await waitFor(() => expect(indexedRow("DEMO-12")).toBeTruthy());
  pane.stories(
    { snapshot: [indexed("DEMO-14")], rev: 1, reset: true },
    { upserts: [], removes: [] },
  );
  await waitFor(() => expect(indexedRow("DEMO-14")).toBeTruthy());
  expect(indexedRow("DEMO-12")).toBeNull();
});

it("a delta that lands before the index snapshot is applied after it", async () => {
  let resolveStories!: (snapshot: any) => void;
  subscribeHook = (topic) =>
    topic === "stories"
      ? new Promise((resolve) => {
          resolveStories = resolve;
        })
      : undefined;
  const pane = await boot(false, {}, false, [folderRow("epic-a")], undefined, undefined, false, []);
  type("DEMO-1");
  await waitFor(() => expect(pane.subscribe).toHaveBeenCalledWith("stories", expect.anything()));
  pane.stories(
    { snapshot: [indexed("DEMO-12"), indexed("DEMO-13")], rev: 2 },
    { upserts: [indexed("DEMO-13")], removes: [] },
  );
  resolveStories({ snapshot: [indexed("DEMO-12")], rev: 1 });
  await waitFor(() => expect(indexedRow("DEMO-13")).toBeTruthy());
  expect(indexedRow("DEMO-12")).toBeTruthy();
});

it("reads each indexed story once per query, not once per folder", async () => {
  let reads = 0;
  const counted = indexed("DEMO-12", "/content/epic-3/DEMO-12/story.md");
  Object.defineProperty(counted, "title", {
    enumerable: true,
    get() {
      reads += 1;
      return "Wire the thing";
    },
  });
  const folders = Array.from({ length: 40 }, (_, i) => folderRow(`epic-${i}`));
  await boot(false, {}, false, folders, undefined, undefined, false, [counted]);
  type("DEMO-12");
  await waitFor(() =>
    expect(document.querySelector('[data-path="/content/epic-3/DEMO-12/story.md"]')).toBeTruthy(),
  );
  expect(reads).toBeGreaterThan(0);
  expect(reads).toBeLessThan(10);
});

it("shows no Loading placeholder beside children the story index supplied", async () => {
  subscribeHook = (topic, options) =>
    topic === "files" && options.dir ? new Promise(() => {}) : undefined;
  await boot(false, {}, false, [folderRow("epic-a")], undefined, undefined, false, [
    indexed("DEMO-12"),
  ]);
  type("DEMO-12");
  await waitFor(() => expect(indexedRow("DEMO-12")).toBeTruthy());
  expect(document.body.textContent).not.toContain("Loading children");
});

it.each(NAV_TEXT_MATCH_CASES)("the pane's filter rule $name", async ({ query, text, matches }) => {
  await boot(false, {}, false, [
    {
      id: `/content/${text}`,
      path: `/content/${text}`,
      name: text,
      kind: "file",
      root: "/content",
    },
  ]);
  type(query);
  await waitFor(() =>
    expect(!!document.querySelector(`[data-path="/content/${text}"]`)).toBe(matches),
  );
});

it("a folder row whose label carries the story id stays when the id is typed", async () => {
  await boot(false, {}, false, [
    folderRow("epic-a", { storyId: "DEMO-7", title: "Epic" }),
    folderRow("epic-b"),
  ]);
  type("DEMO-7");
  await waitFor(() => expect(document.querySelector('[data-path="/content/epic-b"]')).toBeNull());
  expect(document.querySelector('[data-path="/content/epic-a"]')).toBeTruthy();
});

it("typing a story id right after a team switch still narrows the tree", async () => {
  const story = {
    id: "/content/epic-a/story.md",
    path: "/content/epic-a/story.md",
    name: "story.md",
    kind: "file",
    storyId: "DEMO-12",
    root: "/content",
  };
  const pane = await boot(false, {}, false, [folderRow("epic-a"), folderRow("epic-b")], undefined, [
    story,
    {
      ...story,
      id: "/content/epic-a/other.md",
      path: "/content/epic-a/other.md",
      storyId: "DEMO-99",
    },
  ]);
  pane.rebind();
  type("DEMO-12");
  await waitFor(() =>
    expect(document.querySelector('[data-path="/content/epic-a/story.md"]')).toBeTruthy(),
  );
  expect(document.querySelector('[data-path="/content/epic-a/other.md"]')).toBeNull();
  expect(document.querySelectorAll("#filter")).toHaveLength(1);
});
