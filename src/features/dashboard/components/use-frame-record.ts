// SPDX-License-Identifier: MIT
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  mintFrame,
  rebindFrameTeam,
  revalidateFrame,
  releaseFrame,
  type FrameRecord,
  type MintFrameArgs,
} from "@/tauri/commands";

import { flushFrame, retireAfterFlush, hasLiveFrames } from "../lib/frame-lifecycle";
import { VIEWER_PERF } from "@/shared/lib/viewer-perf-config";
import { BridgedFrameBudget } from "../lib/bridged-frame-budget";
import { bridgeTiming, nowMs } from "../lib/bridge-timing";

const budget = new BridgedFrameBudget(VIEWER_PERF.maxBridgedFrames, (pinned) => {
  if (import.meta.env.DEV)
    console.warn(`Bridged frames: ${pinned} pinned frames exceed the budget`);
});
interface FrameActivity {
  visible: boolean;
  unsaved: boolean;
  retiring?: boolean;
}

const release = (record: FrameRecord) => {
  void releaseFrame(record.frameId).catch(console.error);
};
const retire = (record: FrameRecord) => {
  if (hasLiveFrames((f) => f.frameId === record.frameId))
    void flushFrame(record).then(() => release(record));
  else release(record);
};

/** One host mount owns one revocable frame, including a mint that finishes
 * after unmount. A changed document never renders with the previous grant. */
export function useFrameRecord(
  port: number | null | undefined,
  args: MintFrameArgs | null,
  activity?: FrameActivity,
  sourceRevision?: number,
) {
  const mount = useRef(Symbol("bridged-frame"));
  const latestActivity = useRef(activity);
  const visible = activity?.visible ?? true;
  const unsaved = activity?.unsaved ?? false;
  const retiring = activity?.retiring ?? false;
  const [generation, retry] = useState(0);
  const remintFrame = useCallback(() => {
    bridgeTiming(() => `frame-remint reason=requested t=${nowMs()}`);
    retry((n) => n + 1);
  }, []);
  useEffect(() => {
    latestActivity.current = activity;
  });
  const documentPath = args?.documentPath;
  const contentRoot = args?.contentRoot;
  const assetFolder = args?.assetFolder;
  const slot = args?.slot;
  const org = args?.message?.org;
  const team = args?.message?.team;
  const messageId = args?.message?.messageId;
  const builtinOrg = args?.builtinTeam?.org;
  const builtinTeam = args?.builtinTeam?.team;
  const request = useMemo<MintFrameArgs | null>(() => {
    if (!documentPath || !contentRoot || !slot) return null;
    return {
      documentPath,
      contentRoot,
      assetFolder,
      slot,
      ...(builtinOrg && builtinTeam ? { builtinTeam: { org: builtinOrg, team: builtinTeam } } : {}),
      ...(org !== undefined && team !== undefined && messageId !== undefined
        ? { message: { org, team, messageId } }
        : {}),
    };
  }, [documentPath, contentRoot, assetFolder, slot, org, team, messageId, builtinOrg, builtinTeam]);
  const key = JSON.stringify([port, request, generation]);
  const [state, setState] = useState<{
    key: string;
    frame: FrameRecord | null;
    error: string | null;
    evicted?: boolean;
    approvedRevision?: number;
  } | null>(null);
  // The lifetime owns allocation/budget/release. A refresh only cancels its comparison.
  const owner = useRef<{
    frame: FrameRecord | null;
    unregister?: () => void;
  } | null>(null);
  useEffect(() => {
    const lifetime = {
      frame: null as FrameRecord | null,
      unregister: undefined as (() => void) | undefined,
    };
    owner.current = lifetime;
    return () => {
      owner.current = null;
      lifetime.unregister?.();
      if (lifetime.frame) retire(lifetime.frame);
      lifetime.frame = null;
    };
  }, [key]);
  useEffect(() => {
    if (!request || typeof port !== "number") {
      setState(null);
      return;
    }
    let active = true;
    const lifetime = owner.current!;
    const current = lifetime.frame;
    let validating = !!current;
    const run = async () => {
      if (current) {
        const result = await revalidateFrame(current.frameId, current.token);
        if (!active || lifetime.frame !== current) return;
        if (result === "unchanged") {
          setState({ key, frame: current, error: null, approvedRevision: sourceRevision });
          return;
        }
        validating = false;
        // The next render hides the old document before the replacement is adopted.
        setState(null);
        lifetime.unregister?.();
        lifetime.unregister = undefined;
        lifetime.frame = null;
        retire(current);
      }
      const frame = await mintFrame(request);
      if (!active) {
        release(frame);
        return;
      }
      lifetime.frame = frame;
      setState({ key, frame, error: null, approvedRevision: sourceRevision });
      if (request.slot !== "baseline")
        lifetime.unregister = budget.register(mount.current, {
          visible: latestActivity.current?.visible ?? true,
          unsaved: latestActivity.current?.unsaved ?? false,
          privateSpace: frame.kind === "private",
          flush: () =>
            retireAfterFlush(
              (f) => f.frameId === frame.frameId,
              () => {},
            ),
          evict: () => {
            if (owner.current !== lifetime || lifetime.frame !== frame) return;
            bridgeTiming(
              () =>
                `frame-evict frame=${frame.frameId} path=${documentPath} t=${nowMs()} maxBridgedFrames=${VIEWER_PERF.maxBridgedFrames}`,
            );
            lifetime.frame = null;
            release(frame);
            setState({ key, frame: null, error: null, evicted: true });
          },
        });
    };
    void run().catch((error: unknown) => {
      if (!active || (validating && lifetime.frame !== current)) return;
      lifetime.unregister?.();
      lifetime.unregister = undefined;
      if (lifetime.frame) retire(lifetime.frame);
      lifetime.frame = null;
      setState({ key, frame: null, error: `Failed to create document frame: ${String(error)}` });
    });
    return () => {
      active = false;
    };
  }, [port, request, key, sourceRevision, documentPath]);
  useEffect(() => {
    budget.update(mount.current, { visible: visible && !retiring, unsaved });
  }, [visible, unsaved, retiring]);
  useEffect(() => {
    if (visible && state?.key === key && state.evicted) {
      bridgeTiming(
        () => `frame-remint reason=evicted-now-visible path=${documentPath} t=${nowMs()}`,
      );
      retry((n) => n + 1);
    }
  }, [visible, state, key, documentPath]);
  const frame = state?.key === key ? state.frame : null;
  const [, rebound] = useState(0);
  /** A follows-context frame moves to `team` without a new mint: the record keeps its identity
   *  and is updated in place, so the page, its listeners and its lifecycle never restart. */
  const rebindTeam = useCallback(
    async (team: { org: string; team: string }) => {
      if (!frame) throw new Error("unavailable: no frame");
      const next = await rebindFrameTeam(frame.frameId, frame.token, team.org, team.team);
      Object.assign(frame, next);
      rebound((n) => n + 1);
      return frame;
    },
    [frame],
  );
  return {
    remintFrame,
    rebindTeam,
    approvedRevision: state?.key === key ? state.approvedRevision : undefined,
    frameRecord: frame,
    frameError: state?.key === key ? state.error : null,
  };
}
