// SPDX-License-Identifier: MIT
import { LicenseLink } from "./LicenseLink";

import type { LicenseView } from "./api";
import { downloadUrl } from "./channel";
import { COPY } from "./copy";

const ATTENTION_TEXT = {
  not_writable: COPY.updateNotWritable,
  package_manager: COPY.updatePackageManager,
  failing: COPY.updateFailing,
  install_failed: COPY.updateInstallFailed,
} as const;

/**
 * SW-PB-13: the line that says the next build has to be installed by hand. Shown when the app
 * can't replace itself, when downloads keep failing, when this build gets no updates at all,
 * and when a staged build can't be installed by Restart to update (SW-PB-23). SV-PBF-278: it
 * points to the public download, never to the beta-tester pages. A `.deb` or `.rpm` install
 * says to update through the package manager, with no download link. Nothing while none of
 * those holds.
 */
export function UpdateByHand({ view, testIdPrefix }: { view: LicenseView; testIdPrefix: string }) {
  const reason = view.updates_off
    ? { text: COPY.updatesOff, id: "updates-off", link: true }
    : view.update_attention &&
        view.update_attention !== "records_unwritable" &&
        (!view.update || view.update_attention === "install_failed")
      ? {
          text: ATTENTION_TEXT[view.update_attention],
          id: "update-by-hand",
          // The package manager is the way to update a `.deb` or `.rpm` install.
          link: view.update_attention !== "package_manager",
        }
      : view.update && view.restart_ready === false
        ? // SW-PB-23: a staged build the app can't install itself now.
          { text: COPY.updateCantInstall, id: "update-by-hand", link: true }
        : null;
  if (!reason) return null;
  return (
    <p className="text-sm text-muted-foreground" data-testid={`${testIdPrefix}-${reason.id}`}>
      {reason.text}
      {reason.link && (
        <>
          {" "}
          <LicenseLink
            href={downloadUrl()}
            label={COPY.downloadLatest}
            testId={`${testIdPrefix}-update-download`}
          />
          .
        </>
      )}
    </p>
  );
}
