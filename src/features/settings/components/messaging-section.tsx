// SPDX-License-Identifier: MIT
/**
 * Settings → Messaging: the GIF search card. Off, GIPHY or KLIPY; the chosen provider's key
 * (kept in the OS keychain, entered only here), whether it is a production key, and the rating
 * ceiling. With Off, a Keys row lists each provider's key from files alone, with no keychain
 * read. The key row explains itself through `CapabilityOff` where there is no secret store, and
 * still counts in search and the sidebar.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { rowMatches, type SettingRowSpec } from "@/features/settings/lib/row-matches";
import { gifKeyInKeychain } from "@/features/settings/lib/keychain-copy";
import { CapabilityOff } from "@/shared/components/capability-off/capability-off";
import { useCapability } from "@/shared/lib/capabilities";
import { GIF_PROVIDER_IDS, GIF_PROVIDERS, type GifProviderId } from "@/shared/lib/gif-providers";
import * as api from "@/tauri/commands";
import type { GifKeyStatus, GifRating, GifSettings, GifSettingsUpdate } from "@/tauri/commands";

import { SectionHeader } from "./section-header";
import { SettingRow } from "./setting-row";

export const MESSAGING_ROW_SPECS: readonly SettingRowSpec[] = [
  {
    key: "gifSearch",
    label: "Provider",
    keywords: ["gif search", "gif", "giphy", "klipy", "meme", "messaging", "media"],
  },
  {
    key: "gifKey",
    label: "GIF key",
    keywords: [
      "gif",
      "giphy key",
      "klipy key",
      "giphy",
      "klipy",
      "api key",
      "keys",
      "keychain",
      "production",
      "rate limit",
    ],
  },
  {
    key: "gifRating",
    label: "Rating ceiling",
    keywords: ["gif", "giphy", "klipy", "rating", "pg-13", "content rating"],
  },
];

const RATINGS = [
  { value: "g", label: "G" },
  { value: "pg", label: "PG" },
  { value: "pg-13", label: "PG-13" },
] as const satisfies readonly { value: GifRating; label: string }[];

const UNAVAILABLE: GifKeyStatus = { status: "unavailable", hint: null, production: false };

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
  const [settingsFailed, setSettingsFailed] = useState(false);
  // The chosen provider's key status, with the provider it was read for.
  const [read, setRead] = useState<{ provider: GifProviderId; status: GifKeyStatus } | null>(null);
  // With Off: each provider's key status, from files alone.
  const [offKeys, setOffKeys] = useState<Partial<Record<GifProviderId, GifKeyStatus>>>({});
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const active: GifProviderId | null = settings?.enabled ? settings.provider : null;
  const key = read && read.provider === active ? read.status : null;
  // Each key read, save and remove takes a number; only the latest may set the key status, so a
  // slow first read never overwrites a newer save or remove, nor a read for the provider
  // switched from.
  const keySeq = useRef(0);
  const keyCall = (provider: GifProviderId, call: () => Promise<GifKeyStatus>) => {
    const seq = ++keySeq.current;
    return call().then((status) => {
      if (seq === keySeq.current) setRead({ provider, status });
      return status;
    });
  };

  const readSettings = useCallback(async () => {
    try {
      setSettings(await api.gifSettingsGet());
      setSettingsFailed(false);
    } catch {
      setSettingsFailed(true);
    }
  }, []);
  useEffect(() => {
    void readSettings();
  }, [readSettings]);

  // The one key read that may raise a keychain access prompt, while the user is here to allow
  // it. It reads only the chosen provider's entry.
  const readKey = useCallback(async (provider: GifProviderId) => {
    const seq = ++keySeq.current;
    let status: GifKeyStatus;
    try {
      status = await api.gifKeyStatus(provider);
    } catch {
      status = UNAVAILABLE;
    }
    if (seq === keySeq.current) setRead({ provider, status });
  }, []);
  useEffect(() => {
    if (secretStore.on && active) void readKey(active);
  }, [secretStore.on, active, readKey]);

  const readOffKeys = useCallback(async () => {
    const read = await Promise.all(
      GIF_PROVIDER_IDS.map((p) => api.gifKeyStatus(p).catch(() => UNAVAILABLE)),
    );
    setOffKeys(Object.fromEntries(GIF_PROVIDER_IDS.map((p, i) => [p, read[i]])));
  }, []);
  const off = settings !== null && !settings.enabled;
  useEffect(() => {
    if (secretStore.on && off) void readOffKeys();
  }, [secretStore.on, off, readOffKeys]);

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
        if (production !== undefined)
          setRead((r) => r && { ...r, status: { ...r.status, production } });
      },
    );
  const choose = (value: GifProviderId | "off") =>
    void change(value === "off" ? { enabled: false } : { enabled: true, provider: value });

  const info = active ? GIF_PROVIDERS[active] : null;
  const hint = !active
    ? "Agents get no GIF results and nothing is sent."
    : key?.status === "missing"
      ? "Agents get no GIF results until a key is saved."
      : "Switching keeps each provider's key.";
  return (
    <div
      role="group"
      aria-label="GIF search"
      data-testid="gif-search-card"
      className="mt-4 rounded-lg border border-border px-4"
    >
      <div className="pt-3">
        <h3 className="text-sm font-semibold text-foreground">GIF search</h3>
        {info ? (
          <>
            <p className="mt-1 text-sm text-muted-foreground">
              Agents can search {info.name} for a GIF to send with a message. Each search goes from
              this computer straight to {info.name} with your key.
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{info.pings}</p>
          </>
        ) : (
          <p className="mt-1 text-sm text-muted-foreground">
            Agents can search GIPHY or KLIPY for a GIF to send with a message. Choose one to turn
            GIF search on.
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {settingsFailed && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            Couldn't read the GIF search settings.{" "}
            <button
              type="button"
              className="underline underline-offset-4"
              onClick={() => void readSettings()}
            >
              Try again
            </button>
          </p>
        )}
      </div>
      {shown.has("gifSearch") && (
        <SettingRow label="Provider" target="gifSearch">
          <Segmented
            aria-label="GIF search provider"
            value={settings ? (active ?? "off") : "off"}
            onValueChange={choose}
            options={[
              { value: "off", label: "Off", disabled: !settings || busy },
              ...GIF_PROVIDER_IDS.map((p) => ({
                value: p,
                label: GIF_PROVIDERS[p].name,
                disabled: !settings || busy,
              })),
            ]}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            {hint} KLIPY, unlike GIPHY, is also sent the words agents search.
          </p>
        </SettingRow>
      )}
      {shown.has("gifKey") &&
        (info && active ? (
          <SettingRow label={`${info.name} key`} target="gifKey">
            <CapabilityOff cap="secret-store">
              <KeyRow
                key={active}
                provider={active}
                status={key}
                busy={busy}
                onRetry={() => void readKey(active)}
                onSave={(value) =>
                  run(
                    () => keyCall(active, () => api.gifKeySave(value)),
                    () => {},
                  )
                }
                onRemove={() =>
                  run(
                    () => keyCall(active, () => api.gifKeyRemove(active)),
                    () => {},
                  )
                }
                onProduction={(production) => void change({ production })}
              />
            </CapabilityOff>
          </SettingRow>
        ) : (
          <SettingRow label="Keys" target="gifKey">
            <CapabilityOff cap="secret-store">
              <OffKeys
                statuses={offKeys}
                busy={busy || !settings}
                onRemove={(provider) =>
                  run(
                    () => api.gifKeyRemove(provider),
                    (status) => setOffKeys((keys) => ({ ...keys, [provider]: status })),
                  )
                }
              />
            </CapabilityOff>
          </SettingRow>
        ))}
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
      {info ? (
        <div className="flex flex-wrap items-center justify-between gap-2 py-3 text-xs text-muted-foreground">
          <span>{info.poweredBy}</span>
          <button
            type="button"
            className="underline underline-offset-4 hover:text-foreground"
            onClick={() => void openUrl(info.termsUrl)}
          >
            {info.name} API terms
          </button>
        </div>
      ) : (
        <div className="pb-3" />
      )}
    </div>
  );
}

/** With Off: each provider's key, saved or not, and a Remove for each saved one. */
function OffKeys({
  statuses,
  busy,
  onRemove,
}: {
  statuses: Partial<Record<GifProviderId, GifKeyStatus>>;
  busy: boolean;
  onRemove: (provider: GifProviderId) => Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState<GifProviderId | null>(null);
  return (
    <div className="space-y-2 text-sm">
      {GIF_PROVIDER_IDS.map((p) => {
        const status = statuses[p];
        const name = GIF_PROVIDERS[p].name;
        return (
          <div key={p} data-gif-key={p} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-14 font-medium text-foreground">{name}</span>
              {!status ? (
                <span className="text-muted-foreground">Checking…</span>
              ) : status.status === "saved" ? (
                <>
                  <span className="text-foreground">Key saved</span>
                  {status.hint && (
                    <span className="font-mono text-xs text-muted-foreground">{status.hint}</span>
                  )}
                  <div className="ml-auto">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Remove the ${name} key`}
                      onClick={() => setConfirming(p)}
                    >
                      Remove
                    </Button>
                  </div>
                </>
              ) : (
                <span className="text-muted-foreground">No key</span>
              )}
            </div>
            {confirming === p && (
              <RemoveConfirm
                provider={p}
                busy={busy}
                onRemove={() => onRemove(p)}
                onDone={() => setConfirming(null)}
              />
            )}
          </div>
        );
      })}
      <p className="text-xs text-muted-foreground">
        Keys stay in your OS keychain while GIF search is off. Choose a provider to add or replace
        its key.
      </p>
    </div>
  );
}

/** Asks before a provider's key is removed, and says the other provider's key stays. */
function RemoveConfirm({
  provider,
  busy,
  onRemove,
  onDone,
}: {
  provider: GifProviderId;
  busy: boolean;
  onRemove: () => Promise<boolean>;
  onDone: () => void;
}) {
  const name = GIF_PROVIDERS[provider].name;
  const others = GIF_PROVIDER_IDS.filter((p) => p !== provider).map((p) => GIF_PROVIDERS[p].name);
  return (
    <div role="alertdialog" aria-label={`Remove the ${name} key`} className="space-y-2">
      <p>
        Remove the {name} key? Agents can't search {name} until you add one.
        {others.map((other) => ` Your ${other} key stays saved.`)}
      </p>
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={() => void onRemove().then(onDone)}
        >
          Remove key
        </Button>
        <Button size="sm" variant="outline" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function KeyRow({
  provider,
  status,
  busy,
  onRetry,
  onSave,
  onRemove,
  onProduction,
}: {
  provider: GifProviderId;
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
  const info = GIF_PROVIDERS[provider];
  if (!status)
    return <p className="pt-1 text-sm text-muted-foreground">Checking the {info.name} key…</p>;
  const saved = status.status === "saved";
  const unavailable = status.status === "unavailable";
  const editing = replacing || status.status === "missing";
  return (
    <div className="space-y-2 text-sm">
      {(saved || unavailable) && (
        <div className="flex flex-wrap items-center gap-2">
          {saved && <span className="text-foreground">Key saved</span>}
          {saved && status.hint && (
            <span className="font-mono text-xs text-muted-foreground">{status.hint}</span>
          )}
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
          No key yet. Paste the API key from {info.keySource}.
        </p>
      )}
      {status.status === "unavailable" && (
        <p className="text-muted-foreground">
          Couldn't read the key from your OS keychain. If your computer asked to allow access, allow
          it, then{" "}
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
        <RemoveConfirm
          provider={provider}
          busy={busy}
          onRemove={onRemove}
          onDone={() => setConfirming(false)}
        />
      )}
      {editing && (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = (field.current?.value ?? "").trim();
            setEmpty(value === "");
            if (value === "") return;
            void onSave(value).then((ok) => {
              if (!ok) return;
              if (field.current) field.current.value = "";
              setVisible(false);
              setReplacing(false);
            });
          }}
        >
          <div className="flex flex-wrap gap-2">
            <Input
              ref={field}
              aria-label={`${info.name} API key`}
              type={visible ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder={`Paste your ${info.name} API key`}
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
              Enter a {info.name} key.
            </p>
          )}
        </form>
      )}
      <p className="text-xs text-muted-foreground">{gifKeyInKeychain(info.name)}</p>
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
          <p className="text-xs text-muted-foreground">{info.productionNote}</p>
        </div>
      )}
    </div>
  );
}
