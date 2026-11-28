// SPDX-License-Identifier: MIT
/**
 * The one tab bar every tile shows, with one tab or five: each tab's kind icon, its name and an
 * optional team chip, then + New tab, then the active tab's own controls, ⋯ and ✕. Built from
 * `TerminalTabBar`'s strip (the tablist keys, middle-click close, drag to reorder, the press that
 * never starts a tile drag) for any kind. The bar is a sibling of the tile's body, so a tab
 * added or closed redraws the bar only.
 *
 * A name truncates before its chip, which never shrinks. A cut-off name keeps its full text as
 * the tab's tooltip and accessible name.
 */
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Bot,
  BookOpen,
  FileText,
  GitCompare,
  Inbox,
  LayoutDashboard,
  MoreHorizontal,
  Plus,
  StickyNote,
  TerminalSquare,
  X,
} from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InfoTip } from "@/components/ui/tooltip";
import { hasAnyModifier, isCloseKey } from "@/shared/lib/shortcuts/keystroke";
import type { TileKind } from "@/shared/tiling/tile-kinds";

import { MiddleTruncate } from "./middle-truncate";

export interface TileTab {
  key: string;
  kind: TileKind;
  /** The name the tab shows. */
  name: string;
  /** The tab's full text, its tooltip and accessible name. Default `name`. */
  fullName?: string;
  /** In place of the kind's icon (an agent's face, an HTML file's glyph). */
  icon?: ReactNode;
  /** The tab's team chip, for a tab from another team. Never shrinks. */
  chip?: ReactNode;
  /** A mark after the name (an unread count, a stage pill). */
  badge?: ReactNode;
}

export interface TileTabBarProps {
  tabs: readonly TileTab[];
  activeKey: string;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onReorder?: (from: number, to: number) => void;
  /** + New tab. Unset, the button is not drawn. */
  onNewTab?: () => void;
  /** After the tabs, before the controls: the active tab's identity (a folder, a source). */
  identity?: ReactNode;
  /** The active tab's own controls, at the right before ⋯. */
  controls?: ReactNode;
  /** The ⋯ menu's items. Unset, ⋯ is not drawn. */
  menu?: ReactNode;
}

const KIND_ICONS: Record<TileKind, typeof FileText> = {
  dashboard: LayoutDashboard,
  file: FileText,
  story: BookOpen,
  diff: GitCompare,
  notes: StickyNote,
  inbox: Inbox,
  agent: Bot,
  shell: TerminalSquare,
};

const ICON_SIZE = 12;

