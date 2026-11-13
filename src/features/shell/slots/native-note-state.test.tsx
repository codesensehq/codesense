// SPDX-License-Identifier: MIT
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NoteMeta } from "@/tauri/commands";
const hub = vi.hoisted(() => ({
  callback: null as ((value: any) => void) | null,
  write: vi.fn(async () => ({})),
}));
const noteApi = vi.hoisted(() => ({
  list: vi.fn(),
  read: vi.fn(),
  update: vi.fn(async (): Promise<NoteMeta | null> => null),
}));
vi.mock("@/tauri/commands", async (original) => ({
  ...(await original<typeof import("@/tauri/commands")>()),
  listNotes: noteApi.list,
  readNote: noteApi.read,
  updateNoteMeta: noteApi.update,
}));
vi.mock("@/features/dashboard/lib/live-hub", () => ({
  liveHub: {
    watch: (_topic: string, _key: string, callback: (value: any) => void) => {
      hub.callback = callback;
      return () => {};
    },
    writeUi: hub.write,
  },
}));
// The real panel (rendered by the title tests at the end) listens for window focus.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ onFocusChanged: async () => () => {} }),
}));
vi.mock("@/features/viewer/components/scratch-note-panel", () => ({
  ScratchNotePanel: () => null,
}));
import { usePaneStore } from "../right-pane/panes/pane-store";
import { NativeSlotProvider } from "./native-slot-context";
import { registerBuiltinPanels } from "../right-pane/builtin-panels";
import { getPanel } from "../right-pane/panel-registry";
import { useOrgStore } from "@/shared/stores/org-store";
import { useViewerStore } from "@/shared/stores/viewer-store";
const realSelect = useViewerStore.getState().setActiveNote;
const realLoad = useViewerStore.getState().loadNotes;
const realRename = useViewerStore.getState().renameNote;
const metas = (...ids: string[]) =>
  ids.map((id) => ({ id, title: id, pinned: false, lastOpenedAt: 1 }));
