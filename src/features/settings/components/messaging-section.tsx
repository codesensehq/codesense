// SPDX-License-Identifier: MIT
/**
 * Settings → Messaging: the GIF search card. On or Off, the GIPHY key (kept in the Keychain,
 * entered only here), whether it is a production key, and the rating ceiling. The key row
 * explains itself through `CapabilityOff` where there is no secret store, and still counts in
 * search and the sidebar.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { rowMatches, type SettingRowSpec } from "@/features/settings/lib/row-matches";
import { GIF_KEY_IN_KEYCHAIN } from "@/features/settings/lib/keychain-copy";
import { CapabilityOff } from "@/shared/components/capability-off/capability-off";
import { useCapability } from "@/shared/lib/capabilities";
import * as api from "@/tauri/commands";
import type { GifKeyStatus, GifRating, GifSettings, GifSettingsUpdate } from "@/tauri/commands";

import { SectionHeader } from "./section-header";
import { SettingRow } from "./setting-row";

export const GIPHY_TERMS_URL =
  "https://support.giphy.com/hc/en-us/articles/360028134111-GIPHY-API-Terms-of-Service-";

export const MESSAGING_ROW_SPECS: readonly SettingRowSpec[] = [
  {
    key: "gifSearch",
    label: "Provider",
    keywords: ["gif search", "gif", "giphy", "meme", "messaging", "media"],
  },
  {
    key: "gifKey",
    label: "GIPHY key",
    keywords: ["gif", "giphy", "api key", "keychain", "production", "rate limit"],
  },
  {
    key: "gifRating",
    label: "Rating ceiling",
    keywords: ["gif", "giphy", "rating", "pg-13", "content rating"],
  },
];

const RATINGS = [
  { value: "g", label: "G" },
  { value: "pg", label: "PG" },
  { value: "pg-13", label: "PG-13" },
] as const satisfies readonly { value: GifRating; label: string }[];

export function MessagingSection({ query = "" }: { query?: string }) {
  const shown = new Set(
    MESSAGING_ROW_SPECS.filter((spec) => rowMatches(spec, query)).map((spec) => spec.key),
  );
  if (shown.size === 0) return null;
  return (
    <section>
      <SectionHeader id="messaging">Messaging</SectionHeader>
      <GifSearchCard shown={shown} />
    </section>
  );
}

function GifSearchCard({ shown }: { shown: ReadonlySet<string> }) {
  const secretStore = useCapability("secret-store");
  const [settings, setSettings] = useState<GifSettings | null>(null);
  const [key, setKey] = useState<GifKeyStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const read = await api.gifSettingsGet();
        if (live) setSettings(read);
      } catch (e) {
        if (live) setError(String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // The one key read that may raise a Keychain access prompt, while the user is here to allow it.
  const readKey = useCallback(async () => {
    try {
      setKey(await api.gifKeyStatus());
    } catch {
      setKey({ status: "unavailable", hint: null, production: false });
    }
  }, []);
  useEffect(() => {
    if (secretStore.on) void readKey();
  }, [secretStore.on, readKey]);

  const run = async <T,>(call: () => Promise<T>, apply: (value: T) => void) => {
    setBusy(true);
    setError("");
    try {
      apply(await call());
      return true;
    } catch (e) {
      setError(String(e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const change = (update: GifSettingsUpdate) =>
    run(
      () => api.gifSettingsSet(update),
      (next) => {
        setSettings(next);
        const production = update.production;
        if (production !== undefined) setKey((k) => k && { ...k, production });
      },
    );

  return (
    <div
      role="group"
      aria-label="GIF search"
      data-testid="gif-search-card"
      className="mt-4 rounded-lg border border-border px-4"
    >
      <div className="pt-3">
        <h3 className="text-sm font-semibold text-foreground">GIF search</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Agents can search GIPHY for a GIF to send with a message. Each search goes from this
          computer straight to GIPHY with your key.
        </p>
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
      {shown.has("gifSearch") && (
        <SettingRow label="Provider" target="gifSearch">
          <Segmented
            aria-label="GIF search provider"
            value={settings ? (settings.enabled ? "giphy" : "off") : "giphy"}
            onValueChange={(v) => void change({ enabled: v === "giphy" })}
            options={[
              { value: "giphy", label: "GIPHY", disabled: !settings || busy },
              { value: "off", label: "Off", disabled: !settings || busy },
            ]}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            With Off, agents get no GIF results and nothing is sent to GIPHY.
          </p>
        </SettingRow>
      )}
      {shown.has("gifKey") && (
        <SettingRow label="GIPHY key" target="gifKey">
          <CapabilityOff cap="secret-store">
            <KeyRow
              status={key}
              busy={busy}
              onRetry={() => void readKey()}
              onSave={(value) => run(() => api.gifKeySave(value), setKey)}
              onRemove={() => run(api.gifKeyRemove, setKey)}
              onProduction={(production) => void change({ production })}
            />
          </CapabilityOff>
        </SettingRow>
      )}
      {shown.has("gifRating") && (
        <SettingRow label="Rating ceiling" target="gifRating">
          <Segmented
            aria-label="Rating ceiling"
            value={settings?.ceiling ?? "pg"}
            onValueChange={(ceiling) => void change({ ceiling })}
            options={RATINGS.map((r) => ({ ...r, disabled: !settings || busy }))}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Agents never get a GIF rated above this. PG is the default; R is never offered.
          </p>
        </SettingRow>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs text-muted-foreground">
        <span>Powered By GIPHY</span>
        <button
          type="button"
          className="underline underline-offset-4 hover:text-foreground"
          onClick={() => void openUrl(GIPHY_TERMS_URL)}
        >
          GIPHY API terms
        </button>
      </div>
    </div>
  );
}

function KeyRow({
  status,
  busy,
  onRetry,
  onSave,
  onRemove,
  onProduction,
}: {
  status: GifKeyStatus | null;
  busy: boolean;
  onRetry: () => void;
  onSave: (key: string) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
  onProduction: (production: boolean) => void;
}) {
  const field = useRef<HTMLInputElement>(null);
  const [replacing, setReplacing] = useState(false);
  const [visible, setVisible] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [empty, setEmpty] = useState(false);
  if (!status) return <p className="pt-1 text-sm text-muted-foreground">Checking the key…</p>;
  const saved = status.status === "saved";
  const editing = replacing || status.status === "missing";
  return (
    <div className="space-y-2 text-sm">
      {saved && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-foreground">Key saved</span>
          <span className="font-mono text-xs text-muted-foreground">{status.hint}</span>
          <div className="ml-auto flex gap-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setReplacing(true);
                setTimeout(() => field.current?.focus(), 0);
              }}
            >
              Replace
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
              Remove
            </Button>
          </div>
        </div>
      )}
      {status.status === "missing" && (
        <p className="text-muted-foreground">
          No key yet. Paste the API key from your GIPHY developer dashboard.
        </p>
      )}
      {status.status === "unavailable" && (
        <p className="text-muted-foreground">
          Couldn't read the key from your Keychain. If your Mac asked to allow access, allow it,
          then{" "}
          <button
            type="button"
            className="underline underline-offset-4"
            disabled={busy}
            onClick={onRetry}
          >
            try again
          </button>
          .
        </p>
      )}
      {confirming && (
        <div role="alertdialog" aria-label="Remove the GIPHY key" className="space-y-2">
          <p>Remove the GIPHY key? Agents can't search GIFs until you add one.</p>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="destructive"
              disabled={busy}
              onClick={() => void onRemove().then(() => setConfirming(false))}
            >
              Remove key
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
      {editing && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = (field.current?.value ?? "").trim();
            setEmpty(value === "");
            if (value === "") return;
            if (field.current) field.current.value = "";
            setVisible(false);
            void onSave(value).then((ok) => ok && setReplacing(false));
          }}
        >
          <div className="flex flex-wrap gap-2">
            <Input
              ref={field}
              aria-label="GIPHY API key"
              type={visible ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder="Paste your GIPHY API key"
              disabled={busy}
              className="min-w-32 flex-1"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => setVisible(!visible)}
            >
              {visible ? "Hide" : "Show"}
            </Button>
            <Button type="submit" size="sm" disabled={busy}>
              Save key
            </Button>
            {replacing && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setReplacing(false)}
              >
                Cancel
              </Button>
            )}
          </div>
          {empty && (
            <p role="alert" className="text-destructive">
              Enter a GIPHY key.
            </p>
          )}
        </form>
      )}
      <p className="text-xs text-muted-foreground">{GIF_KEY_IN_KEYCHAIN}</p>
      {saved && (
        <div className="space-y-1">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={status.production}
              disabled={busy}
              onChange={(e) => onProduction(e.target.checked)}
            />
            This is a production key
          </label>
          <p className="text-xs text-muted-foreground">
            A GIPHY beta key allows 100 searches an hour, so CodeSense stops at 90. A production key
            has no limit here. Replacing the key clears this.
          </p>
        </div>
      )}
    </div>
  );
}
