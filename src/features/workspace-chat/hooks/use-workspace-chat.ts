// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { listen } from "@tauri-apps/api/event";

import {
  workspaceChatRead,
  type WorkspaceChatMediaPayload,
  type WorkspaceChatMessage,
  type WorkspaceChatUpdatedPayload,
} from "@/tauri/commands";
import { logger } from "@/shared/lib/logger";

/**
 * SW-WC-3 — the workspace-chat pane's data hook.
 *
 * Mirrors the inbox pattern (`useAgentUpdates`, `useAttentionBoard`): one
 * initial read, then an event-driven re-read. The engine owns ordering + the
 * cursor; this hook just advances `headId` and appends.
 *
 * - **Initial load**: `workspace_chat_read` with `limit = DEFAULT_LIMIT`
 *   (defaults to 50; the engine caps at 500). Returns the tail oldest-first.
 * - **Nudge**: on every `codesense:workspace-chat-updated` event whose payload
 *   workspace matches, re-read with `since = state.headId` — paging the delta
 *   only. The engine returns oldest-first regardless of `since`.
 * - **Media**: on `codesense:workspace-chat-media` for this workspace, re-read that one
 *   message and replace it in place (an image fetched, failed or loaded on a tap); no new
 *   post, and `headId` stays.
 * - **Workspace swap**: the hook keeps the active `workspaceId` inside its
 *   state blob. A read whose target workspace no longer matches the state's
 *   active workspace is discarded on arrival, so a late response from the
 *   previous workspace can never contaminate the new one.
 */
export interface WorkspaceChatHandle {
  /** All seen messages, oldest-first. `null` while the first load is pending. */
  humanReadId?: number;
  messages: WorkspaceChatMessage[] | null;
  /** The engine's last-known head id — the cursor the next re-read advances. */
  headId: number;
  /** `true` while the FIRST load (or a workspace-swap re-load) is in flight. */
  loading: boolean;
  /** Last read error (either initial or incremental), or `null`. */
  error: string | null;
  /** Whether the engine reports the workspace archived (SW-WC-1 flag). */
  archived: boolean;
  /** Re-read from scratch (not an incremental since). */
  reload: () => Promise<void>;
}

const DEFAULT_LIMIT = 50;
const EVENT_NAME = "codesense:workspace-chat-updated";
const MEDIA_EVENT_NAME = "codesense:workspace-chat-media";

/** Append `incoming` to `prev`, deduping by `messageId`. The engine returns
 *  oldest-first and ids are monotonic + dense per workspace, so dedup is cheap
 *  (new ids are > any seen). But an initial read racing a nudge can repeat a
 *  tail message, so we filter instead of trusting the race. */
export function mergeMessages(
  prev: WorkspaceChatMessage[],
  incoming: WorkspaceChatMessage[],
): WorkspaceChatMessage[] {
  if (incoming.length === 0) return prev;
  const seen = new Set(prev.map((m) => m.messageId));
  const additions = incoming.filter((m) => !seen.has(m.messageId));
  if (additions.length === 0) return prev;
  return [...prev, ...additions].sort((a, b) => a.messageId - b.messageId);
}

/** `messages` with each patched message in place of its read copy. A patch is the copy a media
 *  event re-read; `mergeMessages` keeps a first-seen copy, so a read that raced the event
 *  would otherwise keep the stale state. */
export function applyPatches(
  messages: WorkspaceChatMessage[],
  patches: ReadonlyMap<number, WorkspaceChatMessage>,
): WorkspaceChatMessage[] {
  if (patches.size === 0 || !messages.some((m) => patches.has(m.messageId))) return messages;
  return messages.map((m) => patches.get(m.messageId) ?? m);
}

interface ChatState {
  /** Active workspace id. A read whose target doesn't match this is dropped. */
  workspaceId: string | null;
  humanReadId?: number;
  messages: WorkspaceChatMessage[] | null;
  headId: number;
  archived: boolean;
  loading: boolean;
  error: string | null;
}

function initialState(workspaceId: string | null): ChatState {
  return {
    workspaceId,
    messages: null,
    headId: 0,
    archived: false,
    loading: workspaceId !== null,
    error: null,
  };
}

