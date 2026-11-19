// SPDX-License-Identifier: MIT
import { Server } from "lucide-react";

import type { MachineSummary } from "@/tauri/commands";

/** The add or set-up panel's head, the same whether it shows the form or why there is none:
 *  "Add machine" for a new machine, else Set up or Edit with its name. */
export function machinePanelHead(machine: MachineSummary | null) {
  return {
    testId: "add-machine-panel",
    icon: <Server size={16} aria-hidden="true" />,
    title: !machine
      ? "Add machine"
      : machine.binding
        ? `Edit ${machine.label}`
        : `Set up ${machine.label}`,
    closeLabel: "Close add-machine panel",
  };
}