beforeEach(() => {
  useOrgStore.setState({ activeOrgSlug: "acme" });
  useViewerStore.setState({
    notesLoadedScope: { githubUserId: 0, orgSlug: "acme" },
    notes: metas("shared", "intent", "previous", "native-pick", "another-page"),
    scratchNoteLoadStatus: "loaded",
  });
});
it.each([false, true])(
  "shares a real local pick that supersedes native restoration (intent=%s)",
  async (intent) => {
    let release!: (value: { id: string; content: string }) => void;
    const pending = new Promise<{ id: string; content: string }>((resolve) => {
      release = resolve;
    });
    noteApi.read.mockImplementation(async (_scope, id) =>
      id === "alpha" ? pending : { id, content: id },
    );
    useViewerStore.setState({
      setActiveNote: realSelect,
      activeNoteId: "previous",
      scratchNoteContent: "previous",
      notes: metas("previous", "alpha", "beta", "gamma"),
    });
    usePaneStore.setState({ pendingIntents: intent ? { scratch: { noteId: "alpha" } } : {} });
    registerBuiltinPanels();
    render(getPanel("scratch")!.render());
    act(() =>
      hub.callback!({ snapshot: [{ id: "ui:right-pane", noteId: intent ? "previous" : "alpha" }] }),
    );
    await waitFor(() =>
      expect(noteApi.read.mock.calls.some((call) => call[1] === "alpha")).toBe(true),
    );
    try {
      await act(async () => {
        await realSelect("beta");
      });
      expect(useViewerStore.getState().activeNoteId).toBe("beta");
      expect(hub.write).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        release({ id: "alpha", content: "alpha" });
      });
    }
    await waitFor(() =>
      expect(hub.write).toHaveBeenCalledExactlyOnceWith("ui:right-pane", "all", { noteId: "beta" }),
    );
    expect(usePaneStore.getState().pendingIntents.scratch).toBeUndefined();
    await act(async () => {
      await realSelect("gamma");
    });
    await waitFor(() => expect(hub.write).toHaveBeenCalledTimes(2));
    expect(hub.write).toHaveBeenLastCalledWith("ui:right-pane", "all", { noteId: "gamma" });
  },
);
function Fallback() {
  const intent = usePaneStore((s) => s.pendingIntents["pane:notes"]);
  return (
    <NativeSlotProvider
      slotId="right-pane"
      panelId="pane:notes"
      viewKey="all"
      intent={intent}
      onIntentDelivered={() => intent && usePaneStore.getState().clearIntent("pane:notes", intent)}
    >
      {getPanel("scratch")!.render()}
    </NativeSlotProvider>
  );
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it.each([
  { intent: undefined, initial: "shared", fallback: true },
  { intent: { noteId: "intent" }, initial: "intent", fallback: true },
  { intent: undefined, initial: "shared", fallback: false },
  { intent: { noteId: "intent" }, initial: "intent", fallback: false },
])(
  "restores selection and applies intent once, then shares native picks and follows external changes ($initial)",
  async ({ intent, initial, fallback }) => {
    useViewerStore.setState({
      activeNoteId: "previous",
      setActiveNote: async (id: string) => {
        useViewerStore.setState({ activeNoteId: id });
      },
    });
    registerBuiltinPanels();
    const panel = fallback ? "pane:notes" : "scratch";
    usePaneStore.setState({ pendingIntents: intent ? { [panel]: intent } : {} });
    render(fallback ? <Fallback /> : getPanel("scratch")!.render());
    expect(hub.write).not.toHaveBeenCalled();
    act(() => hub.callback!({ snapshot: [{ id: "ui:right-pane", noteId: "shared" }] }));
    await waitFor(() => expect(useViewerStore.getState().activeNoteId).toBe(initial));
    if (intent) {
      await waitFor(() =>
        expect(hub.write).toHaveBeenCalledExactlyOnceWith("ui:right-pane", "all", {
          noteId: "intent",
        }),
      );
      expect(usePaneStore.getState().pendingIntents[panel]).toBeUndefined();
    } else expect(hub.write).not.toHaveBeenCalled();
    hub.write.mockClear();
    act(() => useViewerStore.setState({ activeNoteId: "native-pick" }));
    await waitFor(() =>
      expect(hub.write).toHaveBeenCalledExactlyOnceWith("ui:right-pane", "all", {
        noteId: "native-pick",
      }),
    );
    act(() => hub.callback!({ snapshot: [{ id: "ui:right-pane", noteId: "another-page" }] }));
    await waitFor(() => expect(useViewerStore.getState().activeNoteId).toBe("another-page"));
    expect(hub.write).toHaveBeenCalledTimes(1);
  },
);

it("waits for the active org's actual notes load and ignores shared notes outside that model", async () => {
  let release!: (rows: ReturnType<typeof metas>) => void;
  noteApi.list.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  noteApi.read.mockImplementation(async (_scope, id) => ({ id, content: `body of ${id}` }));
  useViewerStore.setState({
    setActiveNote: realSelect,
    loadNotes: realLoad,
    notes: metas("a-alpha", "a-beta"),
    activeNoteId: "a-beta",
    scratchNoteContent: "A beta",
  });
  usePaneStore.setState({ pendingIntents: {} });
  useOrgStore.setState({ activeOrgSlug: "other" });
  const loading = realLoad();
  await waitFor(() => expect(noteApi.list).toHaveBeenCalled());
  registerBuiltinPanels();
  render(getPanel("scratch")!.render());
  act(() => hub.callback!({ snapshot: [{ id: "ui:right-pane", noteId: "a-alpha" }] }));
  await act(async () => Promise.resolve());
  expect(noteApi.read).not.toHaveBeenCalled();
  expect(hub.write).not.toHaveBeenCalled();
  await act(async () => {
    release(metas("b-note"));
    await loading;
  });
  expect(useViewerStore.getState()).toMatchObject({
    notesLoadedScope: { orgSlug: "other" },
    activeNoteId: "b-note",
    scratchNoteContent: "body of b-note",
  });
  expect(noteApi.read.mock.calls.map((call) => call[1])).toEqual(["b-note"]);
  act(() => hub.callback!({ snapshot: [{ id: "ui:right-pane", noteId: "new-note" }] }));
  await act(async () => Promise.resolve());
  expect(noteApi.read.mock.calls.map((call) => call[1])).toEqual(["b-note"]);
  act(() => useViewerStore.setState({ notes: metas("b-note", "new-note") }));
  await waitFor(() => expect(useViewerStore.getState().activeNoteId).toBe("new-note"));
  expect(noteApi.read.mock.calls.map((call) => call[1])).toEqual(["b-note", "new-note"]);
});

it.each([
  [
    "⌘N on the title field",
    (title: HTMLElement) => fireEvent.keyDown(title, { key: "n", metaKey: true }),
  ],
  [
    "… → New note",
    () => {
      fireEvent.click(screen.getByRole("button", { name: "Note actions" }));
      fireEvent.click(screen.getByRole("button", { name: /New note/ }));
    },
  ],
])("%s saves a typed title before it creates", async (_how, newNote) => {
  // The real panel: this file stubs it for the slot tests above.
  const { ScratchNotePanel } = await vi.importActual<
    typeof import("@/features/viewer/components/scratch-note-panel")
  >("@/features/viewer/components/scratch-note-panel");
  const renameNote = vi.fn(async () => {});
  const createNote = vi.fn(async () => "new-note");
  useViewerStore.setState({
    notes: [{ id: "n1", title: "My Note", pinned: false, lastOpenedAt: 1 }],
    activeNoteId: "n1",
    scratchNoteContent: "body",
    renameNote,
    createNote,
  });
  render(<ScratchNotePanel />);
  const title = screen.getByRole("textbox", { name: "Note title" });
  fireEvent.change(title, { target: { value: "Plans" } });
  newNote(title);
  expect(renameNote).toHaveBeenCalledWith("n1", "Plans");
  expect(createNote).toHaveBeenCalledTimes(1);
  expect(renameNote.mock.invocationCallOrder[0]).toBeLessThan(
    createNote.mock.invocationCallOrder[0],
  );
});

it.each([
  ["⌘N", (title: HTMLElement) => fireEvent.keyDown(title, { key: "n", metaKey: true })],
  [
    "New note menu",
    () => {
      fireEvent.click(screen.getByRole("button", { name: "Note actions" }));
      fireEvent.click(screen.getByRole("button", { name: /New note/ }));
    },
  ],
])("a padded title saved on blur follows an agent rename before %s", async (_how, newNote) => {
  const { ScratchNotePanel } = await vi.importActual<
    typeof import("@/features/viewer/components/scratch-note-panel")
  >("@/features/viewer/components/scratch-note-panel");
  let resolve!: (meta: NoteMeta) => void;
  const pending = new Promise<NoteMeta>((done) => (resolve = done));
  noteApi.update.mockImplementationOnce(() => pending);
  const createNote = vi.fn(async () => "new-note");
  useViewerStore.setState({
    notes: [{ id: "n1", title: "Plan", pinned: false, lastOpenedAt: 1 }],
    activeNoteId: "n1",
    scratchNoteContent: "body",
    loadNotes: async () => {},
    renameNote: realRename,
    createNote,
  });
  const { container } = render(<ScratchNotePanel />);
  const title = screen.getByRole("textbox", { name: "Note title" }) as HTMLInputElement;
  act(() => title.focus());
  fireEvent.change(title, { target: { value: " Plans " } });
  act(() => container.querySelector<HTMLElement>('[contenteditable="true"]')!.focus());
  expect(noteApi.update).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ orgSlug: "acme" }),
    "n1",
    { title: "Plans" },
  );
  await act(async () => {
    resolve({ id: "n1", title: "Plans", pinned: false, lastOpenedAt: 1 });
    await pending;
  });
  expect(title.value).toBe("Plans");
  act(() =>
    useViewerStore
      .getState()
      .applyNotesProjection(
        useViewerStore.getState().notesLoadedScope!,
        [{ id: "n1", title: "Agent plan", fields: { title: "Agent plan", pinned: false } }],
        { upserts: [], kind: "write" },
      ),
  );
  expect(title.value).toBe("Agent plan");
  newNote(title);
  await waitFor(() => expect(createNote).toHaveBeenCalledTimes(1));
  expect(noteApi.update).toHaveBeenCalledTimes(1);
  expect(useViewerStore.getState().notes[0].title).toBe("Agent plan");
});

