// SPDX-License-Identifier: MIT
import { useEffect, useRef, useState } from "react";
import { InboxRole } from "./inbox-role";
import {
  AlertTriangle,
  Archive,
  ArrowRightLeft,
  ArrowUpRight,
  Check,
  CircleAlert,
  ImageIcon,
  ImageOff,
  List,
  MessageSquare,
  Pause,
  Play,
  Reply,
  RotateCw,
  Terminal,
  type LucideIcon,
} from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { isLiveInboxMessage } from "@/features/weft/lib/live-inbox-message";
import { InboxMessageContent } from "@/features/weft/components/inbox-message-content";
import type { InboxLens } from "@/features/viewer/stores/agent-inbox-rail-store";
import { openFileInTeam } from "@/shared/lib/open-file-in-team";
import { pathToTeamContentDirSync } from "@/shared/lib/team-content-path";
import { usePrefersReducedMotion } from "@/shared/lib/use-prefers-reduced-motion";
import { useOrgStore } from "@/shared/stores/org-store";
import {
  bridgeResolveOpenTarget,
  loadInboxMedia,
  readInboxMedia,
  type InboxMediaAttachment,
} from "@/tauri/commands";

import type { ConversationMessage } from "../api";
import { acquireMediaUrl } from "../lib/media-urls";
import {
  dotClass,
  formatClock,
  initials,
  isLive,
  isRoleKey,
  labelOf,
  participant,
  replyToKey,
  type ClaimBadge,
  type Directory,
} from "../model";

/** A key that belongs to an IME composition in progress: ↵ there picks a candidate. */
export function isComposing(e: React.KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

/**
 * Keyboard for a list row: ↑/↓ (and Home/End) move focus between the rows of the nearest
 * `[data-ibx-navscope]`, and Enter or Space activates a row that is not a native button.
 * Spread `navRow(activate)` onto the row; it marks the row and handles its keys.
 */
export function navRow(activate?: () => void) {
  return {
    "data-ibx-nav": "",
    onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      const row = e.currentTarget;
      if ((e.key === "Enter" || e.key === " ") && activate && row.tagName !== "BUTTON") {
        e.preventDefault();
        activate();
        return;
      }
      const moves: Record<string, number> = {
        ArrowDown: 1,
        ArrowUp: -1,
        Home: -Infinity,
        End: Infinity,
      };
      const step = moves[e.key];
      if (step === undefined) return;
      const scope = row.closest("[data-ibx-navscope]") ?? row.parentElement;
      const rows = [...(scope?.querySelectorAll<HTMLElement>("[data-ibx-nav]") ?? [])];
      const i = rows.indexOf(row);
      const j = Math.max(
        0,
        Math.min(
          rows.length - 1,
          Number.isFinite(step) ? i + step : step < 0 ? 0 : rows.length - 1,
        ),
      );
      e.preventDefault();
      rows[j]?.focus();
      rows[j]?.scrollIntoView?.({ block: "nearest" });
    },
  };
}

/** The first read is in flight: say so, so the pane is never blank. */
export function InboxLoading({ what }: { what: string }) {
  return (
    <div className="ibx-empty ibx-loading" role="status" data-testid="ibx-loading">
      Loading {what}…
    </div>
  );
}

/** The first read failed: what failed, the backend's words, and a way to try again. */
export function ReadFailure({
  what,
  error,
  onRetry,
}: {
  what: string;
  error: string;
  onRetry?: () => void;
}) {
  return (
    <div className="ibx-empty" role="alert">
      <strong>Couldn’t read {what}</strong>
      <span className="ibx-err">{error}</span>
      {onRetry && (
        <button type="button" className="ibx-gobtn" data-testid="ibx-read-retry" onClick={onRetry}>
          <Ico icon={RotateCw} sm />
          Try again
        </button>
      )}
    </div>
  );
}