export function TileTabBar({
  tabs,
  activeKey,
  onSelect,
  onClose,
  onReorder,
  onNewTab,
  identity,
  controls,
  menu,
}: TileTabBarProps) {
  const pillRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const drag = useRef<{ from: number; startX: number; rects: (DOMRect | null)[] } | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const activeIdx = tabs.findIndex((t) => t.key === activeKey);
  const stopKey = tabs.some((t) => t.key === focusedKey)
    ? focusedKey
    : (tabs[activeIdx]?.key ?? tabs[0]?.key);
  const active = tabs[activeIdx];
  const activeName = active ? (active.fullName ?? active.name) : "";

  const onPillKeyDown = (e: KeyboardEvent<HTMLButtonElement>, tab: TileTab, idx: number) => {
    // Any chord belongs to the global shortcuts.
    if (hasAnyModifier(e)) return;
    if (isCloseKey(e)) {
      e.preventDefault();
      e.stopPropagation();
      pillRefs.current[idx + 1 < tabs.length ? idx + 1 : idx - 1]?.focus();
      onClose(tab.key);
      return;
    }
    const last = tabs.length - 1;
    const targets: Record<string, number> = {
      ArrowRight: idx === last ? 0 : idx + 1,
      ArrowLeft: idx === 0 ? last : idx - 1,
      Home: 0,
      End: last,
    };
    const to = targets[e.key];
    if (to === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    pillRefs.current[to]?.focus();
  };

  const endDrag = () => {
    drag.current = null;
    setDragOver(null);
    setDragFrom(null);
  };

  return (
    <div
      data-testid="tile-tab-bar"
      className="flex h-8 min-w-0 flex-shrink-0 items-end gap-1 border-b border-border bg-muted/40 pl-1 pr-1 select-none"
      // A press anywhere on the bar belongs to the bar (reorder, its buttons), never a tile drag.
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => {
        const state = drag.current;
        if (!state || Math.abs(e.clientX - state.startX) < 5) return;
        const at = state.rects.findIndex((r) => r && e.clientX >= r.left && e.clientX <= r.right);
        if (at >= 0) setDragOver(at);
      }}
      onPointerUp={() => {
        const state = drag.current;
        if (state && dragOver !== null && dragOver !== state.from)
          onReorder?.(state.from, dragOver);
        endDrag();
      }}
      onPointerLeave={endDrag}
    >
      <div role="tablist" aria-label="Tabs in this tile" className="flex min-w-0 items-end">
        {tabs.map((tab, idx) => {
          const isActive = tab.key === activeKey;
          const full = tab.fullName ?? tab.name;
          const Icon = KIND_ICONS[tab.kind];
          return (
            <div
              key={tab.key}
              role="presentation"
              data-tile-tab={tab.key}
              className={`group relative flex min-w-0 items-end ${dragOver === idx && dragFrom !== idx ? "border-l-2 border-accent" : ""}`}
            >
              <button
                ref={(el) => {
                  pillRefs.current[idx] = el;
                }}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-label={full}
                title={full}
                tabIndex={tab.key === stopKey ? 0 : -1}
                data-active={isActive ? "true" : "false"}
                className={`flex min-w-0 items-center gap-1.5 pl-2.5 pr-7 text-xs transition-colors ${
                  isActive
                    ? "relative z-10 -mb-px h-7 rounded-t-md border-x border-t border-border bg-background font-medium text-foreground"
                    : "mx-0.5 mb-0.5 h-6 text-muted-foreground hover:rounded-md hover:bg-foreground/5 hover:text-foreground"
                }`}
                onClick={() => onSelect(tab.key)}
                onFocus={() => setFocusedKey(tab.key)}
                onBlur={() => setFocusedKey(null)}
                onKeyDown={(e) => onPillKeyDown(e, tab, idx)}
                onPointerDown={(e) => {
                  if (e.button === 0 && onReorder) {
                    drag.current = {
                      from: idx,
                      startX: e.clientX,
                      rects: pillRefs.current.map((el) => el?.getBoundingClientRect() ?? null),
                    };
                    setDragFrom(idx);
                  }
                  if (e.button === 1) {
                    e.preventDefault();
                    onClose(tab.key);
                  }
                }}
              >
                <span className="flex flex-shrink-0 items-center" aria-hidden>
                  {tab.icon ?? <Icon size={ICON_SIZE} className="opacity-70" />}
                </span>
                <MiddleTruncate data-tile-tab-name="" text={tab.name} className="min-w-0" />
                {tab.badge && <span className="flex flex-shrink-0 items-center">{tab.badge}</span>}
                {tab.chip && (
                  <span data-tile-tab-chip="" className="flex flex-shrink-0 items-center">
                    {tab.chip}
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-hidden
                tabIndex={-1}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => onClose(tab.key)}
                className="absolute right-1 bottom-0.5 z-20 flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 hover:text-foreground"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>
      {onNewTab && (
        <InfoTip label="New tab" side="top">
          <button
            type="button"
            aria-label="New tab"
            aria-haspopup="dialog"
            onClick={onNewTab}
            className="mb-0.5 flex h-6 w-6 flex-shrink-0 items-center justify-center self-center rounded text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          >
            <Plus size={ICON_SIZE} />
          </button>
        </InfoTip>
      )}
      {identity && (
        <span
          data-tile-identity=""
          className="mb-1 flex min-w-0 items-center text-xs text-muted-foreground"
        >
          {identity}
        </span>
      )}
      <div
        data-tile-controls=""
        className="mb-0.5 ml-auto flex flex-shrink-0 items-center gap-0.5 self-center"
      >
        {controls}
        {menu && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`More for ${activeName}`}
                className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
              >
                <MoreHorizontal size={ICON_SIZE} />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{menu}</DropdownMenuContent>
          </DropdownMenu>
        )}
        {active && (
          <button
            type="button"
            aria-label={`Close ${activeName}`}
            onClick={() => onClose(active.key)}
            className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
          >
            <X size={ICON_SIZE} />
          </button>
        )}
      </div>
    </div>
  );
}
