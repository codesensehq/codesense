// SPDX-License-Identifier: MIT
/** One object URL per cached inbox image, shared by every view of it (the inline
 *  figure, the lightbox, the same image on another message) and revoked when the
 *  last view lets go. */

interface Entry {
  refs: number;
  url: string | null;
  promise: Promise<string>;
}

const entries = new Map<string, Entry>();

/** A view's hold on image `sha256`'s object URL: `read` runs only when no view holds
 *  it yet. Call `release` once when the view goes. A failed read is dropped, so the
 *  next view reads again. */
export function acquireMediaUrl(
  sha256: string,
  read: () => Promise<Blob>,
): { url: Promise<string>; release: () => void } {
  let entry = entries.get(sha256);
  if (!entry) {
    const created: Entry = { refs: 0, url: null, promise: Promise.resolve("") };
    created.promise = read().then(
      (blob) => {
        const url = URL.createObjectURL(blob);
        if (created.refs > 0) created.url = url;
        else URL.revokeObjectURL(url);
        return url;
      },
      (error: unknown) => {
        if (entries.get(sha256) === created) entries.delete(sha256);
        throw error;
      },
    );
    entries.set(sha256, created);
    entry = created;
  }
  const held = entry;
  held.refs += 1;
  let released = false;
  return {
    url: held.promise,
    release: () => {
      if (released) return;
      released = true;
      held.refs -= 1;
      if (held.refs > 0) return;
      if (entries.get(sha256) === held) entries.delete(sha256);
      if (held.url) URL.revokeObjectURL(held.url);
    },
  };
}