/** A refresh failed after an earlier read landed: keep that read on screen and say it is stale. */
export function StaleNotice({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="ibx-stale" role="alert">
      <Ico icon={AlertTriangle} sm />
      <span className="tx" title={error}>
        Couldn’t refresh the inbox: {error}. Showing the last read.
      </span>
      <button type="button" className="ibx-gobtn" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}

/** A Lucide glyph at the inbox's two sizes (15px, 13px small) and stroke weight. */
export function Ico({ icon: Icon, sm }: { icon: LucideIcon; sm?: boolean }) {
  return <Icon className={sm ? "ibx-ico sm" : "ibx-ico"} strokeWidth={1.75} aria-hidden />;
}

/** A square initials avatar with a state dot; `#` for a role queue, the viewer's mark for the human. */
export function Avatar({
  k,
  dir,
  sm,
  team,
}: {
  k: string;
  dir: Directory;
  sm?: boolean;
  team?: ConversationMessage["team"] | null;
}) {
  const size = sm ? " sm" : "";
  if (isRoleKey(k)) {
    return (
      <span className={`ibx-av role${size}`}>
        <InboxRole role={k.slice(1)} team={team} iconOnly size={sm ? 20 : 28} />
      </span>
    );
  }
  const p = participant(dir, k);
  if (p.kind === "human") {
    return (
      <span className={`ibx-av human${size}`} aria-hidden>
        {p.name === "you" ? "You".slice(0, sm ? 1 : 3) : initials(p.name)}
      </span>
    );
  }
  return (
    <span className={`ibx-av${size}`} style={{ background: p.color }} aria-hidden>
      {initials(p.name)}
      <span className={`ibx-dot st ${dotClass(p.state)}`} />
    </span>
  );
}

/** A small mono tag naming the remote machine a session runs on. */
export function MachineTag({ k, dir }: { k: string; dir: Directory }) {
  const machine = isRoleKey(k) ? null : participant(dir, k).machine;
  return machine ? <span className="ibx-mtag">{machine}</span> : null;
}

/** Why "Go to session" cannot act, or null when it can. */
export function goBlockedReason(k: string, dir: Directory): string | null {
  const p = participant(dir, k);
  if (p.kind === "human") return "That’s you";
  if (p.state === "offline") return "Machine offline, cannot open";
  if (!isLive(p)) return "Session exited, cannot open";
  return null;
}

/**
 * The row hover cluster: Reply and Go to session (disabled with its reason when it cannot),
 * plus Archive where the human reads their own mail.
 */
export function HoverActions({
  k,
  dir,
  onReply,
  onGo,
  onOpen,
  onArchive,
}: {
  k: string;
  dir: Directory;
  onReply: () => void;
  onGo: () => void;
  onOpen?: () => void;
  onArchive?: () => void;
}) {
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  if (isRoleKey(k)) {
    return (
      <div className="ibx-hov">
        <button
          type="button"
          title="Open queue"
          aria-label={`Open ${k}`}
          onClick={stop(onOpen ?? onReply)}
        >
          <Ico icon={Reply} sm />
        </button>
      </div>
    );
  }
  const blocked = goBlockedReason(k, dir);
  const name = participant(dir, k).name;
  return (
    <div className="ibx-hov">
      <button type="button" title="Reply" aria-label={`Reply to ${name}`} onClick={stop(onReply)}>
        <Ico icon={Reply} sm />
      </button>
      <button
        type="button"
        className="go"
        title={blocked ?? `Go to ${name}`}
        aria-label={blocked ? `Go to ${name}: ${blocked}` : `Go to ${name}`}
        aria-disabled={blocked ? true : undefined}
        onClick={stop(() => {
          if (!blocked) onGo();
        })}
      >
        <Ico icon={ArrowUpRight} sm />
      </button>
      {onArchive && (
        <button
          type="button"
          title="Archive"
          aria-label={`Archive ${name}'s message`}
          onClick={stop(onArchive)}
        >
          <Ico icon={Archive} sm />
        </button>
      )}
    </div>
  );
}

/** "Go to session", disabled with its reason when the session cannot be opened. */
export function GoButton({
  k,
  dir,
  onGo,
  label,
}: {
  k: string;
  dir: Directory;
  onGo: () => void;
  label?: string;
}) {
  const blocked = goBlockedReason(k, dir);
  return (
    <button
      type="button"
      className="ibx-gobtn"
      title={blocked ?? label ?? "Go to session"}
      aria-disabled={blocked ? true : undefined}
      onClick={() => {
        if (!blocked) onGo();
      }}
    >
      <Ico icon={ArrowUpRight} sm />
      <span className="lbl">{label ?? "Go to session"}</span>
    </button>
  );
}

/**
 * A message body: terminal-typed text verbatim, anything else through the shared renderer.
 * A message with an image shows it under its text, which renders as a markdown caption
 * whatever its content type, and a message naming a file ends with its Open chip, as the
 * Inbox pane shows them.
 * `liveDashboards`: where the human reads their own conversations (the docked panel and the
 * rollup's conversation), an agent's HTML to the human is a live dashboard whose buttons and
 * forms answer it, as the old conversation view rendered it. Everywhere else (a tab's inbox,
 * an agent's page, Mailspool, Wire) it stays sanitized static HTML, so its scripts run in one
 * place, not once per surface showing it.
 */
export function MessageBody({
  m,
  liveDashboards = false,
}: {
  m: ConversationMessage;
  liveDashboards?: boolean;
}) {
  if (m.via === "terminal") return <>{m.text}</>;
  const live =
    liveDashboards && !m.toRole && isLiveInboxMessage(m)
      ? { team: m.team, messageId: m.id, sender: m.from }
      : null;
  const capTarget =
    m.onClick?.type === "goto-agent" && m.onClick.agent_id.endsWith("#cap")
      ? m.onClick.agent_id.slice(0, -4)
      : null;
  const media = m.attachments?.[0];
  return (
    <>
      {!media ? (
        <InboxMessageContent text={m.text} contentType={m.contentType} live={live} />
      ) : (
        m.text.trim() && <InboxMessageContent text={m.text} contentType="markdown" />
      )}
      {media && <MessageMedia m={m} a={media} />}
      {capTarget && (
        <button
          type="button"
          className="mt-2 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() =>
            void import("@/features/agents/agents-virtual-tab").then(({ openAgentCap }) =>
              openAgentCap(capTarget),
            )
          }
        >
          Review spend cap
        </button>
      )}
      <OpenFileChip m={m} />
    </>
  );
}

