// SPDX-License-Identifier: MIT
// A frontend resolver, and a snake-spelled return path.

export function resolveTarget(label: string): string {
  return label;
}

const return_by_kind = (items: string[]) => items;

// Calls and mentions are not definitions.
resolveTarget(return_by_kind([]).join(","));
const routePathEventCount = 0;
