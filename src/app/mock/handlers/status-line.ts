// SPDX-License-Identifier: MIT
import { postStatusLine, type StatusLinePost } from "@/shared/stores/status-line-store";

/**
 * `window.__codesenseMock.postStatusLine` posts a line to the title bar's status line, so an e2e
 * spec can show one without a feature that posts it. Mock builds only: `installMockBackend`
 * plants it, and production builds carry no mock module.
 */
export function installStatusLineMockHook(): void {
  const w = window as unknown as {
    __codesenseMock?: { postStatusLine?: (post: StatusLinePost) => number };
  };
  w.__codesenseMock = { ...w.__codesenseMock, postStatusLine };
}
