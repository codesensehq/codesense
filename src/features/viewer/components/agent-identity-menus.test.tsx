// SPDX-License-Identifier: MIT
import type { ReactNode } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { FaceChoices, type IdentityMenuKit } from "./agent-identity-menus";
import type { AvatarPacks } from "@/shared/hooks/use-avatar-packs";

afterEach(cleanup);

// Plain elements stand in for the Radix menu parts: the classes `FaceChoices` passes are what
// is under test, and happy-dom can't resolve colours.
const Plain = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <div className={className}>{children}</div>
);
const kit: IdentityMenuKit = {
  Shortcut: Plain,
  Sub: Plain,
  SubTrigger: ({ children, className }) => (
    <div data-testid="trigger" className={className}>
      {children}
    </div>
  ),
  SubContent: Plain,
  RadioGroup: Plain,
  RadioItem: Plain,
  Separator: () => <hr />,
  Label: ({ children, className }) => (
    <div data-testid="label" className={className}>
      {children}
    </div>
  ),
  Item: Plain,
};

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

function renderFace() {
  return render(<FaceChoices kit={kit} choice={undefined} avatars={avatars} onChoose={() => {}} />);
}

it("sets 'only you' in the overlay muted ink, flipping to the row's ink when highlighted", () => {
  renderFace();
  const only = screen.getByText("· only you");
  expect(only).toHaveClass("text-muted-foreground");
  expect(only).toHaveClass("group-focus/identity-pack:text-accent-foreground");
  expect(only).toHaveClass("group-data-open/identity-pack:text-accent-foreground");
  expect(only.closest("[data-testid=trigger]")).toHaveClass("group/identity-pack");
});

it("leaves the team default pack hint to the kit's muted label ink", () => {
  renderFace();
  const hint = screen.getByText(/Agents nobody gave a face/);
  expect(hint.className).not.toMatch(/text-\[var/);
});

it("uses no pane-scoped --ag-faint variable", () => {
  const { container } = renderFace();
  expect(container.innerHTML).not.toContain("--ag-faint");
});
