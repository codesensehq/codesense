// SPDX-License-Identifier: MIT
import { useState, type CSSProperties, type ReactElement, type ReactNode, type Ref } from "react";

import { ExcalidrawViewer } from "@/features/dashboard/components/excalidraw-viewer";
import { HtmlViewer } from "@/features/dashboard/components/html-viewer";
import { ImageViewer } from "@/features/dashboard/components/image-viewer";
import { STATUS_LABEL } from "@/features/git-sync/components/file-status-chip";
import { RedlineProse } from "@/features/git-sync/components/redline-prose";
import { RenderedMarkdown } from "@/features/git-sync/components/rendered-markdown";
import type { PublishFileStatus } from "@/features/git-sync/lib/types";
import { OverlayCenteredState } from "@/features/viewer/components/overlay-shell";
import { cn } from "@/lib/utils";
import {
  CodeDiffReview,
  detectLanguageId,
  isStructuralLanguage,
  type CodeDiffReviewProps,
} from "@/shared/components/code-editor";
import { useContainerWidth } from "@/shared/hooks/use-container-width";

import type { FileDiffKind, FileDiffModes } from "./file-diff-mode";
import { SideFrame, SideImage } from "./side-frame";
import { extensionOf, getViewerFileType, type ViewerFileType } from "./viewer-file-type";

/**
 * The one file-diff dispatch. Every surface that shows a changed
 * file (Files Changes and History, the source diff, the open-diff tab, Unsaved
 * team edits) resolves its own two sides with its own fetcher and hands them
 * here; this decides how the type reads:
 *
 * - markdown: the block redline, rendered side by side, or the source diff;
 * - HTML, image, Excalidraw: rendered side by side, or the source diff. Files
 *   serves both sides (`sides.rendered`); every other surface draws them from
 *   the text or bytes it already holds (see `./side-frame`);
 * - code: `CodeDiffReview` in the shared code mode, never a markdown redline.
 *
 * Side by side needs a diff body at least {@link SIDE_BY_SIDE_MIN_WIDTH} px
 * wide; below that it falls back to a Before | After toggle. The surface passes
 * its fetch `state` in and this renders the matching state (loading, error,
 * binary, one-sided, and the large-diff gate). It fetches nothing.
 */

/** Why a raster image's sides aren't drawn here: the switch's tooltip and the Source line. */
/** Why an image the surface read nothing of won't draw: its diff's read failed, and says how. */
export const diffFailed = (message: string) =>
  message ? `Couldn't read the diff (${message})` : "Couldn't read the diff";
export const IMAGE_UNAVAILABLE = {
  tooLarge: "Over the 8 MB limit for drawing here",
  failed: "Couldn't read the image",
  remote: "Images at a commit in a remote worktree aren't drawn yet",
} as const;

/** Diff bodies narrower than this show one side at a time. */
export const SIDE_BY_SIDE_MIN_WIDTH = 900;

/** Both sides past this many chars wait behind an explicit "show anyway": the
 *  code diff and the prose redline are computed on the renderer thread, and a
 *  minified bundle can be megabytes on one line. ~1.5M chars covers normal
 *  source files while catching the pathological ones. */
export const LARGE_DIFF_CHARS = 1_500_000;

export type FileDiffState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "binary" }
  | { kind: "ready" };

export interface RenderedSides {
  /** The working-tree file the after side is served from. */
  absPath: string;
  teamContentPath: string;
  /** Where the before side's blob is served from (`/viewer-baseline`). */
  baselineSource: { orgRoot: string; relPath: string; tree?: string };
  refreshKey?: number;
  changedPaths?: Set<string> | null;
}

export interface FileDiffSides {
  /** `null` while the surface is still reading. */
  before: string | null;
  after: string | null;
  /** An added file has no before side and a deleted one no after side. */
  status?: PublishFileStatus;
  beforeLabel?: string;
  afterLabel?: string;
  /** Files only: URL sources for the rendered HTML/image/Excalidraw viewers. */
  rendered?: RenderedSides;
  /** Off Files: a raster image side's bytes (base64), where the surface holds them. */
  imageBytes?: { before?: string; after?: string };
  /** Off Files: a raster image's bytes still being read, or why they won't draw here. */
  imageState?: { kind: "reading" } | { kind: "unavailable"; reason: string };
}

