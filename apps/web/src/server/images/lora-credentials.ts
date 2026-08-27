import type { ImageLoraRenderBinding } from "@vesper/image-core";

/**
 * The credential a LoRA locator needs to be fetchable, joined to it at the last
 * possible moment.
 *
 * The LoRA library stores a PUBLIC retrieval address and nothing else — that is
 * the contract `isValidImageLoraLocator` enforces, and the reason it refuses a
 * `user:password@` URL outright: the library is a database table an admin screen
 * renders, which is exactly where a provider credential must not be. But
 * Civitai gates its adult downloads behind an account, so the address that is
 * safe to STORE is not the address the provider can FETCH.
 *
 * This module is the one place those two facts are reconciled. The stored
 * locator stays clean everywhere — in the row, on an image row, in every
 * diagnostic (`redactImageLoraLocator` strips query strings anyway) — and the
 * token is appended to a COPY on its way into the provider payload, from the
 * environment, by the single reader below.
 */

/**
 * THE only code in Vesper that reads `CIVITAI_API_TOKEN`.
 *
 * Read per call rather than snapshotted at import, matching `paths.ts`'s
 * `DATA_ROOT` read and for the same reason: Next loads server modules while
 * building and analyzing routes, when runtime secrets are absent, so a snapshot
 * taken then would describe the build machine rather than the deployment.
 *
 * A blank value is `null`, not `""` — an empty secret is an unset secret, and
 * returning the empty string would let the route below append `token=` with
 * nothing after it and spend a prediction on a download that 401s.
 *
 * The value is never logged, never persisted, and never returned to a caller
 * that does anything but hand it to {@link withLoraDownloadCredential}.
 */
export function civitaiApiToken(): string | null {
  const token = process.env.CIVITAI_API_TOKEN?.trim();
  return token ? token : null;
}

/** Civitai's download endpoint takes the account's API key as this query parameter. */
const CIVITAI_TOKEN_PARAM = "token";

/** The host whose downloads Vesper completes with a credential, and its subdomains. */
const CIVITAI_HOST = "civitai.com";

/**
 * Whether this locator is a Civitai download that carries no credential of its
 * own — i.e. whether {@link withLoraDownloadCredential} would have work to do.
 *
 * Exported so a lane can decide BEFORE it spends anything whether the render it
 * is about to route is reachable at all: the intimate-scene route degrades to
 * the stock model when the answer is yes and the environment has no token,
 * rather than sending weights the provider will fail to download.
 *
 * A locator that already carries a `token` parameter is left alone — it is
 * somebody's deliberate, complete address — and so is anything that is not a
 * URL (a Hugging Face `owner/repo` slug needs no credential from us).
 */
export function loraLocatorNeedsCivitaiToken(locator: string): boolean {
  const url = parseUrl(locator);
  if (!url || !isCivitaiHost(url)) return false;
  return !url.searchParams.has(CIVITAI_TOKEN_PARAM);
}

/**
 * The binding as the provider must receive it: the same weights, the same scale,
 * with the download credential joined to the locator when this deployment has
 * one and the address needs it.
 *
 * Returns the binding UNCHANGED — the same object, so a caller can compare by
 * identity — whenever nothing needs adding: a Hugging Face slug, a non-Civitai
 * URL, an address that already carries a token, or a deployment with no token
 * configured. That last case is deliberately not an error here: the route that
 * cares refuses earlier (see {@link loraLocatorNeedsCivitaiToken}), and a
 * transport-level throw would turn a configuration gap into a failed render.
 */
export function withLoraDownloadCredential(binding: ImageLoraRenderBinding): ImageLoraRenderBinding {
  const token = civitaiApiToken();
  if (token === null || !loraLocatorNeedsCivitaiToken(binding.locator)) return binding;
  const url = parseUrl(binding.locator);
  if (!url) return binding;
  url.searchParams.set(CIVITAI_TOKEN_PARAM, token);
  return { ...binding, locator: url.toString() };
}

/** `hostname` equality plus subdomains — never a suffix match, which `evilcivitai.com` passes. */
function isCivitaiHost(url: URL): boolean {
  return url.hostname === CIVITAI_HOST || url.hostname.endsWith(`.${CIVITAI_HOST}`);
}

/** A parsed URL, or null for anything that is not one (a repo slug, a typo). */
function parseUrl(locator: string): URL | null {
  try {
    return new URL(locator);
  } catch {
    return null;
  }
}