/** "GIF" for a GIF or WebP (or an unknown type), else "Image", as the pane names media. */
const mediaKind = (a: InboxMediaAttachment) =>
  !a.mime || /gif|webp/.test(a.mime) ? "GIF" : "Image";

/** Whether an image may move: a GIF or WebP, the types the pane gives a Play button. */
const isAnimated = (a: InboxMediaAttachment) => /gif|webp/.test(a.mime || "");

const FAILURE_REASONS: Record<string, string> = {
  size: "The file is over 8 MB.",
  pixels: "The image dimensions exceed 4096 × 4096.",
  address: "The source resolves to a private or blocked address.",
  cache: "This image is no longer in the cache.",
  type: "It isn't a GIF, WebP, PNG or JPEG.",
  redirect: "It redirected to a site that isn't on the list.",
  https: "The source must use HTTPS.",
};

/** Why an image isn't shown, in the pane's words. */
function mediaReason(a: InboxMediaAttachment, team: string): string {
  if (a.state === "blocked") return `GIF · media is off in ${team}'s team config`;
  if (a.state === "failed") {
    return (
      (a.reason && FAILURE_REASONS[a.reason]) || `${a.sourceHost || "The source"} didn't answer.`
    );
  }
  if (a.reason === "sender") return "GIF · from another person's machine";
  if (a.reason === "ask") return `GIF · ${team} asks before loading`;
  return "GIF · not on your auto-load list";
}

/** A message's image: inline when cached, else a card saying why, with Load or Retry. */
function MessageMedia({ m, a }: { m: ConversationMessage; a: InboxMediaAttachment }) {
  const sha256 = a.sha256 ?? "";
  if (a.state === "cached" && /^[a-f0-9]{64}$/.test(sha256)) {
    return <MediaImage key={sha256} m={m} a={a} sha256={sha256} />;
  }
  return <MediaCard key={a.state} m={m} a={a} />;
}

