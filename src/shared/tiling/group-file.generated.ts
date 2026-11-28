// SPDX-License-Identifier: MIT
// Generated from the Rust `groups::shape` module by its `ts_type` test. Do not edit.

export interface GroupFile {
  owner: OwnerKind;
  rev: number;
  root: SavedNode | null;
  version: number;
}

export type Axis = "row" | "column";

export type OwnerKind = "workspace" | "group" | "starter";

export type SavedNode =
  | { active?: string; id: string; kind: "leaf"; tabs?: string[]; workspaceId: string }
  | { axis: Axis; children: SavedNode[]; kind: "split"; sizes: number[] };