export interface FileDiffPrefs {
  modes: FileDiffModes;
  /** Writes a mode. Omit it and no mode switch is drawn (the host draws its own). */
  onModeChange?: <K extends FileDiffKind>(kind: K, mode: FileDiffModes[K]) => void;
  /** Extra `CodeDiffReview` props from the surface (layout, height, ranges, nav). */
  code?: Omit<Partial<CodeDiffReviewProps>, "before" | "after" | "path" | "diffMode">;
  /** The prose chrome around the markdown redline and rendered sides. */
  prose?: {
    className?: string;
    style?: CSSProperties;
    ref?: Ref<HTMLDivElement>;
    /** The redline's scroll container (keyboard scrolling binds to it). */
    scrollRef?: Ref<HTMLDivElement>;
    /** Wraps the prose inside the scroll container (width, padding). */
    frameClassName?: string;
  };
  /** Drawn once under the strip for every type and mode (labels, notes). */
  header?: ReactNode;
  /** The surface's binary affordance. */
  binary?: ReactNode;
  /** Test ids read `<prefix>-large-gate`, `<prefix>-code-skeleton`, … */
  testIdPrefix?: string;
}

export interface FileDiffArgs {
  fileType: ViewerFileType;
  filePath: string;
  sides: FileDiffSides;
  state: FileDiffState;
  prefs: FileDiffPrefs;
}

export function renderFileDiff(args: FileDiffArgs): ReactElement {
  const { fileType } = args;
  switch (fileType) {
    case "markdown":
      return <MarkdownFileDiff {...args} />;
    case "html":
    case "image":
    case "excalidraw":
      return <RenderedFileDiff {...args} fileType={fileType} />;
    case "code":
      return <CodeFileDiff {...args} />;
    default: {
      const _exhaustive: never = fileType;
      void _exhaustive;
      return <CodeFileDiff {...args} />;
    }
  }
}

/** HTML, SVG and Excalidraw: drawn from their text where no route serves them. */
export function rendersFromText(filePath: string): boolean {
  const fileType = getViewerFileType(filePath);
  return fileType === "html" || fileType === "excalidraw" || isSvg(filePath);
}

/** An SVG can carry script, so it renders as a page, never in an `<img>`. */
function isSvg(filePath: string) {
  return extensionOf(filePath) === "svg";
}

/**
 * Whether a surface without `sides.rendered` can draw this file's rendered
 * sides: a text type unless a side read as binary, a raster image only when
 * the surface holds every present side's bytes.
 */
export function rendersInline(filePath: string, sides: FileDiffSides, state: FileDiffState) {
  if (rendersFromText(filePath)) return state.kind !== "binary";
  if (getViewerFileType(filePath) !== "image") return false;
  const { hasBefore, hasAfter } = sideAvailability(sides);
  return (
    (!hasBefore || sides.imageBytes?.before != null) &&
    (!hasAfter || sides.imageBytes?.after != null)
  );
}

const MODE_LABELS: { [K in FileDiffKind]: [FileDiffModes[K], string][] } = {
  markdown: [
    ["redline", "Redline"],
    ["side-by-side", "Side by side"],
    ["source", "Source"],
  ],
  html: [
    ["side-by-side", "Side by side"],
    ["source", "Source"],
  ],
  code: [
    ["line", "Line"],
    ["ignoreWhitespace", "Ignore whitespace"],
    ["structural", "Structural"],
  ],
};