/** A cached image as an object URL, read through the app (the window can't reach
 *  `/media/v1`) and shared with every other view of the same image; `failed` when it
 *  can't be read. The view's hold is released on unmount. */
function useInboxImage(m: ConversationMessage, sha256: string) {
  const [image, setImage] = useState<{ url: string | null; failed: boolean }>({
    url: null,
    failed: false,
  });
  const { org, team } = m.team;
  useEffect(() => {
    let live = true;
    const hold = acquireMediaUrl(sha256, () => readInboxMedia({ org, team }, m.id, sha256));
    hold.url.then(
      (url) => {
        if (live) setImage({ url, failed: false });
      },
      () => {
        if (live) setImage({ url: null, failed: true });
      },
    );
    return () => {
      live = false;
      hold.release();
    };
  }, [org, team, m.id, sha256]);
  return image;
}

/** The pane's Reduce Motion rule for an animated image: with the OS setting on it shows a
 *  still first frame and a Play button, pressing Play is the only thing that starts it, and
 *  it pauses again once scrolled off-screen or when the setting turns on. With the setting
 *  off it plays on its own. */
function useStillFrame(
  animated: boolean,
  loaded: boolean,
  refs: {
    figure: React.RefObject<HTMLElement | null>;
    image: React.RefObject<HTMLImageElement | null>;
    canvas: React.RefObject<HTMLCanvasElement | null>;
  },
) {
  const reduced = usePrefersReducedMotion() && animated;
  const [playing, setPlaying] = useState(false);
  const [wasReduced, setWasReduced] = useState(reduced);
  if (wasReduced !== reduced) {
    setWasReduced(reduced);
    setPlaying(false);
  }
  const { figure, image, canvas } = refs;
  useEffect(() => {
    const still = canvas.current;
    if (!reduced || !loaded || !image.current || !still) return;
    try {
      still.getContext("2d")?.drawImage(image.current, 0, 0, still.width, still.height);
    } catch {
      // An undecodable frame leaves the canvas blank; Play still shows the image.
    }
  }, [reduced, loaded, image, canvas]);
  useEffect(() => {
    const node = figure.current;
    if (!reduced || !playing || !node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => !e.isIntersecting)) setPlaying(false);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [reduced, playing, figure]);
  return {
    /** Showing the still frame in place of the image. */
    still: reduced && loaded && !playing,
    /** The Play/Pause control, when the image has one. */
    control: reduced && loaded ? { playing, toggle: () => setPlaying((p) => !p) } : null,
  };
}

/** A figure at the image's stored aspect ratio, so the thread never jumps while it loads. */
function MediaFigure({
  a,
  url,
  failed,
  onOpen,
}: {
  a: InboxMediaAttachment;
  url: string | null;
  failed: boolean;
  onOpen?: () => void;
}) {
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  const unavailable = failed || broken;
  const w = a.width || 480;
  const h = a.height || 270;
  const figure = useRef<HTMLElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const motion = useStillFrame(isAnimated(a), loaded, { figure, image, canvas });
  const scale = Math.min(1, 2048 / w, 2048 / h);
  const content = (
    <>
      {url && (
        <img
          ref={image}
          className="ibx-media-img"
          src={url}
          alt={a.alt}
          width={w}
          height={h}
          onLoad={() => setLoaded(true)}
          onError={() => setBroken(true)}
        />
      )}
      {motion.control && (
        <canvas
          ref={canvas}
          className="ibx-media-still"
          width={Math.max(1, Math.floor(w * scale))}
          height={Math.max(1, Math.floor(h * scale))}
          aria-hidden="true"
        />
      )}
      {!loaded && (
        <span className="ibx-media-spin">
          {unavailable ? `Couldn't load this image. ${a.alt}` : `Loading ${mediaKind(a)}…`}
        </span>
      )}
    </>
  );
  return (
    <figure
      ref={figure}
      className={`ibx-media${unavailable ? " unavailable" : loaded ? "" : " loading"}${motion.still ? " still" : ""}`}
      style={{ "--w": w, "--h": h } as React.CSSProperties}
      aria-busy={!loaded && !unavailable}
    >
      {onOpen ? (
        <button
          type="button"
          className="ibx-media-open"
          aria-label={`Open ${mediaKind(a)}: ${a.alt}`}
          aria-haspopup="dialog"
          onClick={onOpen}
        >
          {content}
        </button>
      ) : (
        <div className="ibx-media-open">{content}</div>
      )}
      {motion.control && (
        <button
          type="button"
          className="ibx-media-play"
          aria-pressed={motion.control.playing}
          aria-label={motion.control.playing ? "Pause GIF" : "Play GIF"}
          onClick={motion.control.toggle}
        >
          <Ico icon={motion.control.playing ? Pause : Play} sm />
        </button>
      )}
    </figure>
  );
}

