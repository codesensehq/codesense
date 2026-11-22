// SPDX-License-Identifier: MIT
import { formatKeystrokeDisplay } from "@/shared/lib/shortcuts/keystroke";
import { useEffectiveShortcut } from "@/shared/stores/shortcuts-store";

/** A shortcut action's effective chord as a notes `<kbd>`; nothing when it is unbound. */
export function ActionKbd({ action }: { action: string }): React.JSX.Element | null {
  const shown = formatKeystrokeDisplay(useEffectiveShortcut(action));
  return shown ? <kbd className="nt-kbd">{shown}</kbd> : null;
}
