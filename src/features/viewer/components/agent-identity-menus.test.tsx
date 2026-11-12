// SPDX-License-Identifier: MIT
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AvatarPacks } from "@/shared/hooks/use-avatar-packs";

import {
  CONTEXT_MENU_KIT,
  DROPDOWN_MENU_KIT,
  FaceChoices,
  type IdentityMenuKit,
} from "./agent-identity-menus";

afterEach(cleanup);

const avatars = {
  packs: [
    { id: "mine", name: "My Pack", scope: "personal", faces: [] },
    { id: "yard", name: "Yard Crew", scope: "team", faces: [] },
  ],
  defaultPack: null,
  warnings: [],
  canShare: true,
  sharePack: vi.fn(),
  setDefaultPack: vi.fn(),
} as unknown as AvatarPacks;

const face = (kit: IdentityMenuKit) => (
  <FaceChoices kit={kit} choice={undefined} avatars={avatars} onChoose={() => {}} />
);

// Happy-dom can't resolve colours, so these assert the classes the real menu parts render.
const MENUS = {
  "context menu": () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger>
          <div>target</div>
        </ContextMenuTrigger>
        <ContextMenuContent>{face(CONTEXT_MENU_KIT)}</ContextMenuContent>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText("target"));
  },
  "dropdown menu": () => {
    render(
      <DropdownMenu open>
        <DropdownMenuTrigger>target</DropdownMenuTrigger>
        <DropdownMenuContent>{face(DROPDOWN_MENU_KIT)}</DropdownMenuContent>
      </DropdownMenu>,
    );
  },
};

for (const [name, open] of Object.entries(MENUS)) {
  it(`${name}: 'only you' takes the overlay muted ink, and the row's ink when highlighted`, async () => {
    open();
    const only = await screen.findByText("· only you");
    expect(only).toHaveClass("text-muted-foreground");
    expect(only).toHaveClass("group-focus/identity-pack:text-accent-foreground");
    expect(only).toHaveClass("group-data-open/identity-pack:text-accent-foreground");
    expect(screen.getByRole("menuitem", { name: /My Pack/ })).toHaveClass("group/identity-pack");
  });

  it(`${name}: the team default hint keeps only the kit label's muted ink`, async () => {
    open();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Team default pack" }));
    const hint = await screen.findByText(/Agents nobody gave a face/);
    expect(hint).toHaveClass("text-muted-foreground");
    expect(hint.className.match(/(?:^|\s)text-(?!\[11px\]|muted-foreground)\S+/g)).toBeNull();
    expect(hint.className).not.toContain("--ag-faint");
  });

  it(`${name}: no pane-scoped --ag-faint variable remains`, async () => {
    open();
    await screen.findByText("· only you");
    expect(document.body.innerHTML).not.toContain("--ag-faint");
  });
}