/** A link to the image's source page; nothing when it has no source. */
function MediaSource({ a, children }: { a: InboxMediaAttachment; children: React.ReactNode }) {
  if (!a.sourceUrl) return null;
  return (
    <a href={a.sourceUrl} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

/** A cached image inline; clicking it opens the lightbox. */
function MediaImage({
  m,
  a,
  sha256,
}: {
  m: ConversationMessage;
  a: InboxMediaAttachment;
  sha256: string;
}) {
  const { url, failed } = useInboxImage(m, sha256);
  const [open, setOpen] = useState(false);
  return (
    <>
      <MediaFigure a={a} url={url} failed={failed} onOpen={() => setOpen(true)} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="ibx-lightbox gap-2 sm:max-w-[min(90vw,960px)]"
          aria-describedby={undefined}
          // The lightbox owns Esc; the inbox's own Esc handlers must not also act on it.
          onKeyDown={(e) => {
            if (e.key === "Escape") e.stopPropagation();
          }}
        >
          <DialogTitle className="ibx-lb-head">
            <b>{m.fromName}</b>
            <time>{formatClock(m.createdAtMs)}</time>
          </DialogTitle>
          <MediaFigure a={a} url={url} failed={failed} />
          <div className="ibx-lb-foot">
            <figcaption>{a.alt}</figcaption>
            <div className="row2">
              <span>
                {mediaKind(a)} · {a.width} × {a.height}
              </span>
              <MediaSource a={a}>Open source page · {a.sourceHost} ↗</MediaSource>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** An image not shown (pending, blocked or failed): its alt text, why, and Load, Retry or
 *  its source page. */
function MediaCard({ m, a }: { m: ConversationMessage; a: InboxMediaAttachment }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const icon = a.state === "failed" ? CircleAlert : a.state === "blocked" ? ImageOff : ImageIcon;
  const canLoad = a.state === "pending" || (a.state === "failed" && a.retryable);
  const load = () => {
    setLoading(true);
    setError(null);
    // Once loaded, the stored row changes and the inbox refetches it as cached.
    loadInboxMedia(m.team, m.id).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e));
      setLoading(false);
    });
  };
  const reason = mediaReason(a, m.team.team);
  return (
    <div
      className={`ibx-media-card ${a.state}${loading ? " loading" : ""}`}
      aria-live="polite"
      data-testid="ibx-media-card"
    >
      <Ico icon={icon} sm />
      <div className="alt">{a.alt}</div>
      <div className="meta">
        <span>
          {loading ? (
            "Loading GIF…"
          ) : error ? (
            error
          ) : a.state === "failed" ? (
            <>
              <b>Couldn't load this {mediaKind(a) === "GIF" ? "GIF" : "image"}.</b> {reason}
            </>
          ) : (
            reason
          )}
        </span>
        {canLoad ? (
          <button
            type="button"
            className="ibx-chip primary"
            aria-label={a.state === "failed" ? "Retry" : `Load GIF from ${a.sourceHost}: ${a.alt}`}
            disabled={loading}
            onClick={load}
          >
            {a.state === "failed" ? "Retry" : `Load from ${a.sourceHost}`}
          </button>
        ) : (
          a.state === "blocked" &&
          a.sourceUrl && (
            <span className="ibx-chip">
              <MediaSource a={a}>{a.sourceHost} ↗</MediaSource>
            </span>
          )
        )}
      </div>
    </div>
  );
}

