// SPDX-License-Identifier: MIT
import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { PositionedMenuItem } from "@/shared/components/positioned-context-menu";
import { CapabilityOffControl } from "@/shared/components/capability-off/capability-off";
import { notYetAvailableSentence, useCapability } from "@/shared/lib/capabilities";

/**
 * A context menu's Export to PDF item. Where this OS can't export (`pdf-export` off) it stays in
 * the menu, focusable but inert, and says why under its label. The sentence sits inside the item,
 * since a menu's children are its items; only the label is dimmed, so the sentence stays readable,
 * and the item is named by its label alone, so the sentence is read once, as its description.
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
  const labelId = useId();
  const noteId = useId();
  const capability = useCapability("pdf-export");
  if (capability.on)
    return (
      <PositionedMenuItem className={className} onClick={onClick}>
        {children}
      </PositionedMenuItem>
    );
  return (
    <CapabilityOffControl cap="pdf-export" noteId={noteId} dim={false}>
      <PositionedMenuItem
        className={cn(className, "group flex flex-col items-start")}
        // An unavailable item the menu's arrow keys still reach, so its reason can be read.
        data-focusable-disabled
        aria-labelledby={labelId}
        onClick={onClick}
      >
        <span id={labelId} className="flex w-full items-center justify-between gap-4 opacity-50">
          {children}
        </span>
        {/* On keyboard focus the item takes the accent background; the sentence follows its ink. */}
        <span
          id={noteId}
          className="block max-w-64 text-xs text-muted-foreground group-focus-visible:text-accent-foreground"
        >
          {notYetAvailableSentence(capability)}
        </span>
      </PositionedMenuItem>
    </CapabilityOffControl>
  );
}
