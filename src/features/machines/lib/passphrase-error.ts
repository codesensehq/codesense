// SPDX-License-Identifier: MIT
import { getErrorMessage, userFacingErrorMessage } from "@/shared/lib/error-message";

/** With no secret store the app answers with a typed `unavailable:` error whose sentence already
 *  says it in full; any other failure, typed or not, is named for what it stopped. */
const NO_SECRET_STORE = /^unavailable:\s/;

export const passphraseSaveError = (e: unknown): string =>
  NO_SECRET_STORE.test(getErrorMessage(e))
    ? userFacingErrorMessage(e)
    : `Couldn't keep the passphrase: ${getErrorMessage(e)}`;
