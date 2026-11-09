// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useViewerStore } from "./viewer-store";
import { useOrgStore } from "@/shared/stores/org-store";
import { createNote, deleteNote, updateNoteMeta } from "@/tauri/commands";

// The backend side: each org's notes on disk.
type DiskNote = { title: string; body: string; pinned: boolean; lastOpenedAt: number };
type Scope = { orgSlug: string | null };
const disk = vi.hoisted(() => ({ orgs: new Map<string, Map<string, DiskNote>>(), created: 0 }));

vi.mock("@/tauri/commands", () => {
  const notesOf = (scope: Scope) => disk.orgs.get(scope.orgSlug ?? "")!;
  const meta = (notes: Map<string, DiskNote>, id: string) => {
    const { title, pinned, lastOpenedAt } = notes.get(id)!;
    return { id, title, pinned, lastOpenedAt };
  };
  return {
    listNotes: vi.fn(async (scope: Scope) => {
      const notes = notesOf(scope);
      return [...notes.keys()].map((id) => meta(notes, id));
    }),
    readNote: vi.fn(async (scope: Scope, id: string) => {
      const notes = notesOf(scope);
      return { ...meta(notes, id), content: notes.get(id)!.body };
    }),
    writeNote: vi.fn(async (scope: Scope, id: string, content: string) => {
      notesOf(scope).get(id)!.body = content;
      return content;
    }),
    createNote: vi.fn(async (scope: Scope, title: string, options: { content?: string }) => {
      const notes = notesOf(scope);
      const id = `new-${++disk.created}`;
      notes.set(id, { title, body: options.content ?? "", pinned: false, lastOpenedAt: 99 });
      return { ...meta(notes, id), content: notes.get(id)!.body };
    }),
    deleteNote: vi.fn(async () => []),
    updateNoteMeta: vi.fn(
      async (scope: Scope, id: string, patch: { title?: string; pinned?: boolean }) => {
        const notes = notesOf(scope);
        if (patch.title !== undefined) notes.get(id)!.title = patch.title;
        if (patch.pinned !== undefined) notes.get(id)!.pinned = patch.pinned;
        return meta(notes, id);
      },
    ),
    saveAppState: vi.fn(async () => undefined),
    loadAppState: vi.fn(async () => "{}"),
    pushViewerState: vi.fn(async () => undefined),
  };
});

const store = () => useViewerStore.getState();
const note = (over: Partial<DiskNote> = {}): DiskNote => ({
  title: "Untitled",
  body: "",
  pinned: false,
  lastOpenedAt: 1,
  ...over,
});

/** Opens `open` (the most recent note) among `others` in org acme/ctx. */
async function load(open: DiskNote, others: Record<string, DiskNote> = {}) {
  disk.orgs = new Map([
    ["acme/ctx", new Map([["open", { ...open, lastOpenedAt: 50 }], ...Object.entries(others)])],
    ["acme/other", new Map([["elsewhere", note({ title: "Elsewhere" })]])],
  ]);
  disk.created = 0;
  useOrgStore.setState({ activeOrgSlug: "acme/ctx" });
  useViewerStore.setState({
    notes: [],
    activeNoteId: null,
    scratchNoteContent: "",
    notesLoadedScope: null,
    rightPaneOpen: true,
  });
  await store().loadNotes();
  expect(store().activeNoteId).toBe("open");
}

beforeEach(() => vi.clearAllMocks());

