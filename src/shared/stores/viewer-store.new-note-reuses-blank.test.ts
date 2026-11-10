// SPDX-License-Identifier: MIT
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useViewerStore } from "./viewer-store";
import { useOrgStore } from "@/shared/stores/org-store";
import {
  createNote,
  deleteNote,
  listNotes,
  readNote,
  updateNoteMeta,
  writeNote,
} from "@/tauri/commands";

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

  it("starts a current creation after selecting another note instead of joining stale navigation", async () => {
    await load(note({ title: "Plan", body: "milk" }), {
      other: note({ title: "Work", body: "tasks" }),
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const real = vi.mocked(createNote).getMockImplementation()!;
    vi.mocked(createNote).mockImplementationOnce(async (...args) => {
      await held;
      return real(...args);
    });
    const first = store().createNote();
    await vi.waitFor(() => expect(createNote).toHaveBeenCalledOnce());
    await store().setActiveNote("other");
    const latest = await store().createNote();
    expect(store().activeNoteId).toBe(latest);
    release();
    expect(await first).not.toBe(latest);
    expect(store().activeNoteId).toBe(latest);
    expect(createNote).toHaveBeenCalledTimes(2);
  });

  it.each(["title", "pin"] as const)(
    "keeps a pending %s when an actual reload installs after its body read",
    async (field) => {
      for (const exit of ["ordinary", "typed", "superseded"] as const) {
        await load(note(), { other: note() });
        let releaseRead!: () => void;
        let releaseMeta!: () => void;
        const readGate = new Promise<void>((resolve) => (releaseRead = resolve));
        const metaGate = new Promise<void>((resolve) => (releaseMeta = resolve));
        const read = vi.mocked(readNote).getMockImplementation()!;
        let reading = false;
        vi.mocked(readNote).mockImplementationOnce(async (...args) => {
          const result = await read(...args);
          reading = true;
          await readGate;
          return result;
        });
        const loading = store().loadNotes();
        await vi.waitFor(() => expect(reading).toBe(true));
        if (exit === "typed") store().setScratchNoteContent(" ");
        if (exit === "superseded") await store().setActiveNote("other");
        const id = store().activeNoteId!;
        const update = vi.mocked(updateNoteMeta).getMockImplementation()!;
        vi.mocked(updateNoteMeta).mockImplementationOnce(async (...args) => {
          await metaGate;
          return update(...args);
        });
        const saving =
          field === "title" ? store().renameNote(id, "Plans") : store().setNotePinned(id, true);
        releaseRead();
        await loading;
        expect(store().activeNoteId).toBe(id);
        expect(store().notes.find((row) => row.id === id)).toMatchObject(
          field === "title" ? { title: "Plans" } : { pinned: true },
        );
        if (exit === "typed") expect(store().scratchNoteContent).toBe(" ");
        expect(await store().createNote()).toBe("new-1");
        releaseMeta();
        await saving;
        expect(disk.orgs.get("acme/ctx")!.get(id)).toMatchObject(
          field === "title" ? { title: "Plans" } : { pinned: true },
        );
        vi.clearAllMocks();
      }
    },
  );

  it.each(["title", "pin"] as const)(
    "keeps a completed %s save when an older reload finishes afterward",
    async (field) => {
      for (const exit of ["ordinary", "typed", "superseded"] as const) {
        await load(note(), { other: note() });
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        const read = vi.mocked(readNote).getMockImplementation()!;
        let reading = false;
        vi.mocked(readNote).mockImplementationOnce(async (...args) => {
          const result = await read(...args);
          reading = true;
          await held;
          return result;
        });
        const loading = store().loadNotes();
        await vi.waitFor(() => expect(reading).toBe(true));
        if (exit === "typed") store().setScratchNoteContent(" ");
        if (exit === "superseded") await store().setActiveNote("other");
        const id = store().activeNoteId!;
        if (field === "title") await store().renameNote(id, "Plans");
        else await store().setNotePinned(id, true);
        // Deliver the successful save's real projection path before the old read.
        store().applyNotesProjection(
          store().notesLoadedScope!,
          [...disk.orgs.get("acme/ctx")!].map(([id, n]) => ({
            id,
            title: n.title,
            fields: { title: n.title, pinned: n.pinned },
          })),
          { upserts: [], kind: "write" },
        );
        release();
        await loading;
        expect(store().activeNoteId).toBe(id);
        expect(store().notes.find((row) => row.id === id)).toMatchObject(
          field === "title" ? { title: "Plans" } : { pinned: true },
        );
        if (exit === "typed") expect(store().scratchNoteContent).toBe(" ");
        expect(await store().createNote()).toBe("new-1");
        expect(disk.orgs.get("acme/ctx")!.get(id)).toMatchObject(
          field === "title" ? { title: "Plans" } : { pinned: true },
        );
        vi.clearAllMocks();
      }
    },
  );

  it.each(["title", "pin"] as const)(
    "reconciles a %s change across a nonactive note's delete response",
    async (field) => {
      for (const completed of [false, true]) {
        await load(note(), { other: note({ title: "Work" }) });
        let releaseDelete!: () => void;
        let releaseMeta!: () => void;
        const deleteGate = new Promise<void>((resolve) => (releaseDelete = resolve));
        const metaGate = new Promise<void>((resolve) => (releaseMeta = resolve));
        let deleted = false;
        vi.mocked(deleteNote).mockImplementationOnce(async (scope, id) => {
          disk.orgs.get(scope.orgSlug ?? "")!.delete(id);
          const captured = await listNotes(scope);
          deleted = true;
          await deleteGate;
          return captured;
        });
        const deleting = store().deleteNote("other");
        await vi.waitFor(() => expect(deleted).toBe(true));
        const update = vi.mocked(updateNoteMeta).getMockImplementation()!;
        vi.mocked(updateNoteMeta).mockImplementationOnce(async (...args) => {
          await metaGate;
          return update(...args);
        });
        const saving =
          field === "title"
            ? store().renameNote("open", "Plans")
            : store().setNotePinned("open", true);
        if (completed) {
          releaseMeta();
          await saving;
        }
        releaseDelete();
        await deleting;
        expect(store().activeNoteId).toBe("open");
        expect(store().notes.map((row) => row.id)).toEqual(["open"]);
        expect(store().notes[0]).toMatchObject(
          field === "title" ? { title: "Plans" } : { pinned: true },
        );
        expect(await store().createNote()).toBe("new-1");
        if (!completed) {
          releaseMeta();
          await saving;
        }
        expect(disk.orgs.get("acme/ctx")!.get("open")).toMatchObject(
          field === "title" ? { title: "Plans" } : { pinned: true },
        );
        vi.clearAllMocks();
      }
    },
  );

  it.each(["title", "pin"] as const)(
    "keeps a %s save already pending when reload or deletion starts",
    async (field) => {
      for (const operation of ["reload", "delete"] as const) {
        await load(note(), { other: note({ title: "Work" }) });
        let releaseMeta!: () => void;
        let releaseSnapshot!: () => void;
        const metaGate = new Promise<void>((resolve) => (releaseMeta = resolve));
        const snapshotGate = new Promise<void>((resolve) => (releaseSnapshot = resolve));
        const update = vi.mocked(updateNoteMeta).getMockImplementation()!;
        vi.mocked(updateNoteMeta).mockImplementationOnce(async (...args) => {
          await metaGate;
          return update(...args);
        });
        const saving =
          field === "title"
            ? store().renameNote("open", "Plans")
            : store().setNotePinned("open", true);
        let captured = false;
        if (operation === "reload") {
          const read = vi.mocked(readNote).getMockImplementation()!;
          vi.mocked(readNote).mockImplementationOnce(async (...args) => {
            const result = await read(...args);
            captured = true;
            await snapshotGate;
            return result;
          });
        } else {
          vi.mocked(deleteNote).mockImplementationOnce(async (scope, id) => {
            disk.orgs.get(scope.orgSlug ?? "")!.delete(id);
            const rows = await listNotes(scope);
            captured = true;
            await snapshotGate;
            return rows;
          });
        }
        const loading = operation === "reload" ? store().loadNotes() : store().deleteNote("other");
        await vi.waitFor(() => expect(captured).toBe(true));
        releaseMeta();
        await saving;
        releaseSnapshot();
        await loading;
        expect(store().notes.find((row) => row.id === "open")).toMatchObject(
          field === "title" ? { title: "Plans" } : { pinned: true },
        );
        expect(await store().createNote()).toBe("new-1");
        vi.clearAllMocks();
      }
    },
  );

  it("adopts fresh agent metadata for fields unchanged during a reload", async () => {
    await load(note());
    Object.assign(disk.orgs.get("acme/ctx")!.get("open")!, {
      title: "Agent title",
      pinned: true,
    });
    await store().loadNotes();
    expect(store().notes[0]).toMatchObject({ title: "Agent title", pinned: true });
  });

  it("keeps a local title while adopting an unrelated agent pin from a held reload", async () => {
    await load(note());
    disk.orgs.get("acme/ctx")!.get("open")!.pinned = true;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const read = vi.mocked(readNote).getMockImplementation()!;
    let reading = false;
    vi.mocked(readNote).mockImplementationOnce(async (...args) => {
      const result = await read(...args);
      reading = true;
      await held;
      return result;
    });
    const loading = store().loadNotes();
    await vi.waitFor(() => expect(reading).toBe(true));
    await store().renameNote("open", "Plans");
    release();
    await loading;
    expect(store().notes[0]).toMatchObject({ title: "Plans", pinned: true });
  });

  it.each(["title", "pin"] as const)(
    "keeps a pending %s through another note's snapshot and the outgoing body-save snapshot",
    async (field) => {
      await load(note(), { other: note({ title: "Work", body: "tasks" }) });
      let release!: () => void;
      const held = new Promise<void>((resolve) => (release = resolve));
      const real = vi.mocked(updateNoteMeta).getMockImplementation()!;
      vi.mocked(updateNoteMeta).mockImplementationOnce(async (...args) => {
        await held;
        return real(...args);
      });
      const saving =
        field === "title"
          ? store().renameNote("open", "Groceries")
          : store().setNotePinned("open", true);
      const projected = (id: string) => {
        const n = disk.orgs.get("acme/ctx")!.get(id)!;
        return { id, title: n.title, fields: { title: n.title, pinned: n.pinned } };
      };
      const snapshot = (id: string, requestId?: string) =>
        store().applyNotesProjection(
          store().notesLoadedScope!,
          [projected("open"), projected("other")],
          { upserts: [projected(id)], kind: "write", requestId },
        );
      snapshot("other");
      expect(store().notes.find((n) => n.id === "open")).toMatchObject(
        field === "title" ? { title: "Groceries" } : { pinned: true },
      );
      const write = vi.mocked(writeNote).getMockImplementation()!;
      vi.mocked(writeNote).mockImplementationOnce(async (...args) => {
        const result = await write(...args);
        snapshot("open", args[4]);
        return result;
      });
      store().setScratchNoteContent(" ");
      expect(await store().createNote()).toBe("new-1");
      release();
      await saving;
      expect(createNote).toHaveBeenCalledOnce();
      expect(disk.orgs.get("acme/ctx")!.get("open")).toMatchObject(
        field === "title" ? { title: "Groceries" } : { pinned: true },
      );
    },
  );

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
  const project = () =>
    store().applyNotesProjection(
      store().notesLoadedScope!,
      [...disk.orgs.get("acme/ctx")!].map(([id, n]) => ({
        id,
        title: n.title,
        fields: { title: n.title, pinned: n.pinned },
      })),
      { upserts: [], kind: "write" },
    );

  it.each(["title", "pin"] as const)(
    "keeps an agent %s after a pending local write fails, so New creates separately",
    async (field) => {
      await load(note());
      let fail!: (error: Error) => void;
      vi.mocked(updateNoteMeta).mockImplementationOnce(
        () => new Promise((_resolve, reject) => (fail = reject)),
      );
      const saving =
        field === "title"
          ? store().renameNote("open", "Local title")
          : store().setNotePinned("open", true);
      const persisted = disk.orgs.get("acme/ctx")!.get("open")!;
      if (field === "title") persisted.title = "Agent title";
      else persisted.pinned = true;
      project();
      expect(shown()).toMatchObject(
        field === "title" ? { title: "Local title" } : { pinned: true },
      );
      fail(new Error("disk full"));
      await saving;
      expect(store().scratchNoteContent).toBe("");
      expect(await store().createNote()).toBe("new-1");
      expect(createNote).toHaveBeenCalledOnce();
      expect(shown()).toMatchObject({ title: persisted.title, pinned: persisted.pinned });
      expect(persisted.body).toBe("");
    },
  );

  it.each(["title", "pin"] as const)(
    "does not replace an agent %s rollback baseline with an older async snapshot",
    async (field) => {
      for (const operation of ["reload", "delete"] as const) {
        await load(note(), { other: note({ title: "Work" }) });
        let fail!: (error: Error) => void;
        vi.mocked(updateNoteMeta).mockImplementationOnce(
          () => new Promise((_resolve, reject) => (fail = reject)),
        );
        const saving =
          field === "title"
            ? store().renameNote("open", "Local title")
            : store().setNotePinned("open", true);
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        let captured = false;
        if (operation === "reload") {
          const read = vi.mocked(readNote).getMockImplementation()!;
          vi.mocked(readNote).mockImplementationOnce(async (...args) => {
            const result = await read(...args);
            captured = true;
            await held;
            return result;
          });
        } else {
          vi.mocked(deleteNote).mockImplementationOnce(async (scope, id) => {
            disk.orgs.get(scope.orgSlug ?? "")!.delete(id);
            const rows = await listNotes(scope);
            captured = true;
            await held;
            return rows;
          });
        }
        const snapshot = operation === "reload" ? store().loadNotes() : store().deleteNote("other");
        await vi.waitFor(() => expect(captured).toBe(true));
        const persisted = disk.orgs.get("acme/ctx")!.get("open")!;
        if (field === "title") persisted.title = "Agent title";
        else persisted.pinned = true;
        project();
        release();
        await snapshot;
        expect(shown()).toMatchObject(
          field === "title" ? { title: "Local title" } : { pinned: true },
        );
        fail(new Error("disk full"));
        await saving;
        expect(shown()).toMatchObject({ title: persisted.title, pinned: persisted.pinned });
        expect(await store().createNote()).toBe("new-1");
        vi.clearAllMocks();
      }
    },
  );

  it.each([
    ["title", false],
    ["title", true],
    ["pin", false],
    ["pin", true],
  ] as const)(
    "retains local %s intent over an agent baseline until both writes fail (newer first: %s)",
    async (field, newerFirst) => {
      await load(note());
      const reject: ((error: Error) => void)[] = [];
      for (let i = 0; i < 2; i++)
        vi.mocked(updateNoteMeta).mockImplementationOnce(
          () => new Promise((_resolve, fail) => reject.push(fail)),
        );
      const first =
        field === "title"
          ? store().renameNote("open", "Local title")
          : store().setNotePinned("open", true);
      const persisted = disk.orgs.get("acme/ctx")!.get("open")!;
      if (field === "title") persisted.title = "Agent title";
      else persisted.pinned = true;
      project();
      const second =
        field === "title"
          ? store().renameNote("open", "Newer title")
          : store().setNotePinned("open", false);
      const writes = [first, second];
      const firstRejected = newerFirst ? 1 : 0;
      reject[firstRejected](new Error("disk full"));
      await writes[firstRejected];
      expect(shown()).toMatchObject(
        field === "title"
          ? { title: newerFirst ? "Local title" : "Newer title" }
          : { pinned: newerFirst },
      );
      reject[1 - firstRejected](new Error("disk full"));
      await writes[1 - firstRejected];
      expect(shown()).toMatchObject({ title: persisted.title, pinned: persisted.pinned });
    },
  );

  it.each<[string, () => Promise<void>, () => unknown, unknown]>([
    ["title", () => store().renameNote("open", "Groceries"), () => shown().title, "Plan"],
    ["pin", () => store().setNotePinned("open", true), () => shown().pinned, false],
  ])("a failed %s write puts the old value back", async (_field, write, value, old) => {
    await load(note({ title: "Plan", body: "milk" }));
    vi.mocked(updateNoteMeta).mockRejectedValueOnce(new Error("disk full"));
    await write();
    expect(value()).toBe(old);
  });

  it.each([
    ["title", false],
    ["title", true],
    ["pin", false],
    ["pin", true],
  ] as const)(
    "two failed %s writes restore disk metadata (newer rejects first: %s)",
    async (field, newerFirst) => {
      await load(note({ title: "Plan", body: "milk" }));
      const reject: ((error: Error) => void)[] = [];
      for (let i = 0; i < 2; i++)
        vi.mocked(updateNoteMeta).mockImplementationOnce(
          () => new Promise((_resolve, fail) => reject.push(fail)),
        );
      const first =
        field === "title"
          ? store().renameNote("open", "Groceries")
          : store().setNotePinned("open", true);
      const second =
        field === "title"
          ? store().renameNote("open", "Errands")
          : store().setNotePinned("open", false);
      const writes = [first, second];
      for (const index of newerFirst ? [1, 0] : [0, 1]) {
        reject[index](new Error("disk full"));
        await writes[index];
      }
      const persisted = disk.orgs.get("acme/ctx")!.get("open")!;
      expect(shown().title).toBe(persisted.title);
      expect(shown().pinned).toBe(persisted.pinned);
      expect(persisted).toMatchObject({ title: "Plan", pinned: false });
    },
  );

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
