// SPDX-License-Identifier: MIT
/**
 * The "Open the Foreman when CodeSense starts" row: On/Off, default On, writing
 * `updateSettings({ openForemanOnStart })`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { useViewerStore } from "@/shared/stores/viewer-store";

vi.mock("next-themes", () => ({
  useTheme: () => ({ theme: "system", setTheme: vi.fn() }),
}));
vi.mock("@/tauri/commands", () => ({
  readDashboardProfile: vi.fn(async () => null),
  writeDashboardProfile: vi.fn(async (_org, profile) => profile),
  detectTools: vi.fn().mockResolvedValue({ editors: [], terminals: [] }),
  checkForUpdate: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/api/app", () => ({
  getVersion: vi.fn().mockResolvedValue("0.0.0-test"),
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("@/app/update-toast", () => ({ runUpdateCheck: vi.fn() }));

import { GeneralSection } from "./general-section";

describe("GeneralSection — open the Foreman when CodeSense starts", () => {
  beforeEach(() => {
    useViewerStore.setState({
      settings: { ...useViewerStore.getState().settings, openForemanOnStart: undefined },
    });
  });

  it("is found by 'foreman', defaults On, and writes the chosen value", () => {
    render(<GeneralSection query="foreman" />);
    expect(screen.getByText("Open the Foreman when CodeSense starts")).toBeInTheDocument();
    expect(screen.getByTestId("settings-open-foreman-on-start-on")).toHaveAttribute(
      "aria-checked",
      "true",
    );
    fireEvent.click(screen.getByTestId("settings-open-foreman-on-start-off"));
    expect(useViewerStore.getState().settings.openForemanOnStart).toBe(false);
    fireEvent.click(screen.getByTestId("settings-open-foreman-on-start-on"));
    expect(useViewerStore.getState().settings.openForemanOnStart).toBe(true);
  });
});