/** The segmented mode switch, for hosts that place it in their own chrome. */
export function FileDiffModeSwitch<K extends FileDiffKind>({
  kind,
  mode,
  onChange,
  testId,
  unavailable,
}: {
  kind: K;
  mode: FileDiffModes[K];
  onChange: (mode: FileDiffModes[K]) => void;
  testId?: string;
  /** Modes that can't apply here, each with the reason shown as its tooltip. */
  unavailable?: Partial<Record<FileDiffModes[K], string>>;
}) {
  const options = MODE_LABELS[kind] as [FileDiffModes[K], string][];
  // A mode that can't apply here isn't what the body shows: the first one that can is pressed
  // (an image that can't draw shows Source, whatever the preference says).
  const shown =
    unavailable?.[mode] != null
      ? (options.find(([value]) => unavailable?.[value] == null)?.[0] ?? mode)
      : mode;
  return (
    <div
      role="group"
      aria-label="Diff mode"
      data-testid={testId}
      className="inline-flex overflow-hidden rounded border border-border text-xs"
    >
      {options.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={shown === value}
          disabled={unavailable?.[value] != null}
          title={unavailable?.[value]}
          onClick={() => onChange(value)}
          className={cn(
            // The ring is drawn inside the button: the group's overflow-hidden would clip it. Important,
            // because the global :focus-visible rule (unlayered) sets a 2 px offset that beats utilities.
            "px-2 py-0.5 focus-visible:!outline-offset-[-2px] disabled:cursor-not-allowed disabled:opacity-50",
            shown === value
              ? "bg-primary font-medium text-primary-foreground"
              : "enabled:hover:bg-accent/60",
          )}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

type Side = "before" | "after";

/** How two sides lay out in the body: both two-up, one at a time, only the
 *  present side, or not yet known (the body hasn't been measured). */
type SideLayout = "two" | "toggle" | "one" | "unknown";

function sideAvailability(sides: FileDiffSides) {
  return { hasBefore: sides.status !== "added", hasAfter: sides.status !== "deleted" };
}

function sideLayout(sides: FileDiffSides, width: number | null): SideLayout {
  const { hasBefore, hasAfter } = sideAvailability(sides);
  if (!hasBefore || !hasAfter) return "one";
  if (width == null) return "unknown";
  return width >= SIDE_BY_SIDE_MIN_WIDTH ? "two" : "toggle";
}

function sideLabel(sides: FileDiffSides, side: Side) {
  return side === "before" ? (sides.beforeLabel ?? "Before") : (sides.afterLabel ?? "After");
}

/** State a diff keeps across its own mode switches: the measured body, the side
 *  the reader picked in the narrow layout, and a large file's opt-in. */
function useFrameState(filePath: string) {
  const [bodyRef, width] = useContainerWidth();
  const [picked, setPicked] = useState<Side>("after");
  const [forcedPath, setForcedPath] = useState<string | null>(null);
  return {
    bodyRef,
    width,
    picked,
    setPicked,
    gate: { forced: forcedPath === filePath, onForce: () => setForcedPath(filePath) },
  };
}

type Gate = ReturnType<typeof useFrameState>["gate"];

/** The narrow layout's Before | After switch, drawn in the strip. */
function SideToggle({
  sides,
  picked,
  onPick,
}: {
  sides: FileDiffSides;
  picked: Side;
  onPick: (side: Side) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Side shown"
      className="inline-flex overflow-hidden rounded border border-border"
    >
      {(["before", "after"] as const).map((side) => (
        <button
          key={side}
          type="button"
          aria-pressed={picked === side}
          onClick={() => onPick(side)}
          className={cn(
            "px-2 py-0.5 focus-visible:!outline-offset-[-2px]",
            picked === side
              ? "bg-primary font-medium text-primary-foreground"
              : "hover:bg-accent/60",
          )}
        >
          {sideLabel(sides, side)}
        </button>
      ))}
    </div>
  );
}

/** The header strip (the former `BeforeAfterDiffToggle` pattern): status, the
 *  narrow layout's side toggle, then the mode switch at the right. A host that
 *  draws its own mode switch (the source diff) gets the strip only for the side
 *  toggle; it shows status in its own chrome. */
function DiffStrip<K extends FileDiffKind>({
  sides,
  kind,
  mode,
  prefs,
  showSwitch,
  sideToggle,
  filePath,
  unavailableModes,
}: {
  sides: FileDiffSides;
  kind: K;
  mode: FileDiffModes[K];
  prefs: FileDiffPrefs;
  /** False over a body no mode changes (a binary file's affordance). */
  showSwitch: boolean;
  sideToggle?: ReactNode;
  filePath: string;
  /** Modes that can't apply here, each with its reason (the switch shows it as a tooltip). */
  unavailableModes?: Partial<Record<FileDiffModes[K], string>>;
}) {
  const onModeChange = showSwitch ? prefs.onModeChange : undefined;
  const unavailable =
    unavailableModes ??
    (kind === "code" && !isStructuralLanguage(detectLanguageId(filePath))
      ? ({ structural: "No structural diff for this language" } as Partial<
          Record<FileDiffModes[K], string>
        >)
      : undefined);
  if (!onModeChange && !sideToggle) return null;
  const prefix = prefs.testIdPrefix ?? "file-diff";
  return (
    <div
      className="flex flex-none items-center gap-2 border-b px-3 py-1.5 text-xs"
      data-testid={`${prefix}-strip`}
    >
      {onModeChange && sides.status && (
        <span className="font-medium">{STATUS_LABEL[sides.status]}</span>
      )}
      {sideToggle}
      {onModeChange && (
        <div className="ml-auto">
          <FileDiffModeSwitch
            kind={kind}
            mode={mode}
            onChange={(next) => onModeChange(kind, next)}
            testId={`${prefix}-mode-switch`}
            unavailable={unavailable}
          />
        </div>
      )}
    </div>
  );
}

/** The frame every type shares: strip and the surface's header on top, measured
 *  body below, then an optional footer line. */
function DiffFrame({
  strip,
  header,
  bodyRef,
  children,
  footer,
  testId,
}: {
  strip: ReactNode;
  header?: ReactNode;
  bodyRef: (node: HTMLDivElement | null) => void;
  children: ReactNode;
  footer?: ReactNode;
  testId: string;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid={testId}>
      {strip}
      {header && (
        <div className="flex-none space-y-1 border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          {header}
        </div>
      )}
      <div ref={bodyRef} className="min-h-0 flex-1">
        {children}
      </div>
      {footer}
    </div>
  );
}

function isLarge(sides: FileDiffSides) {
  return (
    sides.before != null &&
    sides.after != null &&
    sides.before.length + sides.after.length > LARGE_DIFF_CHARS
  );
}

/** Gates an enormous resolved diff behind an explicit opt-in. The opt-in lives
 *  in the frame, so switching mode on the same file keeps it. */
function LargeDiffGate({
  sides,
  gate,
  prefix,
  children,
}: {
  sides: FileDiffSides;
  gate: Gate;
  prefix: string;
  children: ReactNode;
}) {
  if (!isLarge(sides) || gate.forced) return <>{children}</>;
  return (
    <OverlayCenteredState
      testId={`${prefix}-large-gate`}
      action={
        <button
          type="button"
          data-testid={`${prefix}-show-anyway`}
          onClick={gate.onForce}
          className="rounded border border-border px-2 py-0.5 text-[0.7rem] font-medium text-foreground hover:bg-accent"
        >
          Show diff anyway
        </button>
      }
    >
      This file is large — rendering the diff may be slow.
    </OverlayCenteredState>
  );
}

/** Before and After two-up at {@link SIDE_BY_SIDE_MIN_WIDTH}, the picked side
 *  below it (the toggle is in the strip), and only the present side (labelled)
 *  for an added or deleted file. */
function SideBySide({
  sides,
  layout,
  picked,
  prefix,
  renderSide,
}: {
  sides: FileDiffSides;
  layout: SideLayout;
  picked: Side;
  prefix: string;
  /** `active` marks the pane the reader is on (scroll keys bind to it). */
  renderSide: (side: Side, active: boolean) => ReactNode;
}) {
  const labelRow = "flex-none border-b border-border px-3 py-1 text-[11.5px] font-semibold";

  if (layout === "unknown") return <CodeSkeleton prefix={prefix} />;

  if (layout === "one") {
    const only = sideAvailability(sides).hasAfter ? "after" : "before";
    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className={labelRow} data-testid={`${prefix}-one-side`}>
          {sideLabel(sides, only)}
        </div>
        <div className="min-h-0 flex-1">{renderSide(only, true)}</div>
      </div>
    );
  }

  if (layout === "two") {
    return (
      <div className="grid h-full min-h-0 grid-cols-2" data-testid={`${prefix}-side-by-side`}>
        {(["before", "after"] as const).map((side) => (
          <div
            key={side}
            className={cn(
              "flex min-h-0 min-w-0 flex-col",
              side === "after" && "border-l border-border",
            )}
          >
            <div className={labelRow}>{sideLabel(sides, side)}</div>
            <div className="min-h-0 flex-1">{renderSide(side, side === "after")}</div>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="h-full min-h-0" data-testid={`${prefix}-one-at-a-time`}>
      {renderSide(picked, true)}
    </div>
  );
}

/** The body while a side is read: it pulses only where motion is welcome, and says so to a
 *  screen reader (or to everyone, `shown`). */
function CodeSkeleton({
  prefix,
  label = "Loading the diff",
  shown = false,
}: {
  prefix: string;
  label?: string;
  shown?: boolean;
}) {
  return (
    <div
      data-testid={`${prefix}-code-skeleton`}
      className="relative flex h-full w-full items-center justify-center"
    >
      {/* Only the placeholder pulses: a label that fades with it drops under AA. */}
      <div
        aria-hidden="true"
        data-skeleton-pulse=""
        className="absolute inset-0 rounded bg-muted/40 motion-safe:animate-pulse"
      />
      <span role="status" className={shown ? "relative text-xs text-muted-foreground" : "sr-only"}>
        {label}
      </span>
    </div>
  );
}

function ErrorRow({ prefix, message }: { prefix: string; message: string }) {
  return (
    <div
      role="alert"
      data-testid={`${prefix}-code-error`}
      className="flex h-full items-center justify-center px-8 text-center text-xs text-destructive"
    >
      {message}
    </div>
  );
}

function BinaryNote({ prefs }: { prefs: FileDiffPrefs }) {
  return (
    <>
      {prefs.binary ?? (
        <OverlayCenteredState>Binary file — no text diff to show.</OverlayCenteredState>
      )}
    </>
  );
}

/** The text diff: the code body, and every type's Source mode. */
function SourceBody({
  sides,
  state,
  prefs,
  filePath,
  width,
  gate,
}: Omit<FileDiffArgs, "fileType"> & { width: number | null; gate: Gate }) {
  const prefix = prefs.testIdPrefix ?? "file-diff";
  if (state.kind === "binary") return <BinaryNote prefs={prefs} />;
  if (state.kind === "error") return <ErrorRow prefix={prefix} message={state.message} />;
  // Until the body is measured the layout is unknown: mounting the diff now would
  // build it inline and then rebuild it split.
  const layoutFixed = prefs.code?.mode != null;
  if (
    state.kind === "loading" ||
    sides.before == null ||
    sides.after == null ||
    (width == null && !layoutFixed)
  ) {
    return <CodeSkeleton prefix={prefix} />;
  }
  // An oversized file shown past the gate never pays for ignore-whitespace or
  // structural: both cost more than the plain line diff.
  const diffMode = isLarge(sides) ? "line" : prefs.modes.code;
  const layout = width != null && width >= SIDE_BY_SIDE_MIN_WIDTH ? "split" : "inline";
  return (
    <LargeDiffGate sides={sides} gate={gate} prefix={prefix}>
      <CodeDiffReview
        mode={layout}
        {...prefs.code}
        before={sides.before}
        after={sides.after}
        path={filePath}
        diffMode={diffMode}
      />
    </LargeDiffGate>
  );
}

/** The scroll container the prose bodies read in. */
function ProseScroll({
  prefs,
  scrollRef,
  children,
}: {
  prefs: FileDiffPrefs;
  scrollRef?: Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  return (
    <div
      ref={scrollRef}
      data-scroll-keys={scrollRef ? "" : undefined}
      className="h-full overflow-y-auto"
    >
      <div className={prefs.prose?.frameClassName ?? "px-6 py-5"}>{children}</div>
    </div>
  );
}

const PROSE_CLASS = "prose prose-sm max-w-none dark:prose-invert";

function MarkdownFileDiff({ filePath, sides, state, prefs }: FileDiffArgs) {
  const frame = useFrameState(filePath);
  const mode = prefs.modes.markdown;
  const prefix = prefs.testIdPrefix ?? "file-diff";
  const proseClass = prefs.prose?.className ?? PROSE_CLASS;
  const layout = sideLayout(sides, frame.width);

  let body: ReactNode;
  if (mode === "source") {
    body = (
      <SourceBody
        filePath={filePath}
        sides={sides}
        state={state}
        prefs={prefs}
        width={frame.width}
        gate={frame.gate}
      />
    );
  } else if (state.kind === "binary") {
    body = <BinaryNote prefs={prefs} />;
  } else if (mode === "redline") {
    body = (
      <LargeDiffGate sides={sides} gate={frame.gate} prefix={prefix}>
        <ProseScroll prefs={prefs} scrollRef={prefs.prose?.scrollRef}>
          <RedlineProse
            before={state.kind === "ready" ? sides.before : null}
            after={state.kind === "ready" ? sides.after : null}
            error={state.kind === "error" ? state.message : null}
            // The path is the no-flash reset key: a file switch resets, an
            // in-place edit at the same path keeps the prior render.
            resetKey={filePath}
            proseRef={prefs.prose?.ref}
            className={proseClass}
            style={prefs.prose?.style}
          />
        </ProseScroll>
      </LargeDiffGate>
    );
  } else if (state.kind === "error") {
    body = <ErrorRow prefix={prefix} message={state.message} />;
  } else if (state.kind === "loading" || sides.before == null || sides.after == null) {
    body = <CodeSkeleton prefix={prefix} />;
  } else {
    const text = { before: sides.before, after: sides.after };
    body = (
      <LargeDiffGate sides={sides} gate={frame.gate} prefix={prefix}>
        <SideBySide
          sides={sides}
          layout={layout}
          picked={frame.picked}
          prefix={prefix}
          renderSide={(side, active) => (
            <ProseScroll prefs={prefs} scrollRef={active ? prefs.prose?.scrollRef : undefined}>
              <RenderedMarkdown
                key={`${filePath}:${side}`}
                text={text[side]}
                className={proseClass}
                style={prefs.prose?.style}
              />
            </ProseScroll>
          )}
        />
      </LargeDiffGate>
    );
  }

  const showToggle = mode === "side-by-side" && state.kind === "ready" && layout === "toggle";
  return (
    <DiffFrame
      testId={`${prefix}-markdown`}
      bodyRef={frame.bodyRef}
      header={prefs.header}
      strip={
        <DiffStrip
          sides={sides}
          kind="markdown"
          mode={mode}
          prefs={prefs}
          filePath={filePath}
          showSwitch={state.kind !== "binary"}
          sideToggle={
            showToggle && (
              <SideToggle sides={sides} picked={frame.picked} onPick={frame.setPicked} />
            )
          }
        />
      }
    >
      {body}
    </DiffFrame>
  );
}

function RenderedFileDiff({
  fileType,
  filePath,
  sides,
  state,
  prefs,
}: FileDiffArgs & { fileType: "html" | "image" | "excalidraw" }) {
  const frame = useFrameState(filePath);
  const prefix = prefs.testIdPrefix ?? "file-diff";
  const rendered = sides.rendered;
  // Off Files a raster image draws from the bytes the surface reads: while they are read it
  // says so, and when they won't draw here Side by side stays in the switch with the reason.
  const raster = !rendered && fileType === "image" && !rendersFromText(filePath);
  // Before the surface knows anything of the image (its diff still loading), it is being read too.
  const reading =
    raster &&
    (sides.imageState?.kind === "reading" || (!sides.imageState && state.kind === "loading"));
  // A side that failed to read can't draw either: Side by side says so, rather than the code modes.
  const cannotDraw = !raster
    ? null
    : sides.imageState?.kind === "unavailable"
      ? sides.imageState.reason
      : state.kind === "error"
        ? // Nothing of the image was read here: the reason is the diff's own error, not the image.
          diffFailed(state.message)
        : null;
  // Off Files the sides are drawn from what the surface holds; a type it can't
  // draw that way (a raster image it has no bytes for) has Source only.
  const renderable = !!rendered || reading || rendersInline(filePath, sides, state);
  const mode = renderable ? prefs.modes.html : "source";
  const layout = sideLayout(sides, frame.width);

  let body: ReactNode;
  if (mode === "source" && raster) {
    // One line for an image's Source mode, whichever surface shows it.
    body = (
      <OverlayCenteredState
        testId={`${prefix}-image-source`}
        // A reason it won't draw replaces the reading state: it is announced.
        role={cannotDraw ? "status" : undefined}
      >
        An image has no text diff. {cannotDraw ? `${cannotDraw}.` : "Side by side compares it."}
      </OverlayCenteredState>
    );
  } else if (reading) {
    body = <CodeSkeleton prefix={prefix} label="Reading the image…" shown />;
  } else if (mode === "source") {
    body = (
      <SourceBody
        filePath={filePath}
        sides={sides}
        state={state}
        prefs={prefs}
        width={frame.width}
        gate={frame.gate}
      />
    );
  } else if (state.kind === "error") {
    body = <ErrorRow prefix={prefix} message={state.message} />;
  } else if (state.kind === "loading") {
    body = <CodeSkeleton prefix={prefix} />;
  } else if (rendered) {
    body = (
      <SideBySide
        sides={sides}
        layout={layout}
        picked={frame.picked}
        prefix={prefix}
        renderSide={(side) => renderRenderedSide(fileType, side, sides, rendered)}
      />
    );
  } else if (sides.before == null || sides.after == null) {
    body = <CodeSkeleton prefix={prefix} />;
  } else {
    body = (
      <LargeDiffGate sides={sides} gate={frame.gate} prefix={prefix}>
        <SideBySide
          sides={sides}
          layout={layout}
          picked={frame.picked}
          prefix={prefix}
          renderSide={(side) => (
            <InlineRenderedSide filePath={filePath} side={side} sides={sides} />
          )}
        />
      </LargeDiffGate>
    );
  }

  const showToggle =
    renderable &&
    mode === "side-by-side" &&
    state.kind !== "loading" &&
    state.kind !== "error" &&
    layout === "toggle";
  // A page drawn from its text has no URL to resolve its linked files against.
  const alone =
    !rendered && mode === "side-by-side" && fileType !== "excalidraw" && rendersFromText(filePath);
  return (
    <DiffFrame
      testId={`${prefix}-rendered`}
      bodyRef={frame.bodyRef}
      header={prefs.header}
      footer={
        alone && (
          <p
            className="flex-none border-t border-border px-3 py-1 text-xs text-muted-foreground"
            data-testid={`${prefix}-rendered-alone`}
          >
            Rendered on its own: linked files such as stylesheets and images aren&apos;t loaded
            here.
          </p>
        )
      }
      strip={
        renderable || cannotDraw ? (
          <DiffStrip
            sides={sides}
            kind="html"
            mode={mode}
            prefs={prefs}
            filePath={filePath}
            unavailableModes={cannotDraw ? { "side-by-side": cannotDraw } : undefined}
            showSwitch
            sideToggle={
              showToggle && (
                <SideToggle sides={sides} picked={frame.picked} onPick={frame.setPicked} />
              )
            }
          />
        ) : (
          // With Source only the body is a code diff, so it takes the code modes.
          <DiffStrip
            sides={sides}
            kind="code"
            mode={prefs.modes.code}
            prefs={prefs}
            filePath={filePath}
            showSwitch={state.kind !== "binary"}
          />
        )
      }
    >
      {body}
    </DiffFrame>
  );
}

/** Whether `text` is an Excalidraw scene's JSON: an object, not just any text. */
function isScene(text: string): boolean {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** A side off Files, from the surface's own text or bytes: nothing it can load
 *  reaches past that side's content. */
function InlineRenderedSide({
  filePath,
  side,
  sides,
}: {
  filePath: string;
  side: Side;
  sides: FileDiffSides;
}) {
  const text = (side === "before" ? sides.before : sides.after) ?? "";
  const label = sideLabel(sides, side);
  if (getViewerFileType(filePath) === "excalidraw") {
    // A scene that won't parse would draw as a blank canvas next to a good side: say so.
    if (!isScene(text))
      return (
        <OverlayCenteredState testId="excalidraw-unreadable">
          <span role="alert">
            Couldn&apos;t read this side&apos;s drawing: it isn&apos;t valid JSON.
          </span>
        </OverlayCenteredState>
      );
    return (
      <ExcalidrawViewer
        key={side}
        filePath={filePath}
        teamContentPath=""
        sceneText={text}
        readOnly
      />
    );
  }
  if (rendersFromText(filePath)) return <SideFrame key={side} html={text} title={label} />;
  return (
    <SideImage key={side} base64={sides.imageBytes?.[side] ?? ""} filePath={filePath} alt={label} />
  );
}

function renderRenderedSide(
  fileType: "html" | "image" | "excalidraw",
  side: Side,
  sides: FileDiffSides,
  rendered: RenderedSides,
): ReactNode {
  const { absPath, teamContentPath, refreshKey, changedPaths } = rendered;
  const baselineSource = side === "before" ? rendered.baselineSource : null;
  switch (fileType) {
    case "excalidraw":
      // Read-only on both sides: a diff is a review surface, and editing would
      // write to the working tree.
      return side === "before" ? (
        <ExcalidrawViewer
          key="before"
          filePath={absPath}
          teamContentPath={teamContentPath}
          sceneText={sides.before}
          changedPaths={changedPaths}
          readOnly
        />
      ) : (
        <ExcalidrawViewer
          key="after"
          filePath={absPath}
          teamContentPath={teamContentPath}
          refreshKey={refreshKey}
          changedPaths={changedPaths}
          readOnly
        />
      );
    case "image":
      return (
        <ImageViewer
          key={side}
          filePath={absPath}
          teamContentPath={teamContentPath}
          refreshKey={refreshKey}
          changedPaths={changedPaths}
          baselineSource={baselineSource}
        />
      );
    case "html":
      return (
        <HtmlViewer
          key={side}
          filePath={absPath}
          teamContentPath={teamContentPath}
          refreshKey={refreshKey}
          changedPaths={changedPaths}
          baselineSource={baselineSource}
          // The working-tree pane would draw a Snapshot band the baseline pane
          // lacks, leaving the two pages misaligned.
          snapshot={false}
        />
      );
    default: {
      const _exhaustive: never = fileType;
      return _exhaustive;
    }
  }
}

function CodeFileDiff({ filePath, sides, state, prefs }: FileDiffArgs) {
  const frame = useFrameState(filePath);
  const prefix = prefs.testIdPrefix ?? "file-diff";
  return (
    <DiffFrame
      testId={`${prefix}-code`}
      bodyRef={frame.bodyRef}
      header={prefs.header}
      strip={
        <DiffStrip
          sides={sides}
          kind="code"
          mode={prefs.modes.code}
          prefs={prefs}
          filePath={filePath}
          showSwitch={state.kind !== "binary"}
        />
      }
    >
      <SourceBody
        filePath={filePath}
        sides={sides}
        state={state}
        prefs={prefs}
        width={frame.width}
        gate={frame.gate}
      />
    </DiffFrame>
  );
}
