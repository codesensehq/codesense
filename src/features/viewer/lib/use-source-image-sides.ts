// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";

import {
  sourceFileImageSides,
  sourceRemoteImageSides,
  type SourceRepo,
} from "@/features/git-sync/lib/source-redline-source";
import { IMAGE_UNAVAILABLE, type FileDiffSides } from "@/shared/lib/render-file-diff";
import { isRasterImage } from "@/shared/lib/side-frame";
import type { ImageSides } from "@/tauri/commands";

/** What the source diff knows of a raster file's sides: their bytes, or that they are being
 *  read, or why they won't draw here. Empty for any other file. */
export type SourceImageSides = Pick<FileDiffSides, "imageBytes" | "imageState">;

const unavailable = (reason: string): SourceImageSides => ({
  imageState: { kind: "unavailable", reason },
});

/**
 * A raster file's Before | After bytes in the source diff, so its rendered sides can
 * draw (the redline reads it as binary). Read from a local worktree at the working tree
 * (`sha` null, before at the redline's own baseline) or at a commit, or from a remote
 * worktree's machine at the working tree. While they are read it says so; a side past the
 * size cap or a failed (or refused) read says why it won't draw, and the diff stays Source
 * only. A remote worktree has no commit view, so none is read at a commit.
 */
export function useSourceImageSides(
  repo: string | SourceRepo,
  sha: string | null,
  filePath: string | null,
  oldPath: string | undefined,
  baseRef: string | undefined,
  worktreeNonce = 0,
): SourceImageSides {
  const remote = typeof repo !== "string" && repo.kind === "remote" ? repo : null;
  const cwd = typeof repo === "string" ? repo : repo.kind === "local" ? repo.cwd : null;
  const raster = filePath != null && isRasterImage(filePath);
  const remoteAtCommit = remote != null && sha != null;
  // An empty local path names no repository yet (the overlay's resolver is still out).
  const wanted = raster && (!!cwd || (remote != null && sha == null));
  const where = remote ? ["remote", remote.machineId, remote.handle] : ["local", cwd];
  const subject = JSON.stringify([...where, sha, filePath, oldPath, sha ? null : baseRef]);
  const [read, setRead] = useState<{ subject: string; sides: SourceImageSides }>();

  useEffect(() => {
    if (!wanted || filePath == null) return;
    let cancelled = false;
    const reading: Promise<ImageSides> = remote
      ? sourceRemoteImageSides(remote, filePath, { oldPath, baseRef })
      : sourceFileImageSides(cwd!, filePath, sha ? { oldPath, sha } : { oldPath, baseRef });
    reading.then(
      ({ before, after, tooLarge }) => {
        if (cancelled) return;
        const sides = tooLarge
          ? unavailable(IMAGE_UNAVAILABLE.tooLarge)
          : {
              imageBytes: {
                ...(before != null ? { before } : {}),
                ...(after != null ? { after } : {}),
              },
            };
        setRead({ subject, sides });
      },
      () => !cancelled && setRead({ subject, sides: unavailable(IMAGE_UNAVAILABLE.failed) }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `subject` names the inputs
  }, [subject, wanted, worktreeNonce]);

  if (remoteAtCommit && raster) return unavailable(IMAGE_UNAVAILABLE.remote);
  if (!wanted) return {};
  return read?.subject === subject ? read.sides : { imageState: { kind: "reading" } };
}
