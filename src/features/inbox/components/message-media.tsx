// SPDX-License-Identifier: MIT
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { CircleAlert, ImageIcon, ImageOff, Pause, Play } from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { usePrefersReducedMotion } from "@/shared/lib/use-prefers-reduced-motion";
import type { InboxMediaAttachment } from "@/tauri/commands";

import { acquireMediaUrl } from "../lib/media-urls";
import { formatClock } from "../model";
import { Ico } from "./ico";

/** Where a bubble's image comes from: the inbox and the workspace chat each pass their own. */
export interface MediaLoader {
  /** The bytes of the cached image `sha256` on this message. */
  read: (sha256: string) => Promise<Blob>;
  /** Load the message's held or failed image; the stored row changes once it lands. */
  load: () => Promise<void>;
  /** The team whose media config governs the image, as the cards name it; null when the
   *  message names no team. */
  teamLabel: string | null;
  /** The machine a remote sender runs on, when its row names one. */
  machine?: string | null;
}

/** Who sent the image and when, for the lightbox's header and name. */
export interface MediaSender {
  name: string;
  atMs: number;
}

/** Whether an image may move: a GIF or WebP, the types the pane gives a Play button. */
const isAnimated = (a: InboxMediaAttachment) => /gif|webp/.test(a.mime || "");

/** "GIF" for a GIF or WebP (or an unknown type), else "Image", as the pane names media. */
export const mediaKind = (a: InboxMediaAttachment) => (!a.mime || isAnimated(a) ? "GIF" : "Image");

export const FAILURE_REASONS: Record<string, string> = {
  size: "The file is over 8 MB.",
  pixels: "The image dimensions exceed 4096 × 4096.",
  address: "The source resolves to a private or blocked address.",
  cache: "This image is no longer in the cache.",
  type: "It isn't a GIF, WebP, PNG or JPEG.",
  redirect: "It redirected to a site that isn't on the list.",
  https: "The source must use HTTPS.",
  changed: "The source now serves a different image.",
};

/** Whether `host` is `domain` or one of its subdomains. */
const onDomain = (host: string, domain: string) => host === domain || host.endsWith("." + domain);

/** Whose attribution an image carries, in every state: the sender's provider claim, else the
 *  provider whose host the bytes came from (which covers redirects), else (an old message, or
 *  one never fetched) the provider whose host the URL names. The app's own rule. */
export function attributionOf(a: InboxMediaAttachment): "giphy" | "klipy" | null {
  const host = (a.sourceHost || "").toLowerCase().replace(/\.$/, "");
  const byHost = onDomain(host, "giphy.com")
    ? "giphy"
    : onDomain(host, "klipy.com")
      ? "klipy"
      : null;
  const provider = a.provider ?? a.mediaProvider ?? byHost;
  return provider === "giphy" || provider === "klipy" ? provider : null;
}

/** Why an image isn't shown, in the pane's words. `machine` names a remote sender's machine. */
export function mediaReason(
  a: InboxMediaAttachment,
  team: string | null,
  machine?: string | null,
): string {
  const kind = mediaKind(a);
  if (a.state === "blocked" || a.reason === "off") {
    return team
      ? `${kind} · media is off in ${team}'s team config`
      : `${kind} · media is off in the team config`;
  }
  if (a.state === "failed") {
    return (
      (a.reason && FAILURE_REASONS[a.reason]) || `${a.sourceHost || "The source"} didn't answer.`
    );
  }
  if (a.reason === "sender") {
    return machine
      ? `${kind} · sent from ${machine}, not loaded here yet`
      : `${kind} · from another person's machine`;
  }
  if (a.reason === "ask") return `${kind} · ${team ?? "the team"} asks before loading`;
  return `${kind} · not on your auto-load list`;
}

/** Whether `a` is a cached image this view can read: cached, with a well-formed hash. */
export const isCachedImage = (a: InboxMediaAttachment): boolean =>
  a.state === "cached" && /^[a-f0-9]{64}$/.test(a.sha256 ?? "");

/** The failed card an image shows when its bytes won't decode. */
const damaged = (a: InboxMediaAttachment): InboxMediaAttachment => ({
  ...a,
  state: "failed",
  reason: "decode",
  retryable: false,
});

/** A message's image: inline when cached, else a card saying why, with Load or Retry.
 *  `maxHeight` caps the inline figure's height (the inbox's box is 280px). Only a card the
 *  person tapped Load on carries a live region, which then announces how the load ended. */