describe("New note reuses a blank note", () => {
  it("stays on the open note when it is blank and creates nothing", async () => {
    await load(note({ title: "Note" }), { other: note({ title: "Plan", body: "milk" }) });
    expect(await store().createNote()).toBe("open");
    expect(createNote).not.toHaveBeenCalled();
    expect(store().activeNoteId).toBe("open");
  });

  it("creates a note when the only blank note is not the open one", async () => {
    await load(note({ title: "Plan", body: "milk" }), { older: note({ lastOpenedAt: 5 }) });
    expect(await store().createNote()).toBe("new-1");
    expect(createNote).toHaveBeenCalledOnce();
    expect(store().activeNoteId).toBe("new-1");
    expect(disk.orgs.get("acme/ctx")!.has("older")).toBe(true);
  });

  it.each<[string, () => Promise<void>]>([
    ["a title", () => store().renameNote("open", "Groceries")],
    ["a pin", () => store().setNotePinned("open", true)],
  ])("creates a note when %s for the open note is still being saved", async (_what, save) => {
    await load(note());
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const real = vi.mocked(updateNoteMeta).getMockImplementation()!;
    vi.mocked(updateNoteMeta).mockImplementationOnce(async (...args) => {
      await held;
      return real(...args);
    });
    const saving = save();
    expect(await store().createNote()).toBe("new-1");
    release();
    await saving;
    expect(createNote).toHaveBeenCalledOnce();
  });

  it("makes one note when blank New notes overlap", async () => {
    await load(note({ title: "Plan", body: "milk" }));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const real = vi.mocked(createNote).getMockImplementation()!;
    vi.mocked(createNote).mockImplementationOnce(async (...args) => {
      await held;
      return real(...args);
    });
    const first = store().createNote();
    const second = store().createNote();
    release();
    expect(await Promise.all([first, second])).toEqual(["new-1", "new-1"]);
    expect(createNote).toHaveBeenCalledOnce();
    expect([...disk.orgs.get("acme/ctx")!.keys()]).toEqual(["open", "new-1"]);
  });

  it.each<[string, DiskNote]>([
    ["named", note({ title: "Groceries" })],
    ["pinned", note({ pinned: true })],
    ["with content", note({ body: "milk" })],
    ["whitespace around content", note({ body: "  milk \n" })],
  ])("never reuses a %s note", async (_kind, kept) => {
    await load(kept, { other: note({ title: "Plan", body: "plan", lastOpenedAt: 5 }) });
    const id = await store().createNote();
    expect(createNote).toHaveBeenCalledOnce();
    expect(id).toBe("new-1");
    expect(store().activeNoteId).toBe("new-1");
  });

  it("reuses a whitespace-only note", async () => {
    await load(note({ body: "  \n\t " }));
    expect(await store().createNote()).toBe("open");
    expect(createNote).not.toHaveBeenCalled();
  });

  it("creates a note when the open blank note was just typed in", async () => {
    await load(note());
    store().setScratchNoteContent("milk");
    expect(await store().createNote()).toBe("new-1");
    expect(disk.orgs.get("acme/ctx")!.get("open")!.body).toBe("milk");
  });

  it("creates a titled or seeded note even when a blank note exists", async () => {
    await load(note());
    expect(await store().createNote("Note about a story")).toBe("new-1");
    expect(await store().createNote(undefined, "[A story](cs:story:example)\n")).toBe("new-2");
    expect(createNote).toHaveBeenCalledTimes(2);
  });

  it("never joins a blank New note still being made in another org", async () => {
    await load(note({ title: "Plan", body: "milk" }));
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const real = vi.mocked(createNote).getMockImplementation()!;
    vi.mocked(createNote).mockImplementationOnce(async (...args) => {
      await held;
      return real(...args);
    });
    const first = store().createNote();
    useOrgStore.setState({ activeOrgSlug: "acme/other" });
    await store().loadNotes();
    const second = await store().createNote();
    release();
    await first;
    expect(createNote).toHaveBeenCalledTimes(2);
    expect(disk.orgs.get("acme/other")!.has(second)).toBe(true);
  });
});

describe("title and pin writes", () => {
  const shown = () => store().notes.find((m) => m.id === "open")!;

  it.each<[string, () => Promise<void>, () => unknown, unknown]>([
    ["title", () => store().renameNote("open", "Groceries"), () => shown().title, "Plan"],
    ["pin", () => store().setNotePinned("open", true), () => shown().pinned, false],
  ])("a failed %s write puts the old value back", async (_field, write, value, old) => {
    await load(note({ title: "Plan", body: "milk" }));
    vi.mocked(updateNoteMeta).mockRejectedValueOnce(new Error("disk full"));
    await write();
    expect(value()).toBe(old);
  });

  it("an older write that settles late neither applies nor rolls back", async () => {
    await load(note({ title: "Plan", body: "milk" }));
    let fail!: (e: Error) => void;
    vi.mocked(updateNoteMeta).mockImplementationOnce(
      () => new Promise((_resolve, reject) => (fail = reject)),
    );
    const older = store().renameNote("open", "Groceries");
    await store().renameNote("open", "Errands");
    fail(new Error("disk full"));
    await older;
    expect(shown().title).toBe("Errands");

    let settle!: () => void;
    const held = new Promise<void>((resolve) => (settle = resolve));
    const real = vi.mocked(updateNoteMeta).getMockImplementation()!;
    vi.mocked(updateNoteMeta).mockImplementationOnce(async (...args) => {
      await held;
      return real(...args);
    });
    const late = store().renameNote("open", "Groceries");
    await store().renameNote("open", "Chores");
    settle();
    await late;
    expect(shown().title).toBe("Chores");
  });
});

describe("no navigation deletes a blank note", () => {
  it.each<[string, () => unknown]>([
    ["picking another note", () => store().setActiveNote("other")],
    ["closing the notes pane", () => store().toggleRightPane()],
    [
      "changing org",
      () => {
        useOrgStore.setState({ activeOrgSlug: "acme/other" });
        return store().loadNotes();
      },
    ],
    ["reloading the notes", () => store().loadNotes()],
  ])("%s", async (_how, act) => {
    await load(note(), { other: note({ title: "Plan", body: "milk", lastOpenedAt: 5 }) });
    await act();
    expect(deleteNote).not.toHaveBeenCalled();
    expect(disk.orgs.get("acme/ctx")!.has("open")).toBe(true);
  });
});
