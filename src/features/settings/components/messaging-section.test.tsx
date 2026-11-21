// SPDX-License-Identifier: MIT
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import { resetPlatformCaps, setPlatformCaps } from "@/shared/lib/__test-utils__/platform-caps";

/** The Settings commands over an in-memory gif.json and Keychain item. */
const backend = vi.hoisted(() => {
  const state = {
    settings: { enabled: true, provider: "giphy" as const, ceiling: "pg" as "g" | "pg" | "pg-13" },
    key: null as string | null,
    production: false,
  };
  const status = (): import("@/tauri/commands").GifKeyStatus =>
    state.key === null
      ? { status: "missing" as const, hint: null, production: false }
      : { status: "saved" as const, hint: `…${state.key.slice(-4)}`, production: state.production };
  return {
    state,
    gifSettingsGet: vi.fn(async () => ({ ...state.settings })),
    gifSettingsSet: vi.fn(
      async (update: {
        enabled?: boolean;
        ceiling?: "g" | "pg" | "pg-13";
        production?: boolean;
      }) => {
        if (update.enabled !== undefined) state.settings.enabled = update.enabled;
        if (update.ceiling !== undefined) state.settings.ceiling = update.ceiling;
        if (update.production !== undefined) {
          if (state.key === null) throw new Error("Save a GIPHY key first.");
          state.production = update.production;
        }
        return { ...state.settings };
      },
    ),
    gifKeyStatus: vi.fn(async () => status()),
    gifKeySave: vi.fn(async (key: string) => {
      state.key = key.trim();
      state.production = false;
      return status();
    }),
    gifKeyRemove: vi.fn(async () => {
      state.key = null;
      state.production = false;
      return status();
    }),
  };
});
vi.mock("@/tauri/commands", () => backend);
const opened = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: opened }));

import { GIPHY_TERMS_URL, MessagingSection } from "./messaging-section";

const card = () => screen.getByTestId("gif-search-card");
const radio = (group: string, name: string) =>
  within(screen.getByRole("radiogroup", { name: group })).getByRole("radio", { name });
const settled = () => waitFor(() => expect(radio("Rating ceiling", "PG")).toBeEnabled());

beforeEach(() => {
  backend.state.settings = { enabled: true, provider: "giphy", ceiling: "pg" };
  backend.state.key = null;
  backend.state.production = false;
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
    fireEvent.click(screen.getByRole("button", { name: "GIPHY API terms" }));
    expect(opened).toHaveBeenCalledWith(GIPHY_TERMS_URL);
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
});
