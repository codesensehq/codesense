// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState } from "react";
import { XIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  dismissStatusLine,
  pauseStatusLine,
  resumeStatusLine,
  runStatusLineAction,
  type StatusLineEntry,
} from "@/shared/stores/status-line-store";

/**
 * "+N waiting ▾": the menu of offers waiting behind the status line's current line, each with
 * its action and a ✕ to dismiss it. Running an action or ✕ removes that offer; the menu closes
 * when none is left. The current line's timer is paused while the menu is open.
 */
export function StatusLineWaitingMenu({ waiting }: { waiting: readonly StatusLineEntry[] }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // Where focus goes when the last offer leaves and the button with it: the line's own action.
  const fallback = useRef<HTMLElement | null>(null);
  const count = waiting.length;

  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (next) pauseStatusLine("menu");
    else resumeStatusLine("menu");
  };

  useEffect(
    () => () => {
      resumeStatusLine("menu");
      if (fallback.current?.isConnected) fallback.current.focus();
    },
    [],
  );

  const remove = (e: Event, run: () => void) => {
    // The menu stays open while other offers wait.
    if (count > 1) e.preventDefault();
    else
      fallback.current =
        trigger.current?.closest('[role="group"]')?.querySelector<HTMLElement>("button") ?? null;
    run();
  };

  // An offer that ran or was dismissed leaves the menu: keep focus in it, on the first item.
  useEffect(() => {
    if (!open) return;
    const menu = content.current;
    if (menu && !menu.contains(document.activeElement))
      menu.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open, count]);

  return (
    // Not modal: a modal menu hides the rest of the page from assistive tech, the live region too.
    <DropdownMenu modal={false} open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger
        ref={trigger}
        className="flex-shrink-0 rounded px-1 font-semibold text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        +{count} waiting ▾
      </DropdownMenuTrigger>
      <DropdownMenuContent
        ref={content}
        data-status-line-menu=""
        align="end"
        aria-label="Waiting in the status line"
        className="min-w-64"
      >
        {waiting.map((offer) => (
          <div key={offer.id} className="flex items-center gap-1">
            <DropdownMenuItem
              className="min-w-0 flex-1"
              onSelect={(e) =>
                remove(e, () =>
                  offer.action ? runStatusLineAction(offer.id) : dismissStatusLine(offer.id),
                )
              }
            >
              <span className="min-w-0 flex-1 truncate">{offer.text}</span>{" "}
              {offer.action && (
                <span className="font-semibold text-primary">{offer.action.label}</span>
              )}
            </DropdownMenuItem>
            <DropdownMenuItem
              aria-label={`Dismiss ${offer.text}`}
              onSelect={(e) => remove(e, () => dismissStatusLine(offer.id))}
            >
              <XIcon aria-hidden="true" />
            </DropdownMenuItem>
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
