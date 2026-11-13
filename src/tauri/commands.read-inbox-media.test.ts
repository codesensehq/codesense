// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { readInboxMedia } from "./commands";

const team = { org: "acme", team: "core" };
const SHA = "a".repeat(64);

/** The host's frame: the MIME, a newline, then the bytes, as one ArrayBuffer. */
function frame(mime: string, bytes: number[]): ArrayBuffer {
  const head = new TextEncoder().encode(`${mime}\n`);
  const out = new Uint8Array(head.length + bytes.length);
  out.set(head);
  out.set(bytes, head.length);
  return out.buffer;
}

describe("readInboxMedia", () => {
  beforeEach(() => invokeMock.mockReset());

  it("reads the frame as a Blob typed by its MIME, keeping a newline inside the bytes", async () => {
    const bytes = [0x47, 0x49, 0x46, 0x0a, 0x0a, 0x00, 0xff];
    invokeMock.mockResolvedValue(frame("image/gif", bytes));
    const blob = await readInboxMedia(team, 7, SHA);
    expect(invokeMock).toHaveBeenCalledWith("read_inbox_media", {
      team,
      messageId: 7,
      sha256: SHA,
    });
    expect(blob.type).toBe("image/gif");
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual(bytes);
  });

  it("refuses a frame with no newline", async () => {
    invokeMock.mockResolvedValue(new TextEncoder().encode("image/gif").buffer);
    await expect(readInboxMedia(team, 7, SHA)).rejects.toThrow("media unavailable");
  });
});