export function useWorkspaceChat(
  workspaceId: string | null,
  limit: number = DEFAULT_LIMIT,
): WorkspaceChatHandle {
  // Workspace swap resets state synchronously during render — React's
  // documented "store derived state" pattern. Any in-flight read for the
  // previous workspace discards itself on arrival (its target no longer
  // matches `state.workspaceId`).
  const [state, setState] = useState<ChatState>(() => initialState(workspaceId));
  const generation = useRef(0);
  useLayoutEffect(() => {
    generation.current += 1;
    patches.current = new Map();
    mediaReads.current = new Map();
    return () => {
      generation.current += 1;
    };
  }, [workspaceId]);
  // Media patches by message id, for the active workspace. A patch stays until a read returns
  // its message in the same media state (the read has caught up), so an older copy from any
  // later full or incremental read can't undo it.
  const patches = useRef(new Map<number, WorkspaceChatMessage>());
  // The latest media re-read by message id: an older one that lands after it is dropped.
  const mediaReads = useRef(new Map<number, number>());
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);
  if (state.workspaceId !== workspaceId) {
    setState(initialState(workspaceId));
  }

  // Drop each patch a read has caught up with: it returned the message in the patch's state.
  const settlePatches = useCallback((read: readonly WorkspaceChatMessage[]) => {
    for (const m of read) {
      const patch = patches.current.get(m.messageId);
      if (patch && patch.mediaState === m.mediaState) patches.current.delete(m.messageId);
    }
  }, []);

  const readFromScratch = useCallback(
    async (ws: string) => {
      const requestGeneration = generation.current;
      try {
        const result = await workspaceChatRead(ws, null, limit);
        if (requestGeneration !== generation.current) return;
        settlePatches(result.messages);
        setState((s) =>
          s.workspaceId === ws
            ? {
                ...s,
                humanReadId: result.humanReadId,
                messages: applyPatches(
                  s.messages ? mergeMessages(result.messages, s.messages) : result.messages,
                  patches.current,
                ),
                headId: Math.max(s.headId, result.headId),
                archived: result.archived,
                loading: false,
              }
            : s,
        );
      } catch (err) {
        if (requestGeneration !== generation.current) return;
        const message = err instanceof Error ? err.message : String(err);
        logger.info("workspace-chat", `read failed (${ws}): ${message}`);
        setState((s) => (s.workspaceId === ws ? { ...s, loading: false, error: message } : s));
      }
    },
    [limit, settlePatches],
  );

  const readIncremental = useCallback(
    async (ws: string, since: number) => {
      const requestGeneration = generation.current;
      try {
        let result = await workspaceChatRead(ws, since, null);
        let incoming = result.messages;
        let cursor = incoming.at(-1)?.messageId ?? since;
        while (cursor < result.headId && result.messages.length > 0) {
          result = await workspaceChatRead(ws, cursor, null);
          incoming = mergeMessages(incoming, result.messages);
          cursor = result.messages.at(-1)?.messageId ?? cursor;
        }
        if (requestGeneration !== generation.current) return;
        settlePatches(incoming);
        setState((s) => {
          if (s.workspaceId !== ws) return s;
          const prevMessages = s.messages ?? [];
          const nextMessages =
            incoming.length > 0
              ? applyPatches(mergeMessages(prevMessages, incoming), patches.current)
              : prevMessages;
          const nextHead = result.headId > s.headId ? result.headId : s.headId;
          if (
            nextMessages === prevMessages &&
            nextHead === s.headId &&
            result.archived === s.archived
          ) {
            return s;
          }
          return {
            ...s,
            messages: nextMessages,
            headId: nextHead,
            archived: result.archived,
          };
        });
      } catch (err) {
        if (requestGeneration !== generation.current) return;
        const message = err instanceof Error ? err.message : String(err);
        logger.info("workspace-chat", `incremental read failed (${ws}): ${message}`);
        setState((s) => (s.workspaceId === ws ? { ...s, error: message } : s));
      }
    },
    [settlePatches],
  );

  // Re-read message `messageId`, whose image changed, and put it in place of its copy.
  const readMedia = useCallback(async (ws: string, messageId: number) => {
    const requestGeneration = generation.current;
    const request = (mediaReads.current.get(messageId) ?? 0) + 1;
    mediaReads.current.set(messageId, request);
    try {
      const result = await workspaceChatRead(ws, messageId - 1, 1);
      if (requestGeneration !== generation.current) return;
      if (mediaReads.current.get(messageId) !== request) return;
      const message = result.messages.find((m) => m.messageId === messageId);
      if (!message) return;
      patches.current.set(messageId, message);
      setState((s) =>
        s.workspaceId === ws && s.messages
          ? { ...s, messages: applyPatches(s.messages, patches.current) }
          : s,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.info("workspace-chat", `media re-read failed (${ws} #${messageId}): ${message}`);
    }
  }, []);

  const reload = useCallback(async () => {
    if (!workspaceId) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    await readFromScratch(workspaceId);
  }, [workspaceId, readFromScratch]);

  // Initial read on every workspaceId change. The sync reset above has already
  // cleared the previous workspace's data.
  useEffect(() => {
    if (!workspaceId) return;
    void Promise.resolve().then(() => readFromScratch(workspaceId));
  }, [workspaceId, readFromScratch]);

  // Subscribe to the chat-updated event. One subscription per hook instance.
  useEffect(() => {
    if (!workspaceId) return;
    const unlisten = listen<WorkspaceChatUpdatedPayload>(EVENT_NAME, (event) => {
      const payload = event.payload;
      if (!payload || payload.workspaceId !== workspaceId) return;
      const current = stateRef.current;
      if (current.workspaceId !== workspaceId || payload.headId <= current.headId) return;
      void readIncremental(workspaceId, current.headId);
    });
    return () => {
      void unlisten.then((u) => u()).catch(() => {});
    };
  }, [workspaceId, readIncremental]);

  // Subscribe to the chat-media event: a message's image changed state on this Mac.
  useEffect(() => {
    if (!workspaceId) return;
    const unlisten = listen<WorkspaceChatMediaPayload>(MEDIA_EVENT_NAME, (event) => {
      const payload = event.payload;
      if (!payload || payload.workspaceId !== workspaceId) return;
      void readMedia(workspaceId, payload.messageId);
    });
    return () => {
      void unlisten.then((u) => u()).catch(() => {});
    };
  }, [workspaceId, readMedia]);

  return {
    humanReadId: state.humanReadId,
    messages: state.messages,
    headId: state.headId,
    loading: state.loading,
    error: state.error,
    archived: state.archived,
    reload,
  };
}
