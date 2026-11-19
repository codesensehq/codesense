// SPDX-License-Identifier: MIT
/**
 * How a feature that isn't on this OS yet explains itself, driven only by its capability key.
 * Every variant renders the one sentence `Not yet available on <OS>: <reason>.`
 * (`notYetAvailableSentence`), with the reason from `platform-caps.json`; with the capability on,
 * each renders exactly what it would without it. See `README.md` in this folder.
 */
import { cloneElement, type ReactElement, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  notYetAvailableSentence,
  useCapability,
  type CapabilityKey,
} from "@/shared/lib/capabilities";

/**
 * The panel or state: `children` while `cap` is on; when it is off, `off(sentence)` (a surface
 * that frames the sentence its own way, such as a panel subtitle), or else the note.
 */
export function CapabilityOff({
  cap,
  children,
  off,
}: {
  cap: CapabilityKey;
  children?: ReactNode;
  off?: (sentence: string) => ReactNode;
}) {
  const capability = useCapability(cap);
  if (capability.on) return <>{children}</>;
  return off ? <>{off(notYetAvailableSentence(capability))}</> : <CapabilityOffNote cap={cap} />;
}

/** The quiet `ⓘ` note with the sentence; the `id` is what `CapabilityOffControl`s point at. */
export function CapabilityOffNote({
  cap,
  id,
  className,
}: {
  cap: CapabilityKey;
  id?: string;
  className?: string;
}) {
  const capability = useCapability(cap);
  if (capability.on) return null;
  return (
    <p
      id={id}
      role="note"
      data-capability-off={cap}
      className={cn("text-[11px] text-muted-foreground", className)}
    >
      <span aria-hidden="true">ⓘ </span>
      {notYetAvailableSentence(capability)}
    </p>
  );
}

/** What `CapabilityOffControl` sets on its control. */
interface ControlProps {
  onClick?: (event?: { preventDefault(): void }) => void;
  onSelect?: (event?: { preventDefault(): void }) => void;
  className?: string;
  title?: string;
  "aria-disabled"?: boolean;
  "aria-describedby"?: string;
}

/** Does nothing, and stops what the element would do on its own (a submit, a link, a menu
 *  item's close). */
function inert(event?: { preventDefault(): void }): void {
  event?.preventDefault();
}

/**
 * The disabled control with a note: while `cap` is off, the one child control stays visible and
 * focusable but does nothing (`aria-disabled`), names the sentence in its tooltip and is described
 * by the `CapabilityOffNote` whose id is `noteId`. The child is a button, a link or a menu item
 * whose action is its `onClick` or `onSelect`: both are replaced, and their default action is
 * prevented. A control that acts through any other handler doesn't belong here.
 */
export function CapabilityOffControl({
  cap,
  noteId,
  children,
}: {
  cap: CapabilityKey;
  noteId: string;
  children: ReactElement<ControlProps>;
}) {
  const capability = useCapability(cap);
  if (capability.on) return children;
  return cloneElement(children, {
    onClick: inert,
    ...(children.props.onSelect ? { onSelect: inert } : {}),
    title: notYetAvailableSentence(capability),
    "aria-disabled": true,
    "aria-describedby": noteId,
    className: cn(
      children.props.className,
      "cursor-default opacity-50 hover:bg-transparent hover:text-current",
    ),
  });
}

/**
 * The inline amber notice, for a feature that still works with less: what changes
 * (`children`), then the sentence. `className` replaces the default look, for a list that styles
 * its own items.
 */
export function CapabilityOffNotice({
  cap,
  children,
  as: Tag = "div",
  className,
}: {
  cap: CapabilityKey;
  children?: ReactNode;
  as?: "div" | "li" | "p";
  className?: string;
}) {
  const capability = useCapability(cap);
  if (capability.on) return null;
  return (
    <Tag
      data-code={`capability-${cap}`}
      data-capability-off={cap}
      className={
        className ??
        "flex items-start gap-1.5 rounded-md bg-warning-wash px-2 py-1 text-xs text-warning-ink"
      }
    >
      <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0">
        {children}
        {children ? " " : null}
        {notYetAvailableSentence(capability)}
      </span>
    </Tag>
  );
}
