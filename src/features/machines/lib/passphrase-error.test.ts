import { describe, expect, it } from "vitest";
import { passphraseSaveError } from "./passphrase-error";

describe("passphraseSaveError", () => {
  it("shows the no-secret-store message as it is", () => {
    const message =
      "Can't save the passphrase: no Secret Service is running. You'll be asked again next time.";
    expect(passphraseSaveError(message)).toBe(message);
  });

  it("names any other failure", () => {
    expect(passphraseSaveError("the passphrase dialog failed: x")).toBe(
      "Couldn't keep the passphrase: the passphrase dialog failed: x",
    );
  });
});
