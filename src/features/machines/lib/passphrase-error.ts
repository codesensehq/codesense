// SPDX-License-Identifier: MIT
import { getErrorMessage, userFacingErrorMessage } from "@/shared/lib/error-message";

const NO_SECRET_STORE = /^unavailable:\s/;

/** With no secret store the app answers with a typed `unavailable:` error whose sentence already
 *  says it in full; any other failure, typed or not, is named for what it stopped. */
export const passphraseSaveError = (e: unknown): string =>
  NO_SECRET_STORE.test(getErrorMessage(e))
    ? userFacingErrorMessage(e)
    : `Couldn't keep the passphrase: ${getErrorMessage(e)}`;