it("preserves input typed after a padded title commit while its save succeeds", async () => {
  const { ScratchNotePanel } = await vi.importActual<
    typeof import("@/features/viewer/components/scratch-note-panel")
  >("@/features/viewer/components/scratch-note-panel");
  let resolve!: (meta: NoteMeta) => void;
  const pending = new Promise<NoteMeta>((done) => (resolve = done));
  noteApi.update.mockImplementationOnce(() => pending);
  useViewerStore.setState({
    notes: [{ id: "n1", title: "Plan", pinned: false, lastOpenedAt: 1 }],
    activeNoteId: "n1",
    scratchNoteContent: "body",
    loadNotes: async () => {},
    renameNote: realRename,
  });
  const { container } = render(<ScratchNotePanel />);
  const title = screen.getByRole("textbox", { name: "Note title" }) as HTMLInputElement;
  act(() => title.focus());
  fireEvent.change(title, { target: { value: " Plans " } });
  act(() => container.querySelector<HTMLElement>('[contenteditable="true"]')!.focus());
  act(() => title.focus());
  fireEvent.change(title, { target: { value: "Plans for tomorrow" } });
  await act(async () => {
    resolve({ id: "n1", title: "Plans", pinned: false, lastOpenedAt: 1 });
    await pending;
  });
  expect(useViewerStore.getState().notes[0].title).toBe("Plans");
  expect(title.value).toBe("Plans for tomorrow");
  expect(noteApi.update).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "a failed real rename rolls back saved metadata and preserves a newer draft (%s)",
  async (newerDraft) => {
    const { ScratchNotePanel } = await vi.importActual<
      typeof import("@/features/viewer/components/scratch-note-panel")
    >("@/features/viewer/components/scratch-note-panel");
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, fail) => (reject = fail));
    noteApi.update.mockImplementationOnce(() => pending);
    useViewerStore.setState({
      notes: [{ id: "n1", title: "Plan", pinned: false, lastOpenedAt: 1 }],
      activeNoteId: "n1",
      scratchNoteContent: "body",
      loadNotes: async () => {},
      renameNote: realRename,
    });
    render(<ScratchNotePanel />);
    const title = screen.getByRole("textbox", { name: "Note title" });
    fireEvent.change(title, { target: { value: "Plans" } });
    fireEvent.keyDown(title, { key: "Enter" });
    expect(useViewerStore.getState().notes[0].title).toBe("Plans");
    if (newerDraft) {
      fireEvent.focus(title);
      fireEvent.change(title, { target: { value: "Plans for tomorrow" } });
    }
    await act(async () => {
      reject(new Error("disk full"));
      await pending.catch(() => {});
    });
    await waitFor(() => expect(useViewerStore.getState().notes[0].title).toBe("Plan"));
    expect((title as HTMLInputElement).value).toBe(newerDraft ? "Plans for tomorrow" : "Plan");
    if (newerDraft) {
      noteApi.update.mockImplementationOnce(async () => ({
        id: "n1",
        title: "Plans for tomorrow",
        pinned: false,
        lastOpenedAt: 1,
      }));
      await act(async () => {
        fireEvent.keyDown(title, { key: "Enter" });
      });
      expect(useViewerStore.getState().notes[0].title).toBe("Plans for tomorrow");
      expect(noteApi.update).toHaveBeenLastCalledWith(
        expect.objectContaining({ orgSlug: "acme" }),
        "n1",
        { title: "Plans for tomorrow" },
      );
    }
  },
);

