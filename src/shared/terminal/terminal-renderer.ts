// SPDX-License-Identifier: MIT
/**
 * Which renderer terminal displays may use, decided once per webview.
 *
 * Under WebKitGTK the WebGL addon can activate, throw nothing, never lose its
 * context and still show no glyphs: every pane shows its background and no
 * text. Two known ways: glyph texture sampling fails on WebKit's WebGL2, and
 * WebKitGTK shows a WebGL canvas one draw behind unless `preserveDrawingBuffer`
 * is set. Neither throws, so on Linux the DOM renderer is the default. A render
 * probe still runs there (`probeWebglRender` in the terminal manager): a
 * scratch terminal draws known glyphs through the addon and its canvas is read
 * back. Its verdict goes to the log only, as evidence of the first kind; it
 * reads back within the frame that drew, so it cannot see the second.
 * Elsewhere WebGL is used without a probe, as before.
 *
 * `CODESENSE_TERMINAL_RENDERER=dom|webgl`, which the app injects as
 * `window.__CODESENSE_TERMINAL_RENDERER__`, forces the renderer and skips the
 * probe. On Linux, WebGL is then made with `preserveDrawingBuffer`.
 *
 * The decision is logged once: `terminal renderer: webgl|dom (probe: …)`.
 */
declare global {
  interface Window {
    __CODESENSE_TERMINAL_RENDERER__?: string | null;
  }
}

export type TerminalRendererKind = "webgl" | "dom";
/** `ok`: a glyph drew. `blank`: frames rendered and nothing was lit. `error`:
 *  no context, a throw, a lost context or no frame at all. */
export type RenderProbeVerdict = "ok" | "blank" | "error";

export interface TerminalRendererChoice {
  renderer: TerminalRendererKind;
  /** `skipped`: no probe ran. `pending`: it is running. */
  probe: RenderProbeVerdict | "skipped" | "pending";
  /** The forced renderer, when the override decided. */
  override?: TerminalRendererKind;
}

/** A renderer name the override accepts, or `null`. */
export function parseRendererOverride(value: unknown): TerminalRendererKind | null {
  return value === "dom" || value === "webgl" ? value : null;
}

export function rendererLogLine(choice: TerminalRendererChoice): string {
  const line = `terminal renderer: ${choice.renderer} (probe: ${choice.probe})`;
  return choice.override ? `${line}, CODESENSE_TERMINAL_RENDERER=${choice.override}` : line;
}

/** The renderer: the override when set, else DOM on Linux and WebGL elsewhere. */
export function chooseRenderer(
  override: TerminalRendererKind | null,
  linux: boolean,
): TerminalRendererKind {
  return override ?? (linux ? "dom" : "webgl");
}

/** Whether the render probe runs: on Linux, unless the override decided. */
export function probeRuns(override: TerminalRendererKind | null, linux: boolean): boolean {
  return linux && !override;
}

export function isLinuxPlatform(platform: string | undefined): boolean {
  return !!platform && /linux/i.test(platform) && !/android/i.test(platform);
}

export interface TerminalRendererGateDeps {
  override: () => TerminalRendererKind | null;
  linux: () => boolean;
  probe: () => Promise<RenderProbeVerdict>;
  log: (line: string) => void;
}

export interface TerminalRendererGate {
  /** Whether displays may take WebGL. The first call decides, at once, and logs
   *  the decision (after the probe, when it runs). */
  allowsWebgl(): boolean;
  /** The decision, once made; `probe` is `pending` while the probe runs. */
  readonly choice: TerminalRendererChoice | null;
}

export function createTerminalRendererGate(deps: TerminalRendererGateDeps): TerminalRendererGate {
  let choice: TerminalRendererChoice | null = null;
  const decide = (): TerminalRendererChoice => {
    const override = deps.override();
    const linux = deps.linux();
    const renderer = chooseRenderer(override, linux);
    const base = override ? { renderer, override } : { renderer };
    if (!probeRuns(override, linux)) {
      const decided: TerminalRendererChoice = { ...base, probe: "skipped" };
      deps.log(rendererLogLine(decided));
      return decided;
    }
    const pending: TerminalRendererChoice = { ...base, probe: "pending" };
    void deps
      .probe()
      .catch((): RenderProbeVerdict => "error")
      .then((verdict) => {
        pending.probe = verdict;
        deps.log(rendererLogLine(pending));
      });
    return pending;
  };
  return {
    allowsWebgl() {
      choice ??= decide();
      return choice.renderer === "webgl";
    },
    get choice() {
      return choice;
    },
  };
}
