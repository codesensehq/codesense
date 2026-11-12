// SPDX-License-Identifier: MIT
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/shared/hooks/use-avatar-packs", () => ({
  useAvatarPacks: () => ({
    packs: [{ id: "mine", name: "My Pack", scope: "personal", faces: [] }],
    faces: {},
    resolveFace: () => null,
  }),
}));
vi.mock("@/shared/lib/get-current-user", () => ({
  useCurrentUser: () => ({ display_name: "Ada", identity_avatar: null }),
}));
vi.mock("@/shared/stores/local-profile-store", () => ({
  useLocalProfileStore: (select: (s: unknown) => unknown) =>
    select({
      status: { active: { principal: "p", displayName: "Ada" } },
      setIdentity: vi.fn(),
    }),
}));

import { IdentitySection } from "./identity-section";

afterEach(cleanup);

it("sets 'only you' in the muted ink by its own class, not an undefined pane variable", () => {
  const { container } = render(<IdentitySection />);
  const only = screen.getByText("· only you");
  expect(only).toHaveClass("text-muted-foreground");
  expect(container.innerHTML).not.toContain("--ag-faint");
});
