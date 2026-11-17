// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { passphraseSaveError } from "./passphrase-error";

describe("passphraseSaveError", () => {
  it("shows the no-secret-store message as it is", () => {
    expect(
      passphraseSaveError(
        "unavailable: Can't save the passphrase: no Secret Service is running. You'll be asked again next time.",
      ),
    ).toBe(
      "Can't save the passphrase: no Secret Service is running. You'll be asked again next time.",
    );
  });

  it("names any other failure", () => {
    expect(passphraseSaveError("the passphrase dialog failed: x")).toBe(
      "Couldn't keep the passphrase: the passphrase dialog failed: x",
    );
  });
});
