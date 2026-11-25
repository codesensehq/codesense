// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { resetPlatformCaps, setPlatformCaps } from "@/shared/lib/__test-utils__/platform-caps";

/** The Settings commands over an in-memory gif.json and one Keychain item per provider. */
const backend = vi.hoisted(() => {
  type Provider = "giphy" | "klipy";
  const state = {
    settings: {
      enabled: true,
      provider: "giphy" as Provider,
      ceiling: "pg" as "g" | "pg" | "pg-13",
    },
    keys: { giphy: null, klipy: null } as Record<Provider, string | null>,
    production: { giphy: false, klipy: false } as Record<Provider, boolean>,
    // GIPHY's key, as the single-provider tests read it.
    get key() {
      return this.keys.giphy;
    },
    set key(value: string | null) {
      this.keys.giphy = value;
    },
  };
  // Only the active provider's status reads the keychain, so only it has a hint.
  const status = (provider: Provider): import("@/tauri/commands").GifKeyStatus => {
    const key = state.keys[provider];
    const active = state.settings.enabled && state.settings.provider === provider;
    return key === null
      ? { status: "missing" as const, hint: null, production: false }
      : {
          status: "saved" as const,
          hint: active ? `…${key.slice(-4)}` : null,
          production: state.production[provider],
        };
  };
  return {
    state,
    gifSettingsGet: vi.fn(async () => ({ ...state.settings })),
    gifSettingsSet: vi.fn(
      async (update: {
        enabled?: boolean;
        provider?: Provider;
        ceiling?: "g" | "pg" | "pg-13";
        production?: boolean;
      }) => {
        const provider = update.provider ?? state.settings.provider;
        if (update.production !== undefined && state.keys[provider] === null)
          throw new Error("Save a key first.");
        if (update.enabled !== undefined) state.settings.enabled = update.enabled;
        if (update.provider !== undefined) state.settings.provider = update.provider;
        if (update.ceiling !== undefined) state.settings.ceiling = update.ceiling;
        if (update.production !== undefined) state.production[provider] = update.production;
        return { ...state.settings };
      },
    ),
    gifKeyStatus: vi.fn(async (provider?: Provider) => status(provider ?? state.settings.provider)),
    gifKeySave: vi.fn(async (key: string) => {
      const provider = state.settings.provider;
      state.keys[provider] = key.trim();
      state.production[provider] = false;
      return status(provider);
    }),
    gifKeyRemove: vi.fn(async (provider?: Provider) => {
      const p = provider ?? state.settings.provider;
      state.keys[p] = null;
      state.production[p] = false;
      return status(p);
    }),
  };
});
vi.mock("@/tauri/commands", () => backend);
const opened = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: opened }));

import { GIF_PROVIDERS } from "@/shared/lib/gif-providers";

import { MessagingSection } from "./messaging-section";

const card = () => screen.getByTestId("gif-search-card");
const radio = (group: string, name: string) =>
  within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });
const settled = () => waitFor(() => expect(radio("Rating ceiling", "PG")).toBeEnabled());

beforeEach(() => {
  backend.state.settings = { enabled: true, provider: "giphy", ceiling: "pg" };
  backend.state.keys = { giphy: null, klipy: null };
  backend.state.production = { giphy: false, klipy: false };
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  resetPlatformCaps();
});

