// SPDX-License-Identifier: MIT
import { useEffect, useState } from "react";

import {
  sourceFileImageSides,
  type SourceRepo,
} from "@/features/git-sync/lib/source-redline-source";
import type { FileDiffSides } from "@/shared/lib/render-file-diff";
import { isRasterImage } from "@/shared/lib/side-frame";

type ImageBytes = NonNullable<FileDiffSides["imageBytes"]>;

/**
 * A raster file's Before | After bytes in the source diff, so its rendered sides can
 * draw (the redline reads it as binary). Read from a LOCAL worktree at the working tree
 * (`sha` null, before at the redline's own baseline) or at a commit. `undefined` while
 * reading, and for anything it doesn't read: a non-raster file, a remote worktree, a
 * side past the size cap or a failed read. Then the diff stays Source only.
 */
export function useSourceImageSides(
  repo: string | SourceRepo,
  sha: string | null,
  filePath: string | null,
  oldPath: string | undefined,
  baseRef: string | undefined,
  worktreeNonce = 0,
): ImageBytes | undefined {
  const cwd = typeof repo === "string" ? repo : repo.kind === "local" ? repo.cwd : null;
  const wanted = cwd != null && filePath != null && isRasterImage(filePath);
  const subject = JSON.stringify([cwd, sha, filePath, oldPath, sha ? null : baseRef]);
  const [read, setRead] = useState<{ subject: string; bytes: ImageBytes | undefined }>();

  useEffect(() => {
    if (!wanted) return;
    let cancelled = false;
    const opts = sha ? { oldPath, sha } : { oldPath, baseRef };
    sourceFileImageSides(cwd, filePath, opts).then(
      ({ before, after, tooLarge }) => {
        if (cancelled) return;
        const bytes = tooLarge
          ? undefined
          : { ...(before != null ? { before } : {}), ...(after != null ? { after } : {}) };
        setRead({ subject, bytes });
      },
      () => !cancelled && setRead({ subject, bytes: undefined }),
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `subject` names the inputs
  }, [subject, wanted, worktreeNonce]);

  return wanted && read?.subject === subject ? read.bytes : undefined;
}
