// SPDX-License-Identifier: MIT
import { useMemo } from "react";
import { APPEARANCE_ROW_SPECS } from "./appearance-section";
import type { LucideIcon } from "lucide-react";
import {
  Settings,
  Keyboard,
  GitBranch,
  Users,
  User,
  UserCircle,
  Waypoints,
  FileX,
} from "lucide-react";

import { InfoTip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { WORKSPACE_ROW_SPECS } from "@/features/settings/components/workspace-section/lib/workspace-row-specs";
import type { SectionKey } from "@/features/settings/lib/types";
import { rowMatches, type SettingRowSpec } from "@/features/settings/lib/row-matches";
import { DASHBOARDS_SECTION_SPEC } from "./dashboards-section";
import { useGeneralRowSpecs } from "./general-section";
import { IDENTITY_SECTION_SPECS } from "./identity-section";
import { REPO_SECTION_SPEC } from "./repo-section";
import { useShortcutRowSpecs } from "./shortcuts-section";
import { ACCOUNT_SECTION_SPEC } from "./account-section";
import { PHASES_SECTION_SPEC } from "./phases-section/phases-section";
import { PROJECTION_EXCLUDES_SECTION_SPEC } from "./projection-excludes-section";

// ---------- Section nav registry ----------

export interface SectionNavItem {
  key: SectionKey;
  label: string;
  icon: LucideIcon;
}

export const SECTION_NAV_ITEMS: SectionNavItem[] = [
  { key: "general", label: "General", icon: Settings },
  { key: "appearance", label: "Appearance", icon: Settings },
  { key: "dashboards", label: "Dashboards", icon: Settings },
  { key: "identity", label: "Identity", icon: UserCircle },
  { key: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { key: "repo", label: "Repo", icon: GitBranch },
  { key: "workspace", label: "Workspace", icon: Users },
  { key: "phases", label: "Phases", icon: Waypoints },
  { key: "projection-excludes", label: "Excluded paths", icon: FileX },
  { key: "account", label: "Local profile", icon: User },
];

// ---------- Section content matching ----------

/** The sections whose rows follow live state: General's and Shortcuts' depend on this OS's
 *  capabilities, and dashboard commands come and go with the slot dashboards. */
type LiveSection = "general" | "shortcuts";
export type LiveSectionSpecs = Record<LiveSection, readonly SettingRowSpec[]>;

/** The row specs of the live sections, for `sectionHasContent`. */
export function useLiveSectionSpecs(): LiveSectionSpecs {
  const general = useGeneralRowSpecs();
  const shortcuts = useShortcutRowSpecs();
  return useMemo(() => ({ general, shortcuts }), [general, shortcuts]);
}

/** Maps each section to the row specs that determine whether it has
 *  visible content for a given query. The sidebar dims sections where
 *  no row spec matches — ensuring the enabled state reflects actual
 *  content, not a static keyword approximation. The live sections aren't here: callers pass
 *  `useLiveSectionSpecs()` to `sectionHasContent`, so their hidden rows never match. */
const SECTION_ROW_SPECS: Record<Exclude<SectionKey, LiveSection>, readonly SettingRowSpec[]> = {
  appearance: APPEARANCE_ROW_SPECS,
  dashboards: [DASHBOARDS_SECTION_SPEC],
  identity: IDENTITY_SECTION_SPECS,
  repo: [REPO_SECTION_SPEC],
  workspace: WORKSPACE_ROW_SPECS,
  phases: [PHASES_SECTION_SPEC],
  "projection-excludes": [PROJECTION_EXCLUDES_SECTION_SPEC],
  account: [ACCOUNT_SECTION_SPEC],
};

/** Returns true if the section has at least one row that matches the query. `liveSpecs`
 *  comes from `useLiveSectionSpecs`, so General's and Shortcuts' hidden rows never match. */
export function sectionHasContent(
  key: SectionKey,
  query: string,
  liveSpecs: LiveSectionSpecs,
): boolean {
  if (!query.trim()) return true;
  const specs = key === "general" || key === "shortcuts" ? liveSpecs[key] : SECTION_ROW_SPECS[key];
  return specs.some((spec) => rowMatches(spec, query));
}

// ---------- Component ----------

interface SettingsSidebarProps {
  activeSection: SectionKey;
  onSectionChange: (key: SectionKey) => void;
  query: string;
  collapsed: boolean;
}

export function SettingsSidebar({
  activeSection,
  onSectionChange,
  query,
  collapsed,
}: SettingsSidebarProps) {
  const liveSpecs = useLiveSectionSpecs();
  const enabledItems = SECTION_NAV_ITEMS.map((item) => ({
    ...item,
    enabled: sectionHasContent(item.key, query, liveSpecs),
  }));

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const isNext = e.key === "ArrowDown";
    const isPrev = e.key === "ArrowUp";
    const isHome = e.key === "Home";
    const isEnd = e.key === "End";
    if (!isNext && !isPrev && !isHome && !isEnd) return;
    e.preventDefault();

    const enabled = enabledItems.filter((i) => i.enabled);
    if (enabled.length === 0) return;

    const currentIdx = enabled.findIndex((i) => i.key === activeSection);
    const last = enabled.length - 1;
    let nextIdx = currentIdx;
    if (isNext) nextIdx = currentIdx < 0 ? 0 : currentIdx >= last ? 0 : currentIdx + 1;
    else if (isPrev) nextIdx = currentIdx <= 0 ? last : currentIdx - 1;
    else if (isHome) nextIdx = 0;
    else if (isEnd) nextIdx = last;

    const next = enabled[nextIdx];
    if (!next) return;
    onSectionChange(next.key);

    const container = e.currentTarget;
    const btn = container.querySelector<HTMLButtonElement>(
      `[data-testid="settings-nav-${next.key}"]`,
    );
    btn?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Settings sections"
      aria-orientation="vertical"
      onKeyDown={onKeyDown}
      className={cn(
        "shrink-0 border-r border-border bg-muted/30 py-2",
        collapsed ? "w-[48px]" : "w-[150px]",
      )}
    >
      {enabledItems.map((item) => {
        const isActive = activeSection === item.key;

        const button = (
          <button
            key={item.key}
            type="button"
            role="tab"
            id={`settings-tab-${item.key}`}
            aria-selected={isActive}
            aria-controls="settings-tabpanel"
            aria-label={item.label}
            aria-disabled={!item.enabled || undefined}
            tabIndex={isActive ? 0 : -1}
            data-testid={`settings-nav-${item.key}`}
            onClick={() => {
              if (item.enabled) onSectionChange(item.key);
            }}
            className={cn(
              "flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors",
              isActive
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
              !item.enabled && "pointer-events-none opacity-40",
            )}
          >
            <item.icon size={16} aria-hidden="true" className="shrink-0" />
            <span className={cn("truncate", collapsed && "sr-only")}>{item.label}</span>
          </button>
        );

        if (collapsed) {
          return (
            <InfoTip key={item.key} label={item.label} side="right">
              {button}
            </InfoTip>
          );
        }

        return button;
      })}
    </div>
  );
}
