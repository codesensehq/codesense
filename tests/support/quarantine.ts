// SPDX-License-Identifier: MIT
import {
  loadEntries,
  quarantineApplies,
  validEntries,
  quarantineReason as formatReason,
} from "../../scripts/lib/quarantine.mjs";

const entries = loadEntries();

// `project` is the Playwright project; an entry that names projects covers only those.
export function quarantineReason(id: string, project?: string): string | undefined {
  const entry = validEntries(entries).find(
    (entry) => entry.id === id && (project === undefined || quarantineApplies(entry, project)),
  );
  return entry ? formatReason(entry) : undefined;
}
