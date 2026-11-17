// SPDX-License-Identifier: MIT
import {
  TYPED_ERROR_PREFIX,
  getErrorMessage,
  userFacingErrorMessage,
} from "@/shared/lib/error-message";

/** With no secret store the app answers with a typed `unavailable:` error whose sentence already
 *  says it in full; any other failure is named for what it stopped. */
export const passphraseSaveError = (e: unknown): string =>
  TYPED_ERROR_PREFIX.test(getErrorMessage(e))
    ? userFacingErrorMessage(e)
    : `Couldn't keep the passphrase: ${getErrorMessage(e)}`;
