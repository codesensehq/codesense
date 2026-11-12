// SPDX-License-Identifier: MIT
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";

import { parseMarkdown } from "@/shared/lib/markdown-worker/client";

/**
 * One side of a side-by-side markdown diff: renders a string through
 * the markdown worker, read-only, the way `RedlineProse` renders a redline.
 * It reads no file and owns no editor state, so a side from a git rev, a PR or
 * another machine renders the same as the working tree. Callers own the chrome.
 */
type Parsed = { phase: "error"; message: string } | { phase: "ready"; node: ReactNode };

export function RenderedMarkdown({
  text,
  className,
  style,
}: {
  text: string;
  className?: string;
  style?: CSSProperties;
}): React.JSX.Element {
  const [result, setResult] = useState<Parsed | null>(null);

  useEffect(() => {
    let cancelled = false;
    const handle = parseMarkdown(text);
    handle.promise
      .then((hast) => {
        if (!cancelled)
          setResult({ phase: "ready", node: toJsxRuntime(hast, { Fragment, jsx, jsxs }) });
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setResult({ phase: "error", message: e instanceof Error ? e.message : String(e) });
        }
      });
    return () => {
      cancelled = true;
      handle.cancel();
    };
  }, [text]);

  return (
    <div className={className} style={style}>
      {result == null ? (
        <div className="space-y-2" aria-hidden>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-5 animate-pulse rounded bg-muted/50" />
          ))}
        </div>
      ) : result.phase === "error" ? (
        <p className="text-sm text-destructive">Couldn’t render: {result.message}</p>
      ) : (
        result.node
      )}
    </div>
  );
}