describe("Messaging → GIF search card", () => {
  it("shows GIPHY on, a pg ceiling, the attribution and the terms link", async () => {
    render(<MessagingSection />);
    await settled();
    expect(screen.getByRole("heading", { name: "Messaging" })).toBeInTheDocument();
    expect(within(card()).getByText("GIF search")).toBeInTheDocument();
    expect(radio("GIF search provider", "GIPHY")).toHaveAttribute("aria-checked", "true");
    expect(radio("GIF search provider", "Off")).toHaveAttribute("aria-checked", "false");
    expect(radio("Rating ceiling", "PG")).toHaveAttribute("aria-checked", "true");
    expect(screen.queryByRole("radio", { name: "R" })).toBeNull();
    expect(within(card()).getByText("Powered By GIPHY")).toBeInTheDocument();
    // What goes to GIPHY while search is on, and what stops it.
    const pings = within(card()).getByText(/required send and view pings/);
    expect(pings.textContent).toContain(
      "Turning GIF search off or removing the key stops the pings and deletes the id; replacing " +
        "the key gives the new key a new id.",
    );
    fireEvent.click(screen.getByRole("button", { name: "GIPHY API terms" }));
    expect(opened).toHaveBeenCalledWith(GIF_PROVIDERS.giphy.termsUrl);
  });

  it("turns GIF search off and on, and sets the ceiling", async () => {
    render(<MessagingSection />);
    await settled();
    fireEvent.click(radio("GIF search provider", "Off"));
    await waitFor(() =>
      expect(radio("GIF search provider", "Off")).toHaveAttribute("aria-checked", "true"),
    );
    expect(backend.gifSettingsSet).toHaveBeenLastCalledWith({ enabled: false });
    expect(backend.state.settings.enabled).toBe(false);
    await settled();
    fireEvent.click(radio("GIF search provider", "GIPHY"));
    await waitFor(() => expect(backend.state.settings.enabled).toBe(true));
    expect(backend.gifSettingsSet).toHaveBeenLastCalledWith({ enabled: true, provider: "giphy" });
    await settled();
    fireEvent.click(radio("Rating ceiling", "G"));
    await waitFor(() =>
      expect(radio("Rating ceiling", "G")).toHaveAttribute("aria-checked", "true"),
    );
    expect(backend.gifSettingsSet).toHaveBeenLastCalledWith({ ceiling: "g" });
  });

  it("enters a key trimmed, refuses an empty one, marks it production, replaces and removes it", async () => {
    render(<MessagingSection />);
    const field = await screen.findByLabelText("GIPHY API key");
    expect(field).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText("Enter a GIPHY key.")).toBeInTheDocument();
    fireEvent.change(field, { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(backend.gifKeySave).not.toHaveBeenCalled();

    fireEvent.change(field, { target: { value: "  test-key-a1b2  " } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await screen.findByText("Key saved");
    expect(backend.gifKeySave).toHaveBeenCalledWith("test-key-a1b2");
    expect(screen.getByText("…a1b2")).toBeInTheDocument();
    expect(screen.queryByLabelText("GIPHY API key")).toBeNull();

    const production = screen.getByRole("checkbox", { name: "This is a production key" });
    expect(production).not.toBeChecked();
    fireEvent.click(production);
    await waitFor(() => expect(production).toBeChecked());
    expect(backend.gifSettingsSet).toHaveBeenLastCalledWith({ production: true });

    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.change(screen.getByLabelText("GIPHY API key"), {
      target: { value: "test-key-c3d4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await screen.findByText("…c3d4");
    expect(screen.getByRole("checkbox", { name: "This is a production key" })).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const confirm = screen.getByRole("alertdialog", { name: "Remove the GIPHY key" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove key" }));
    await screen.findByLabelText("GIPHY API key");
    expect(backend.state.key).toBeNull();
    expect(screen.queryByText("Key saved")).toBeNull();
  });

  it("finds a key saved outside the app with no re-entry", async () => {
    backend.state.key = "stored-elsewhere-9z9z";
    render(<MessagingSection />);
    await screen.findByText("Key saved");
    expect(screen.getByText("…9z9z")).toBeInTheDocument();
    expect(screen.queryByLabelText("GIPHY API key")).toBeNull();
  });

  it("offers a retry, a replace and a remove when the keychain could not be read", async () => {
    backend.gifKeyStatus.mockResolvedValueOnce({
      status: "unavailable",
      hint: null,
      production: false,
    });
    backend.state.key = "stored-elsewhere-9z9z";
    render(<MessagingSection />);
    await screen.findByRole("button", { name: "try again" });
    expect(screen.getByRole("button", { name: "Replace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "try again" }));
    await screen.findByText("Key saved");
  });

  it("offers a retry when the settings could not be read", async () => {
    backend.gifSettingsGet.mockRejectedValueOnce(new Error("no app data folder"));
    render(<MessagingSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    await settled();
    expect(screen.queryByText(/Couldn't read the GIF search settings/)).toBeNull();
  });

  it("keeps the typed key when the save fails", async () => {
    backend.gifKeySave.mockRejectedValueOnce("Couldn't save the key to your OS keychain.");
    render(<MessagingSection />);
    const field = await screen.findByLabelText("GIPHY API key");
    fireEvent.change(field, { target: { value: "test-key-0123456789" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(
      await screen.findByText("Couldn't save the key to your OS keychain."),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("GIPHY API key")).toHaveValue("test-key-0123456789");
  });

  it("never lets a slower key read overwrite a newer save", async () => {
    type Status = Awaited<ReturnType<typeof backend.gifKeyStatus>>;
    let answer!: (status: Status) => void;
    backend.gifKeyStatus
      .mockResolvedValueOnce({ status: "unavailable", hint: null, production: false })
      .mockImplementationOnce(
        () =>
          new Promise<Status>((resolve) => {
            answer = resolve;
          }),
      );
    render(<MessagingSection />);
    // A retry is still waiting (on a keychain prompt) when the user saves a new key.
    fireEvent.click(await screen.findByRole("button", { name: "try again" }));
    await waitFor(() => expect(backend.gifKeyStatus).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    fireEvent.change(screen.getByLabelText("GIPHY API key"), {
      target: { value: "test-key-c3d4c3d4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await screen.findByText("…c3d4");
    answer({ status: "missing", hint: null, production: false });
    await waitFor(() => expect(screen.getByText("Key saved")).toBeInTheDocument());
    expect(screen.queryByText(/No key yet/)).toBeNull();
  });

  it("explains the key row where there is no secret store, and the other rows still work", async () => {
    setPlatformCaps({ "secret-store": "the secret store isn't supported here yet" });
    render(<MessagingSection />);
    await settled();
    const note = card().querySelector('[data-capability-off="secret-store"]');
    expect(note).toHaveTextContent("the secret store isn't supported here yet");
    expect(screen.queryByLabelText("GIPHY API key")).toBeNull();
    expect(backend.gifKeyStatus).not.toHaveBeenCalled();
    fireEvent.click(radio("GIF search provider", "Off"));
    await waitFor(() => expect(backend.state.settings.enabled).toBe(false));
    await settled();
    fireEvent.click(radio("Rating ceiling", "PG-13"));
    await waitFor(() => expect(backend.state.settings.ceiling).toBe("pg-13"));
  });

  it("shows only the rows a search matches, the off key row included", async () => {
    setPlatformCaps({ "secret-store": "the secret store isn't supported here yet" });
    const { rerender } = render(<MessagingSection query="keychain" />);
    expect(card().querySelector('[data-setting-row="gifKey"]')).not.toBeNull();
    expect(card().querySelector('[data-setting-row="gifRating"]')).toBeNull();
    rerender(<MessagingSection query="rating" />);
    expect(card().querySelector('[data-setting-row="gifRating"]')).not.toBeNull();
    expect(card().querySelector('[data-setting-row="gifKey"]')).toBeNull();
    rerender(<MessagingSection query="no such setting" />);
    expect(screen.queryByTestId("gif-search-card")).toBeNull();
    await waitFor(() => expect(backend.gifSettingsGet).toHaveBeenCalled());
  });

  it("shows the provider hint for each state, always naming what KLIPY is also sent", async () => {
    const also = "KLIPY, unlike GIPHY, is also sent the words agents search.";
    render(<MessagingSection />);
    expect(
      await within(card()).findByText(`Agents get no GIF results until a key is saved. ${also}`),
    ).toBeInTheDocument();
    cleanup();
    backend.state.keys.giphy = "saved-key-0001";
    render(<MessagingSection />);
    expect(
      await within(card()).findByText(`Switching keeps each provider's key. ${also}`),
    ).toBeInTheDocument();
    cleanup();
    backend.state.settings.enabled = false;
    render(<MessagingSection />);
    expect(
      await within(card()).findByText(`Agents get no GIF results and nothing is sent. ${also}`),
    ).toBeInTheDocument();
  });

  it("shows KLIPY's copy, key row, production note and footer", async () => {
    backend.state.settings.provider = "klipy";
    render(<MessagingSection />);
    await settled();
    expect(radio("GIF search provider", "KLIPY")).toHaveAttribute("aria-checked", "true");
    expect(
      within(card()).getByText(
        "Agents can search KLIPY for a GIF to send with a message. Each search goes from this " +
          "computer straight to KLIPY with your key.",
      ),
    ).toBeInTheDocument();
    expect(within(card()).getByText(GIF_PROVIDERS.klipy.pings)).toBeInTheDocument();
    expect(within(card()).queryByText(/required send and view pings/)).toBeNull();
    expect(
      await screen.findByText("No key yet. Paste the API key from your KLIPY partner panel."),
    ).toBeInTheDocument();
    const field = screen.getByLabelText("KLIPY API key");
    expect(field).toHaveAttribute("placeholder", "Paste your KLIPY API key");
    expect(within(card()).getByText(/sends it only to KLIPY and shows/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(await screen.findByText("Enter a KLIPY key.")).toBeInTheDocument();

    fireEvent.change(field, { target: { value: "klipy-test-key-x7Qa" } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await screen.findByText("…x7Qa");
    expect(backend.state.keys).toEqual({ giphy: null, klipy: "klipy-test-key-x7Qa" });
    expect(within(card()).getByText(GIF_PROVIDERS.klipy.productionNote)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: "This is a production key" }));
    await waitFor(() => expect(backend.state.production.klipy).toBe(true));
    expect(backend.state.production.giphy).toBe(false);

    expect(within(card()).getByText("Powered by KLIPY")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "KLIPY API terms" }));
    expect(opened).toHaveBeenCalledWith(GIF_PROVIDERS.klipy.termsUrl);
  });

  it("switches to KLIPY, reads only KLIPY's key, and keeps GIPHY's key and mark", async () => {
    backend.state.keys.giphy = "test-key-3f9K";
    backend.state.production.giphy = true;
    type Status = Awaited<ReturnType<typeof backend.gifKeyStatus>>;
    let answer!: (status: Status) => void;
    render(<MessagingSection />);
    await screen.findByText("…3f9K");
    backend.gifKeyStatus.mockImplementationOnce(
      () =>
        new Promise<Status>((resolve) => {
          answer = resolve;
        }),
    );
    fireEvent.click(radio("GIF search provider", "KLIPY"));
    expect(await screen.findByText("Checking the KLIPY key…")).toBeInTheDocument();
    expect(backend.gifSettingsSet).toHaveBeenLastCalledWith({ enabled: true, provider: "klipy" });
    expect(backend.gifKeyStatus).toHaveBeenLastCalledWith("klipy");
    expect(radio("GIF search provider", "KLIPY")).toHaveAttribute("aria-checked", "true");
    answer({ status: "missing", hint: null, production: false });
    await screen.findByLabelText("KLIPY API key");
    expect(screen.queryByText("…3f9K")).toBeNull();
    expect(backend.state.keys.giphy).toBe("test-key-3f9K");
    expect(backend.state.production.giphy).toBe(true);

    fireEvent.click(radio("GIF search provider", "GIPHY"));
    await screen.findByText("…3f9K");
    expect(screen.getByRole("checkbox", { name: "This is a production key" })).toBeChecked();
  });

  it("keeps the old provider and says why when a switch fails", async () => {
    render(<MessagingSection />);
    await settled();
    backend.gifSettingsSet.mockRejectedValueOnce("Couldn't save the GIF search settings.");
    fireEvent.click(radio("GIF search provider", "KLIPY"));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Couldn't save the GIF search settings.",
    );
    expect(radio("GIF search provider", "GIPHY")).toHaveAttribute("aria-checked", "true");
    expect(backend.gifKeyStatus).not.toHaveBeenCalledWith("klipy");
  });

  it("disables both segmented controls and the key actions while a switch is in flight", async () => {
    backend.state.keys.giphy = "test-key-3f9K";
    let land!: () => void;
    render(<MessagingSection />);
    await screen.findByText("…3f9K");
    backend.gifSettingsSet.mockImplementationOnce(
      (update) =>
        new Promise((resolve) => {
          land = () => {
            backend.state.settings.provider = update.provider ?? "giphy";
            resolve({ ...backend.state.settings });
          };
        }),
    );
    fireEvent.click(radio("GIF search provider", "KLIPY"));
    await waitFor(() => expect(radio("GIF search provider", "Off")).toBeDisabled());
    expect(radio("Rating ceiling", "PG")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
    expect(radio("GIF search provider", "GIPHY")).toHaveAttribute("aria-checked", "true");
    land();
    await screen.findByLabelText("KLIPY API key");
  });

  it("confirms a KLIPY remove, saying the GIPHY key stays", async () => {
    backend.state.settings.provider = "klipy";
    backend.state.keys = { giphy: "test-key-3f9K", klipy: "test-key-x7Qa" };
    render(<MessagingSection />);
    await screen.findByText("…x7Qa");
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const confirm = screen.getByRole("alertdialog", { name: "Remove the KLIPY key" });
    expect(confirm).toHaveTextContent(
      "Remove the KLIPY key? Agents can't search KLIPY until you add one. Your GIPHY key stays saved.",
    );
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove key" }));
    await screen.findByLabelText("KLIPY API key");
    expect(backend.gifKeyRemove).toHaveBeenCalledWith("klipy");
    expect(backend.state.keys).toEqual({ giphy: "test-key-3f9K", klipy: null });
  });

  it("with Off, lists each key from files, removes one, and shows no pings or footer", async () => {
    backend.state.settings.enabled = false;
    backend.state.keys = { giphy: null, klipy: "test-key-x7Qa" };
    render(<MessagingSection />);
    await settled();
    expect(radio("GIF search provider", "Off")).toHaveAttribute("aria-checked", "true");
    expect(
      within(card()).getByText(
        "Agents can search GIPHY or KLIPY for a GIF to send with a message. Choose one to turn " +
          "GIF search on.",
      ),
    ).toBeInTheDocument();
    expect(within(card()).queryByText(/pings/)).toBeNull();
    expect(within(card()).queryByText(/Powered/i)).toBeNull();
    expect(within(card()).queryByRole("button", { name: /API terms/ })).toBeNull();
    expect(within(card()).getByText("Keys")).toBeInTheDocument();
    const giphy = await waitFor(() => {
      const row = card().querySelector<HTMLElement>('[data-gif-key="giphy"]');
      expect(row).toHaveTextContent("No key");
      return row!;
    });
    const klipy = card().querySelector<HTMLElement>('[data-gif-key="klipy"]')!;
    await waitFor(() => expect(klipy).toHaveTextContent("Key saved"));
    expect(within(giphy).queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText(/API key/)).toBeNull();
    expect(
      within(card()).getByText(
        "Keys stay in your OS keychain while GIF search is off. Choose a provider to add or " +
          "replace its key.",
      ),
    ).toBeInTheDocument();
    expect(backend.gifKeyStatus).toHaveBeenCalledWith("giphy");
    expect(backend.gifKeyStatus).toHaveBeenCalledWith("klipy");

    fireEvent.click(within(klipy).getByRole("button", { name: "Remove the KLIPY key" }));
    const confirm = screen.getByRole("alertdialog", { name: "Remove the KLIPY key" });
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(klipy).toHaveTextContent("No key"));
    expect(backend.gifKeyRemove).toHaveBeenCalledWith("klipy");
    expect(backend.state.settings.enabled).toBe(false);
  });

  it("with Off, a search for key lands on the Keys row", async () => {
    backend.state.settings.enabled = false;
    render(<MessagingSection query="key" />);
    await waitFor(() => expect(backend.gifKeyStatus).toHaveBeenCalledWith("klipy"));
    const row = card().querySelector('[data-setting-row="gifKey"]');
    expect(row).toHaveTextContent("Keys");
    expect(row).toHaveTextContent("KLIPY");
    expect(card().querySelector('[data-setting-row="gifRating"]')).toBeNull();
  });
});
