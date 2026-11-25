// SPDX-License-Identifier: MIT
/**
 * Each GIF search provider's user-facing strings, named once so the Settings card and the Inbox
 * pane's picker can't drift. KLIPY requires "Search KLIPY" as a search box's placeholder.
 */

export type GifProviderId = "giphy" | "klipy";

export interface GifProviderInfo {
  /** The provider's name as it is written in copy. */
  name: string;
  /** The placeholder of a search box that searches this provider. */
  searchPlaceholder: string;
  /** The attribution line under the provider's results or settings. */
  poweredBy: string;
  /** The provider's API terms. */
  termsUrl: string;
  /** Where the user gets an API key, as it reads after "the API key from". */
  keySource: string;
  /** What the provider receives while GIF search is on, for the Settings card. */
  pings: string;
  /** The rate limit a test key has, under the production checkbox. */
  productionNote: string;
}

export const GIF_PROVIDER_IDS = ["giphy", "klipy"] as const satisfies readonly GifProviderId[];

export const GIF_PROVIDERS: Readonly<Record<GifProviderId, GifProviderInfo>> = {
  giphy: {
    name: "GIPHY",
    searchPlaceholder: "Search GIPHY",
    poweredBy: "Powered By GIPHY",
    termsUrl:
      "https://support.giphy.com/hc/en-us/articles/360028134111-GIPHY-API-Terms-of-Service-",
    keySource: "your GIPHY developer dashboard",
    pings:
      "While GIF search is on, GIPHY gets its required send and view pings for the GIFs agents send, with an install id GIPHY issues. Turning GIF search off or removing the key stops the pings and deletes the id; replacing the key gives the new key a new id.",
    productionNote:
      "A GIPHY beta key allows 100 searches an hour, so CodeSense stops at 90. A production key has no limit here. Replacing the key clears this.",
  },
  klipy: {
    name: "KLIPY",
    searchPlaceholder: "Search KLIPY",
    poweredBy: "Powered by KLIPY",
    termsUrl: "https://docs.klipy.com/terms",
    keySource: "your KLIPY partner panel",
    pings:
      "While GIF search is on, KLIPY gets a share ping for each GIF an agent sends, with the words it searched and a random id CodeSense makes for this install. Turning GIF search off or removing the key stops the pings and deletes the id.",
    productionNote:
      "A KLIPY testing key allows 100 requests an hour, so CodeSense stops at 90. A production key has no limit here. Replacing the key clears this.",
  },
};
