// SPDX-License-Identifier: MIT
/**
 * The bundled CodeSense docs context repo (SW-OC-16): the read-only context repo every
 * install ships, that the very first launch lands in. Mirrors `codesense-docs/bundle.json`
 * (a test keeps them equal); the backend places and connects it (`ensureCodesenseDocs`).
 */
import type { Org } from "@/shared/types/domain";

export const CODESENSE_DOCS_SLUG = "codesense/docs";
export const CODESENSE_DOCS_TEAM = "getting-started";
/** The name the switcher, chip and headers show. Not plain "CodeSense", which reads as
 *  a duplicate of a user's own repo named after the product. */
export const CODESENSE_DOCS_DISPLAY_NAME = "CodeSense Docs";
/** The README the first launch opens, relative to the repo root. */
export const CODESENSE_DOCS_README = "getting-started/content/README.html";
/** The bundled Foreman page, relative to the repo root. */
export const CODESENSE_DOCS_FOREMAN_PAGE = "getting-started/content/foreman/index.html";

/** Same copy the backend refuses an edit with. */
export const CODESENSE_DOCS_READ_ONLY =
  "CodeSense docs are read-only. To make your own editable copy, choose Create a new context repo… and turn on Start from the CodeSense example.";

export function isCodesenseDocs(slug: string | null | undefined): boolean {
  return slug === CODESENSE_DOCS_SLUG;
}

/**
 * Which context repo a settled discovery opens.
 * - The persisted last-opened repo when it is still connected (every later launch).
 * - A newly connected one, when a connect/create just happened.
 * - Otherwise (the very first launch, or the last-opened repo is gone) the CodeSense
 *   docs, so there is never a dead end.
 */
export function pickLaunchOrg(input: {
  orgs: readonly Pick<Org, "slug">[];
  activeOrgSlug: string | null;
  newlyConnected?: string | null;
}): string | null {
  const { orgs, activeOrgSlug, newlyConnected } = input;
  if (newlyConnected && orgs.some((o) => o.slug === newlyConnected)) return newlyConnected;
  if (activeOrgSlug && orgs.some((o) => o.slug === activeOrgSlug)) return activeOrgSlug;
  if (orgs.some((o) => o.slug === CODESENSE_DOCS_SLUG)) return CODESENSE_DOCS_SLUG;
  return orgs[0]?.slug ?? null;
}

/**
 * What a settled launch opens, once per app start.
 * - `foreman` when "Open the Foreman when CodeSense starts" is on (the default).
 * - Otherwise the docs README when no context repo of the user's own is connected, so a
 *   new user always has an entry point.
 * - Otherwise nothing: the last session's tabs are all that opens.
 */
export function pickStartLanding(input: {
  orgs: readonly Pick<Org, "slug">[];
  openForemanOnStart: boolean | undefined;
}): "foreman" | "readme" | "none" {
  if (input.openForemanOnStart !== false) return "foreman";
  return input.orgs.every((o) => isCodesenseDocs(o.slug)) ? "readme" : "none";
}

/** Pinned first, then the rest alphabetically: the order never moves on selection. */
export function orderContextRepos<T extends Pick<Org, "slug" | "display_name">>(
  orgs: readonly T[],
): T[] {
  return [...orgs].sort((a, b) => {
    if (isCodesenseDocs(a.slug) !== isCodesenseDocs(b.slug))
      return isCodesenseDocs(a.slug) ? -1 : 1;
    return a.display_name.localeCompare(b.display_name);
  });
}

/** The folder's own name, for "Connect {name}?". */
export function folderName(path: string): string {
  const trimmed = path.replace(/[/\\]+$/, "");
  return trimmed.split(/[/\\]/).pop() || trimmed;
}

/** A folder name for a new context repo called `name`. */
export function contextRepoFolderName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "") || "context"
  );
}

/** The default location of a new context repo: `~/CodeSense/<name>`. */
export function defaultContextRepoLocation(home: string, name: string): string {
  return `${home.replace(/[/\\]+$/, "")}/CodeSense/${contextRepoFolderName(name)}`;
}

/** Why a connect or create failed. `message` is always the backend's own reason. */
export type ConnectFailure =
  | { kind: "not-a-context-repo"; message: string }
  | { kind: "error"; message: string };

/**
 * Sorts a connect error into the "isn't a CodeSense context repo" state (the folder is not
 * a git checkout root, or has no readable `org.yml`) or a plain error.
 */
export function classifyConnectError(error: unknown): ConnectFailure {
  const message = error instanceof Error ? error.message : String(error);
  const notContext = [
    "is not a Git checkout",
    "not a subdirectory or bare repository",
    "context's org.yml",
    "Invalid context org.yml",
    "Invalid context registry",
  ];
  return notContext.some((needle) => message.includes(needle))
    ? { kind: "not-a-context-repo", message }
    : { kind: "error", message };
}

export const NOT_A_CONTEXT_REPO =
  "This folder isn't a CodeSense context repo. Pick the folder you cloned, or create a new one.";

/** Follows the context repo's name: "{name} can't be found at {path}. …" */
export function missingContextRepoDetail(path: string): string {
  return `can't be found at ${path}. Locate the folder if you moved it, or disconnect it.`;
}
