// SPDX-License-Identifier: MIT
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import {
  installMachinesBackend,
  resetMachinesUi,
  TEAM_KEY,
  ZERO_LATENCY,
} from "../__test-utils__/machines-backend";
import { machineHandlers } from "@/app/mock/handlers/machines";
import type { MachineDraftInput, MachineSummary, MachineTestReport } from "@/tauri/commands";
import { getTeamMachines, loadTeamMachines, useMachinesStore } from "../stores/machines-store";
import { MachineReserve } from "./machine-reserve";

beforeEach(() => {
  resetMachinesUi();
});

describe("Session privacy", () => {
  it("Switch to private account opens a legacy machine already switching, keeping its record", async () => {
    installMachinesBackend("none", {
      list_machines: () => [
        {
          machineId: "legacy-host",
          kind: "ssh",
          label: "Legacy host",
          scope: { kind: "personal" },
          declaration: {
            mode: "legacy",
            host: "host.example",
            port: 22,
            jumpHost: null,
            defaultBaseDir: null,
            pinnedHostKeyFp: "SHA256:legacy",
            pinnedServerId: "server",
            revision: "rev-1",
          },
          binding: {
            username: "owner",
            keyPath: null,
            credentialRef: null,
            autoConnect: false,
            hidden: false,
          },
          canPublish: true,
          status: { state: "connected", workspaces: 0 },
          attention: 0,
          capabilities: { agentCallbacks: false },
          remoteMcpControl: false,
        },
      ],
    });
    await loadTeamMachines(TEAM_KEY);
    render(
      <MachineReserve
        panel={{ mode: "setUp", machineId: "legacy-host", privateAccount: true }}
        teamKey={TEAM_KEY}
        onClose={vi.fn()}
      />,
    );
    await screen.findByTestId("add-machine-panel");
    const privacy = screen.getByLabelText("Session privacy");
    expect(privacy).toHaveValue("private-account");
    expect(privacy).toBeEnabled();
    expect(
      screen.getByText(/keeps this machine's name, host key and settings/),
    ).toBeInTheDocument();
  });
});

describe("Set up — every error is inline with its next step", () => {
  it("re-running setup on a machine whose host key changed stays blocked", async () => {
    installMachinesBackend("demo");
    await loadTeamMachines(TEAM_KEY);
    render(
      <MachineReserve
        panel={{ mode: "setUp", machineId: "ci-runner" }}
        teamKey={TEAM_KEY}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByTestId("add-machine-test"));
    expect(await screen.findByTestId("add-machine-blocked")).toBeInTheDocument();
  });

  it("a member isn't offered address next steps on a teammate's machine", async () => {
    installMachinesBackend("shared", {
      test_machine_connection: () => ({
        steps: [
          {
            id: "reachable",
            status: "fail",
            detail: "No response",
            nextSteps: ["editAddress", "useJumpHost", "retry"],
          },
        ],
        installPlan: null,
        fileViewOnly: false,
      }),
    });
    await loadTeamMachines(TEAM_KEY);
    render(
      <MachineReserve
        panel={{ mode: "setUp", machineId: "build-farm" }}
        teamKey={TEAM_KEY}
        onClose={vi.fn()}
      />,
    );
    await userEvent.type(await screen.findByLabelText("Your user on it"), "quinn");
    await userEvent.click(screen.getByTestId("add-machine-test"));
    const row = await screen.findByTestId("machine-check-reachable");
    expect(within(row).getByTestId("machine-next-retry")).toBeInTheDocument();
    expect(within(row).queryByTestId("machine-next-editAddress")).toBeNull();
    expect(within(row).queryByTestId("machine-next-useJumpHost")).toBeNull();
  });
});

describe("Set up / Review key", () => {
  it("Set up prefills the shared machine; a member can't re-scope it", async () => {
    installMachinesBackend("shared");
    await loadTeamMachines(TEAM_KEY);
    render(
      <MachineReserve
        panel={{ mode: "setUp", machineId: "build-farm" }}
        teamKey={TEAM_KEY}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText("Set up build-farm")).toBeInTheDocument();
    // A member binds only their own user; the shared address/label are the publishers'.
    expect(screen.getByTestId("machine-locked-address")).toHaveTextContent("build-farm.int");
    expect(screen.getByLabelText("Your user on it")).toHaveValue("");
    expect(screen.queryByLabelText("Label")).toBeNull();
    expect(screen.queryByText("+ Jump host")).toBeNull();
    expect(
      screen.getByText(/Shared with default — you sign in with your own key/),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("machine-share-team")).toBeNull();
  });

  it("a publisher editing a set-up machine sees Edit, not Set up", async () => {
    installMachinesBackend("demo");
    await loadTeamMachines(TEAM_KEY);
    render(
      <MachineReserve
        panel={{ mode: "setUp", machineId: "gpu-box-2" }}
        teamKey={TEAM_KEY}
        onClose={vi.fn()}
      />,
    );
    expect(await screen.findByText("Edit gpu-box-2")).toBeInTheDocument();
    expect(screen.getByText(/Change how CodeSense reaches gpu-box-2/)).toBeInTheDocument();
  });

  it("Review key shows both fingerprints and offers no accept", async () => {
    installMachinesBackend("demo");
    await loadTeamMachines(TEAM_KEY);
    render(
      <MachineReserve
        panel={{ mode: "reviewKey", machineId: "ci-runner" }}
        teamKey={TEAM_KEY}
        onClose={vi.fn()}
      />,
    );
    const panel = await screen.findByTestId("machine-review-key-panel");
    expect(within(panel).getByTestId("review-key-pinned").textContent).not.toBe(
      within(panel).getByTestId("review-key-presented").textContent,
    );
    expect(within(panel).queryByRole("button", { name: /trust|accept/i })).toBeNull();
  });
});

describe("Saving an edit", () => {
  it("sends the revision the machine had when the panel opened, not a later one", async () => {
    const ready: MachineTestReport = {
      steps: [{ id: "reachable", status: "ok", detail: "Reachable", nextSteps: [] }],
      installPlan: null,
      fileViewOnly: false,
    };
    const { calls } = installMachinesBackend("demo", { test_machine_connection: () => ready });
    await loadTeamMachines(TEAM_KEY);
    const machine = getTeamMachines(TEAM_KEY)?.find((m) => m.machineId === "gpu-box-2");
    const opened = machine?.declaration?.revision;
    expect(opened).toBeTruthy();
    render(
      <MachineReserve
        panel={{ mode: "setUp", machineId: "gpu-box-2" }}
        teamKey={TEAM_KEY}
        onClose={vi.fn()}
      />,
    );
    await screen.findByText("Edit gpu-box-2");
    // A later list read reaches the store while the panel is open.
    act(() => {
      if (machine?.declaration)
        useMachinesStore
          .getState()
          .apply({ ...machine, declaration: { ...machine.declaration, revision: "later" } });
    });
    await userEvent.click(screen.getByTestId("add-machine-test"));
    await waitFor(() => expect(screen.getByTestId("add-machine-connect")).toBeEnabled());
    await userEvent.click(screen.getByTestId("add-machine-connect"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "save_machine")).toBe(true));
    const save = calls.find((c) => c.cmd === "save_machine");
    expect((save?.args.input as MachineDraftInput).declarationRevision).toBe(opened);
  });

  it.each([
    ["the revision its own enroll left", "after-own-setup"],
    ["the opened revision when the enroll wrote nothing", undefined],
  ])("after its own enroll, saves on %s", async (_case, enrolled) => {
    const step = (id: MachineTestReport["steps"][number]["id"], status: "ok" | "warn") => ({
      id,
      status,
      detail: status,
      nextSteps: status === "warn" ? (["enroll-private-account"] as const).slice() : [],
    });
    const { calls } = installMachinesBackend("demo", {
      test_machine_connection: (): MachineTestReport => ({
        steps: [step("private-account", "warn")],
        installPlan: null,
        fileViewOnly: false,
      }),
      enroll_private_machine_account: (): MachineTestReport => ({
        steps: [step("private-account", "ok")],
        installPlan: null,
        fileViewOnly: false,
        ...(enrolled ? { declarationRevision: enrolled } : {}),
      }),
      save_machine: () => getTeamMachines(TEAM_KEY)?.find((m) => m.machineId === "gpu-box-2"),
    });
    await loadTeamMachines(TEAM_KEY);
    const opened = getTeamMachines(TEAM_KEY)?.find((m) => m.machineId === "gpu-box-2")?.declaration
      ?.revision;
    render(
      <MachineReserve
        panel={{ mode: "setUp", machineId: "gpu-box-2" }}
        teamKey={TEAM_KEY}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByTestId("add-machine-test"));
    await userEvent.click(await screen.findByTestId("machine-next-enroll-private-account"));
    await waitFor(() => expect(screen.getByTestId("add-machine-connect")).toBeEnabled());
    await userEvent.click(screen.getByTestId("add-machine-connect"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "save_machine")).toBe(true));
    const save = calls.find((c) => c.cmd === "save_machine");
    expect((save?.args.input as MachineDraftInput).declarationRevision).toBe(enrolled ?? opened);
  });

  it("after its own install, saves on the revision the install left", async () => {
    let tests = 0;
    const { calls } = installMachinesBackend("demo", {
      test_machine_connection: (): MachineTestReport => ({
        steps: [
          tests++ === 0
            ? {
                id: "private-account",
                status: "warn",
                detail: "warn",
                nextSteps: ["install-terminal-server"],
              }
            : { id: "private-account", status: "ok", detail: "ok", nextSteps: [] },
        ],
        installPlan: null,
        fileViewOnly: false,
      }),
      install_terminal_server: () => ({
        ok: true,
        version: "1",
        logoutWarning: null,
        declarationRevision: "after-install",
      }),
      save_machine: () => getTeamMachines(TEAM_KEY)?.find((m) => m.machineId === "gpu-box-2"),
    });
    await loadTeamMachines(TEAM_KEY);
    render(
      <MachineReserve
        panel={{ mode: "setUp", machineId: "gpu-box-2" }}
        teamKey={TEAM_KEY}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByTestId("add-machine-test"));
    await userEvent.click(await screen.findByTestId("machine-next-install-terminal-server"));
    await waitFor(() => expect(screen.getByTestId("add-machine-connect")).toBeEnabled());
    await userEvent.click(screen.getByTestId("add-machine-connect"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "save_machine")).toBe(true));
    const save = calls.find((c) => c.cmd === "save_machine");
    expect((save?.args.input as MachineDraftInput).declarationRevision).toBe("after-install");
  });

  it("never adopts a teammate's edit after its own enroll reported a revision", async () => {
    const real = machineHandlers("demo", ZERO_LATENCY);
    let phase: "legacy" | "converted" | "edited" = "legacy";
    const live = (m: MachineSummary): MachineSummary =>
      m.machineId === "gpu-box-2" && m.declaration
        ? {
            ...m,
            declaration: {
              ...m.declaration,
              mode: phase === "legacy" ? "legacy" : "private-account",
              revision: { legacy: "opened", converted: "converted", edited: "teammate" }[phase],
            },
          }
        : m;
    let tests = 0;
    const step = (
      status: "ok" | "warn",
      nextSteps: MachineTestReport["steps"][number]["nextSteps"],
    ) =>
      ({
        steps: [{ id: "private-account", status, detail: status, nextSteps }],
        installPlan: null,
        fileViewOnly: false,
      }) satisfies MachineTestReport;
    const { calls } = installMachinesBackend("demo", {
      list_machines: (args) => (real.list_machines!(args) as MachineSummary[]).map(live),
      test_machine_connection: () =>
        tests++ === 0 ? step("warn", ["enroll-private-account"]) : step("ok", []),
      enroll_private_machine_account: () => {
        phase = "converted";
        return { ...step("warn", ["install-terminal-server"]), declarationRevision: "converted" };
      },
      install_terminal_server: () => {
        phase = "edited";
        throw new Error("install failed");
      },
      save_machine: () => getTeamMachines(TEAM_KEY)?.find((m) => m.machineId === "gpu-box-2"),
    });
    await loadTeamMachines(TEAM_KEY);
    render(
      <MachineReserve
        panel={{ mode: "setUp", machineId: "gpu-box-2" }}
        teamKey={TEAM_KEY}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByTestId("add-machine-test"));
    await userEvent.click(await screen.findByTestId("machine-next-enroll-private-account"));
    await userEvent.click(await screen.findByTestId("machine-next-install-terminal-server"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "install_terminal_server")).toBe(true));
    await waitFor(() =>
      expect(
        getTeamMachines(TEAM_KEY)?.find((m) => m.machineId === "gpu-box-2")?.declaration?.revision,
      ).toBe("teammate"),
    );
    await userEvent.click(screen.getByTestId("add-machine-test"));
    await waitFor(() => expect(screen.getByTestId("add-machine-connect")).toBeEnabled());
    await userEvent.click(screen.getByTestId("add-machine-connect"));
    await waitFor(() => expect(calls.some((c) => c.cmd === "save_machine")).toBe(true));
    const save = calls.find((c) => c.cmd === "save_machine");
    expect((save?.args.input as MachineDraftInput).declarationRevision).toBe("converted");
  });

  it("retries a save whose later step failed on the revision that save left", async () => {
    let autoConnects = 0;
    const ready: MachineTestReport = {
      steps: [{ id: "reachable", status: "ok", detail: "Reachable", nextSteps: [] }],
      installPlan: null,
      fileViewOnly: false,
    };
    const { calls } = installMachinesBackend("demo", {
      test_machine_connection: () => ready,
      save_machine: () => {
        const machine = getTeamMachines(TEAM_KEY)?.find((m) => m.machineId === "gpu-box-2");
        return machine?.declaration && machine.binding
          ? {
              ...machine,
              declaration: { ...machine.declaration, revision: "after-save" },
              binding: { ...machine.binding, autoConnect: false },
            }
          : machine;
      },
      set_machine_auto_connect: () => {
        if (autoConnects++ === 0) throw new Error("offline");
      },
    });
    await loadTeamMachines(TEAM_KEY);
    const opened = getTeamMachines(TEAM_KEY)?.find((m) => m.machineId === "gpu-box-2")?.declaration
      ?.revision;
    render(
      <MachineReserve
        panel={{ mode: "setUp", machineId: "gpu-box-2" }}
        teamKey={TEAM_KEY}
        onClose={vi.fn()}
      />,
    );
    await userEvent.click(await screen.findByTestId("add-machine-test"));
    await waitFor(() => expect(screen.getByTestId("add-machine-connect")).toBeEnabled());
    const background = screen.getByRole("checkbox", { name: /reconnect in background/i });
    if (!(background as HTMLInputElement).checked) await userEvent.click(background);
    await userEvent.click(screen.getByTestId("add-machine-connect"));
    await waitFor(() => expect(autoConnects).toBe(1));
    await waitFor(() => expect(screen.getByTestId("add-machine-connect")).toBeEnabled());
    await userEvent.click(screen.getByTestId("add-machine-connect"));
    await waitFor(() => expect(calls.filter((c) => c.cmd === "save_machine")).toHaveLength(2));
    const [first, second] = calls
      .filter((c) => c.cmd === "save_machine")
      .map((c) => (c.args.input as MachineDraftInput).declarationRevision);
    expect(first).toBe(opened);
    expect(second).toBe("after-save");
  });
});