export function MessageMedia({
  a,
  loader,
  sender,
  maxHeight,
}: {
  a: InboxMediaAttachment;
  loader: MediaLoader;
  sender?: MediaSender;
  maxHeight?: number;
}) {
  // Whether the person tapped Load here. The card's status line is then the live region; once
  // the card gives way to the image (or the figure it loads into), `region` takes over.
  const [tapped, setTapped] = useState(false);
  const sha256 = a.sha256 ?? "";
  const cached = isCachedImage(a);
  const media = cached ? (
    <MediaImage
      key={sha256}
      a={a}
      sha256={sha256}
      loader={loader}
      sender={sender}
      maxHeight={maxHeight}
    />
  ) : a.state === "loading" ? (
    <MediaFigure a={a} url={null} failed={false} maxHeight={maxHeight} />
  ) : (
    <MediaCard a={a} loader={loader} live={tapped} onLoad={() => setTapped(true)} />
  );
  const afterCard = tapped && (cached || a.state === "loading");
  const announcement = cached ? `${mediaKind(a)} loaded: ${a.alt}` : `Loading ${mediaKind(a)}…`;
  // The region mounts empty and is filled after, so a screen reader hears what changed.
  const region = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (region.current) region.current.textContent = announcement;
  }, [afterCard, announcement]);
  // GIPHY's terms ask for a conspicuous "Powered by GIPHY", in every state.
  return (
    <>
      {media}
      {afterCard && (
        <div ref={region} className="sr-only" aria-live="polite" data-testid="ibx-media-live" />
      )}
      {attributionOf(a) === "giphy" && <div className="ibx-media-attr">Powered by GIPHY</div>}
    </>
  );
}

/** A cached image as an object URL, read through `read` (the window can't reach
 *  `/media/v1`) and shared with every other view of the same image; `failed` when it
 *  can't be read. The view's hold is released on unmount. */
