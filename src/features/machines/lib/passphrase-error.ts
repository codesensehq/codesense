// SPDX-License-Identifier: MIT
import { getErrorMessage } from "@/shared/lib/error-message";

/** With no secret store the app already says it in full ("Can't save the passphrase: no
 *  Secret Service is running. …"); any other failure is named for what it stopped. */
export const passphraseSaveError = (e: unknown): string => {
  const message = getErrorMessage(e);
  return message.startsWith("Can't save the passphrase")
    ? message
    : `Couldn't keep the passphrase: ${message}`;
};