it("follows agent titles without a draft, preserves a draft, and resets it on navigation", async () => {
  const { ScratchNotePanel } = await vi.importActual<
    typeof import("@/features/viewer/components/scratch-note-panel")
  >("@/features/viewer/components/scratch-note-panel");
  useViewerStore.setState({
    notes: [
      { id: "n1", title: "Plan", pinned: false, lastOpenedAt: 1 },
      { id: "n2", title: "Other", pinned: false, lastOpenedAt: 1 },
    ],
    activeNoteId: "n1",
    scratchNoteContent: "body",
    loadNotes: async () => {},
    renameNote: realRename,
  });
  render(<ScratchNotePanel />);
  const title = screen.getByRole("textbox", { name: "Note title" });
  const agentTitle = (next: string) =>
    act(() =>
      useViewerStore.getState().applyNotesProjection(
        useViewerStore.getState().notesLoadedScope!,
        [
          { id: "n1", title: next, fields: { title: next, pinned: false } },
          { id: "n2", title: "Other", fields: { title: "Other", pinned: false } },
        ],
        { upserts: [], kind: "write" },
      ),
    );
  agentTitle("Agent title");
  expect((title as HTMLInputElement).value).toBe("Agent title");
  fireEvent.change(title, { target: { value: "My draft" } });
  agentTitle("Agent revised title");
  expect(useViewerStore.getState().notes[0].title).toBe("Agent revised title");
  expect((title as HTMLInputElement).value).toBe("My draft");
  act(() => useViewerStore.setState({ activeNoteId: "n2" }));
  expect((title as HTMLInputElement).value).toBe("Other");
});
