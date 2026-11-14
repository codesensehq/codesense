// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";

import { acquireMediaUrl } from "./media-urls";

beforeEach(() => {
  URL.createObjectURL = vi.fn(() => "blob:a");
  URL.revokeObjectURL = vi.fn();
});

describe("acquireMediaUrl", () => {
  it("drops a failed read, so the next view reads again", async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error("media unavailable"));
    const first = acquireMediaUrl("1".repeat(64), read);
    await expect(first.url).rejects.toThrow("media unavailable");
    read.mockResolvedValue(new Blob(["GIF89a"]));
    const second = acquireMediaUrl("1".repeat(64), read);
    await expect(second.url).resolves.toBe("blob:a");
    expect(read).toHaveBeenCalledTimes(2);
    first.release();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    second.release();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:a");
  });

  it("revokes a URL whose last view went before the read finished", async () => {
    let finish: (blob: Blob) => void = () => {};
    const hold = acquireMediaUrl(
      "2".repeat(64),
      () => new Promise<Blob>((resolve) => (finish = resolve)),
    );
    hold.release();
    hold.release();
    finish(new Blob(["GIF89a"]));
    await hold.url;
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
