// SPDX-License-Identifier: MIT
import { useId, type ReactNode } from "react";

import { PositionedMenuItem } from "@/shared/components/positioned-context-menu";
import {
  CapabilityOffControl,
  CapabilityOffNote,
} from "@/shared/components/capability-off/capability-off";
import { useCapability } from "@/shared/lib/capabilities";

/**
 * A context menu's Export to PDF item. Where this OS can't export (`pdf-export` off) it stays in
 * the menu, focusable but inert, and the note under it says why.
 */
export function ExportPdfMenuItem({
  onClick,
  className,
  children,
}: {
  onClick: () => void;
  className?: string;
  children: ReactNode;
}) {
  const noteId = useId();
  const on = useCapability("pdf-export").on;
  return (
    <>
      <CapabilityOffControl cap="pdf-export" noteId={noteId}>
        <PositionedMenuItem
          className={className}
          // An unavailable item the menu's arrow keys still reach, so its reason can be read.
          data-focusable-disabled={on ? undefined : true}
          onClick={onClick}
        >
          {children}
        </PositionedMenuItem>
      </CapabilityOffControl>
      <CapabilityOffNote cap="pdf-export" id={noteId} className="max-w-64 px-2 pb-1" />
    </>
  );
}
