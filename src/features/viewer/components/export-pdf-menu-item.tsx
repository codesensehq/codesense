// SPDX-License-Identifier: MIT
import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { PositionedMenuItem } from "@/shared/components/positioned-context-menu";
import { CapabilityOffControl } from "@/shared/components/capability-off/capability-off";
import { notYetAvailableSentence, useCapability } from "@/shared/lib/capabilities";

/**
 * A context menu's Export to PDF item. Where this OS can't export (`pdf-export` off) it stays in
 * the menu, focusable but inert, and says why under its label. The sentence sits inside the item,
 * since a menu's children are its items.
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
  const capability = useCapability("pdf-export");
  const off = !capability.on;
  return (
    <CapabilityOffControl cap="pdf-export" noteId={noteId}>
      <PositionedMenuItem
        className={cn(className, off && "flex flex-col items-start")}
        // An unavailable item the menu's arrow keys still reach, so its reason can be read.
        data-focusable-disabled={off ? true : undefined}
        onClick={onClick}
      >
        {children}
        {off && (
          <span id={noteId} className="block max-w-64 text-xs text-muted-foreground">
            {notYetAvailableSentence(capability)}
          </span>
        )}
      </PositionedMenuItem>
    </CapabilityOffControl>
  );
}