function useMediaImage(read: MediaLoader["read"], sha256: string) {
  const [image, setImage] = useState<{ url: string | null; failed: boolean }>({
    url: null,
    failed: false,
  });
  const readBytes = useEffectEvent(() => read(sha256));
  useEffect(() => {
    let live = true;
    const hold = acquireMediaUrl(sha256, readBytes);
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
  }, [sha256]);
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

/** A figure at the image's stored aspect ratio, so the thread never jumps while it loads.
 *  With no `url` and no failure it is the loading figure of an image still on its way.
 *  `onBroken` hears when the image's bytes won't decode. */
function MediaFigure({
  a,
  url,
  failed,
  onOpen,
  onBroken,
  maxHeight,
  lazy = false,
}: {
  a: InboxMediaAttachment;
  url: string | null;
  failed: boolean;
  onOpen?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  onBroken?: () => void;
  maxHeight?: number;
  lazy?: boolean;
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
  const pending = a.state === "loading";
  const style = { "--w": w, "--h": h } as Record<string, string | number>;
  if (maxHeight) style["--max-h"] = `${maxHeight}px`;
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
          loading={lazy ? "lazy" : undefined}
          onLoad={() => setLoaded(true)}
          onError={() => {
            setBroken(true);
            onBroken?.();
          }}
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
        // A loading figure is named by its label; the copy repeats it for sighted readers.
        <span className="ibx-media-spin" aria-hidden={pending || undefined}>
          {unavailable
            ? `Couldn't load this image. ${a.alt}`
            : pending
              ? `Loading ${mediaKind(a)} · ${a.alt}`
              : `Loading ${mediaKind(a)}…`}
        </span>
      )}
    </>
  );
  return (
    <figure
      ref={figure}
      className={`ibx-media${unavailable ? " unavailable" : loaded ? "" : " loading"}${motion.still ? " still" : ""}`}
      style={style as React.CSSProperties}
      aria-busy={!loaded && !unavailable}
      aria-label={pending ? `Loading ${mediaKind(a)}: ${a.alt}` : undefined}
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

/** A cached image inline; clicking it opens the lightbox. An image whose bytes won't decode
 *  becomes the failed card. */
function MediaImage({
  a,
  sha256,
  loader,
  sender,
  maxHeight,
}: {
  a: InboxMediaAttachment;
  sha256: string;
  loader: MediaLoader;
  sender?: MediaSender;
  maxHeight?: number;
}) {
  const { url, failed } = useMediaImage(loader.read, sha256);
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState(false);
  // The Open button, which gets focus back when the lightbox closes.
  const trigger = useRef<HTMLButtonElement | null>(null);
  if (broken) return <MediaCard a={damaged(a)} loader={loader} />;
  const kind = mediaKind(a);
  const time = sender ? formatClock(sender.atMs) : "";
  return (
    <>
      <MediaFigure
        a={a}
        url={url}
        failed={failed}
        onOpen={(e) => {
          trigger.current = e.currentTarget;
          setOpen(true);
        }}
        onBroken={() => setBroken(true)}
        maxHeight={maxHeight}
        lazy
      />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          className="ibx-lightbox gap-2 sm:max-w-[min(90vw,960px)]"
          aria-describedby={undefined}
          // The lightbox owns Esc; the inbox's own Esc handlers must not also act on it.
          onKeyDown={(e) => {
            if (e.key === "Escape") e.stopPropagation();
          }}
          onCloseAutoFocus={(e) => {
            if (!trigger.current?.isConnected) return;
            e.preventDefault();
            trigger.current.focus();
          }}
        >
          <DialogTitle
            className="ibx-lb-head"
            aria-label={sender ? `${kind} from ${sender.name}, ${time}` : kind}
          >
            {sender && (
              <>
                <b>{sender.name}</b>
                <time>{time}</time>
              </>
            )}
          </DialogTitle>
          <MediaFigure a={a} url={url} failed={failed} />
          <div className="ibx-lb-foot">
            <figcaption>{a.alt}</figcaption>
            <div className="row2">
              <span>
                {kind} · {a.width} × {a.height}
                {attributionOf(a) === "klipy" && " · via KLIPY"}
                {attributionOf(a) === "giphy" && " · Powered by GIPHY"}
              </span>
              <MediaSource a={a}>Open source page · {a.sourceHost} ↗</MediaSource>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** An image not shown (held, blocked or failed): its alt text, why, and Load, Retry or its
 *  source page. `tapToLoad` (the chat's held image) shows as the inbox's `pending`. `onLoad`
 *  hears each tap; `live` makes the status line a live region, for the card tapped. */
function MediaCard({
  a,
  loader,
  live = false,
  onLoad,
}: {
  a: InboxMediaAttachment;
  loader: MediaLoader;
  live?: boolean;
  onLoad?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A new state (the load settled as failed, say) ends this card's own load.
  const [shown, setShown] = useState(a.state);
  if (shown !== a.state) {
    setShown(a.state);
    setLoading(false);
    setError(null);
  }
  const state = a.state === "tapToLoad" ? "pending" : a.state;
  const icon = state === "failed" ? CircleAlert : state === "blocked" ? ImageOff : ImageIcon;
  // Media that is off in the team's config can't be loaded from here.
  const canLoad =
    (state === "pending" && a.reason !== "off") || (state === "failed" && a.retryable);
  const decode = state === "failed" && a.reason === "decode";
  const load = () => {
    setLoading(true);
    setError(null);
    onLoad?.();
    // Once loaded, the stored row changes and the view refetches it as cached.
    loader.load().catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      setLoading(false);
    });
  };
  const reason = mediaReason({ ...a, state }, loader.teamLabel, loader.machine);
  const noun = mediaKind(a) === "GIF" ? "GIF" : "image";
  return (
    <div
      className={`ibx-media-card ${state}${loading ? " loading" : ""}`}
      data-testid="ibx-media-card"
    >
      <Ico icon={icon} sm />
      <div className="alt">{a.alt}</div>
      <div className="meta">
        <span aria-live={live ? "polite" : undefined}>
          {loading ? (
            `Loading ${mediaKind(a)}…`
          ) : error ? (
            error
          ) : decode ? (
            <>
              <b>Couldn't show this {noun}.</b> The file is damaged.
            </>
          ) : state === "failed" ? (
            <>
              <b>Couldn't load this {noun}.</b> {reason}
            </>
          ) : (
            reason
          )}
        </span>
        {canLoad ? (
          <button
            type="button"
            className="ibx-chip primary"
            aria-label={
              state === "failed" ? "Retry" : `Load ${mediaKind(a)} from ${a.sourceHost}: ${a.alt}`
            }
            disabled={loading}
            onClick={load}
          >
            {state === "failed" ? "Retry" : `Load from ${a.sourceHost}`}
          </button>
        ) : (
          (state === "blocked" || decode) &&
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