/** The file a message names (its primary file, else its open-file click) as a chip that opens
 *  it in a viewer tab. The path is resolved inside the message's team, as the Inbox pane's
 *  chip resolves it, and opened as the person's own open (it may switch team). */
export function OpenFileChip({ m }: { m: ConversationMessage }) {
  const [error, setError] = useState<string | null>(null);
  const file = m.primaryFile || (m.onClick?.type === "open-file" ? m.onClick.path : null);
  if (!file) return null;
  const open = () => {
    setError(null);
    const { org, team } = m.team;
    const known = useOrgStore
      .getState()
      .orgs.find((o) => o.slug === org && o.teams.some((t) => t.name === team));
    if (!known) {
      setError("unavailable: unknown synced team");
      return;
    }
    const page = `${pathToTeamContentDirSync(known.org_root, team)}/inbox.html`;
    bridgeResolveOpenTarget(page, file, team)
      .then((target) => openFileInTeam(target))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };
  return (
    <div className="ibx-files">
      <button type="button" className="ibx-chip" title={`Open ${file}`} onClick={open}>
        {file}
      </button>
      {error && (
        <span className="ibx-err" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Whether `m` carries the "typed into terminal" marker. */
export const hasTypedVia = (m: ConversationMessage): boolean => m.via === "terminal";

/** Where replies to `m` go when its sender set a Reply-To other than itself, else null. */
export const repliesViaKey = (m: ConversationMessage): string | null => {
  const key = replyToKey(m);
  return key && key !== m.from ? key : null;
};

/** The dashed "typed into terminal" marker. */
export function TypedVia() {
  return (
    <span className="ibx-via" data-testid="ibx-typed-via">
      <Ico icon={Terminal} sm />
      typed into terminal
    </span>
  );
}

/** "Replies go to …" for a message whose Reply-To (`to`, from {@link repliesViaKey}) is not its
 *  sender; nothing when `to` is null. */
export function RepliesVia({
  to,
  dir,
  team,
}: {
  to: string | null;
  dir: Directory;
  team?: ConversationMessage["team"];
}) {
  if (!to) return null;
  return (
    <span
      className="ibx-via"
      data-testid="ibx-replies-go-to"
      title="Replies go here, not to the sender"
    >
      <Ico icon={Reply} sm />
      replies go to{" "}
      {isRoleKey(to) ? <InboxRole role={to.slice(1)} team={team} /> : labelOf(dir, to)}
    </span>
  );
}

/** A role message's claim state (`badge`, from `claimBadge`): queued (violet) or claimed (green). */
export function ClaimVia({ badge }: { badge: ClaimBadge | null }) {
  if (!badge) return null;
  const cls = badge.kind === "claimed" ? "claimed" : badge.kind === "queued" ? "queued" : "";
  return (
    <span className={`ibx-via ${cls}`} data-testid="ibx-claim">
      <Ico icon={badge.kind === "claimed" ? Check : Reply} sm />
      {badge.label}
    </span>
  );
}

export const LENSES: { key: InboxLens; icon: LucideIcon; label: string }[] = [
  { key: "threads", icon: MessageSquare, label: "Threads" },
  { key: "spool", icon: List, label: "Mailspool" },
  { key: "wire", icon: ArrowRightLeft, label: "Wire" },
];

/** The segmented Threads | Mailspool | Wire switch. */
export function LensSwitch({
  lens,
  onChange,
  label,
}: {
  lens: InboxLens;
  onChange: (lens: InboxLens) => void;
  label: string;
}) {
  return (
    <div className="ibx-lens" role="group" aria-label={label}>
      {LENSES.map((l) => (
        <button
          key={l.key}
          type="button"
          aria-pressed={lens === l.key}
          title={l.label}
          onClick={() => onChange(l.key)}
        >
          <Ico icon={l.icon} sm />
          <span>{l.label}</span>
        </button>
      ))}
    </div>
  );
}
