// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { restorePlatform, setPlatform } from "@/test/platform";
import { resetPlatformCaps, setPlatformCaps } from "@/shared/lib/__test-utils__/platform-caps";

import {
  installMachinesBackend,
  resetMachinesUi,
  TEAM_KEY,
} from "../__test-utils__/machines-backend";
import { MachineReserve } from "./machine-reserve";

const SENTENCE = "Not yet available on Linux: CodeSense can't connect to other machines.";

beforeEach(() => {
  resetMachinesUi();
  setPlatform("Linux x86_64");
});
afterEach(() => {
  resetPlatformCaps();
  restorePlatform();
});

describe("the machine reserve without remote machines on this OS", () => {
  beforeEach(() =>
    setPlatformCaps({
      "remote-machines": "CodeSense can't connect to other machines",
    }),
  );

  it("Add machine shows why instead of the form, with only Close", async () => {
    installMachinesBackend("none");
    const onClose = vi.fn();
    render(<MachineReserve panel={{ mode: "add" }} teamKey={TEAM_KEY} onClose={onClose} />);
    const panel = await screen.findByTestId("add-machine-panel");
    expect(panel).toHaveTextContent("Add machine");
    expect(panel).toHaveTextContent(SENTENCE);
    expect(screen.getByTestId("add-machine-off")).toHaveTextContent(
      "Machines your team shares still show in the list; you can hide them.",
    );
    expect(panel.querySelector("input")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("Set up on a shared machine shows the same state", async () => {
    installMachinesBackend("shared");
    render(
      <MachineReserve
        panel={{ mode: "setUp", machineId: "build-farm" }}
        teamKey={TEAM_KEY}
        onClose={() => undefined}
      />,
    );
    const panel = await screen.findByTestId("add-machine-panel");
    expect(panel).toHaveTextContent("Set up build-farm");
    expect(panel).toHaveTextContent(SENTENCE);
    expect(screen.getByTestId("add-machine-off")).toHaveTextContent(
      "build-farm stays in your team's list; you can hide it.",
    );
    expect(screen.queryByTestId("add-machine-connect")).toBeNull();
  });
});

describe("the machine reserve with remote machines on", () => {
  it("Add machine and Set up show their forms, as today", async () => {
    setPlatformCaps();
    installMachinesBackend("shared");
    const { unmount } = render(
      <MachineReserve panel={{ mode: "add" }} teamKey={TEAM_KEY} onClose={() => undefined} />,
    );
    expect(await screen.findByTestId("add-machine-panel")).toHaveTextContent("Type its address.");
    unmount();
    render(
      <MachineReserve
        panel={{ mode: "setUp", machineId: "build-farm" }}
        teamKey={TEAM_KEY}
        onClose={() => undefined}
      />,
    );
    expect(await screen.findByTestId("add-machine-connect")).toBeInTheDocument();
    expect(screen.queryByTestId("add-machine-off")).toBeNull();
  });
});
