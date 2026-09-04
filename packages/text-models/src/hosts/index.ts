import { FEATHERLESS_DIALECT } from "./featherless";
import { OPENROUTER_DIALECT } from "./openrouter";
import { SELF_HOSTED_DIALECT } from "./self-hosted";
import type { TextHostDialect, TextModelHost, TextServedBinding } from "./host";

export * from "./host";

/** Every host, in the order availability is reported. */
export const TEXT_MODEL_HOSTS: readonly TextModelHost[] = ["featherless", "openrouter", "self-hosted"];

const DIALECTS: Readonly<Record<TextModelHost, TextHostDialect>> = {
  featherless: FEATHERLESS_DIALECT,
  openrouter: OPENROUTER_DIALECT,
  "self-hosted": SELF_HOSTED_DIALECT,
};

/** The dialect table for one host. Total: every host in the union has one. */
export function dialectForHost(host: TextModelHost): TextHostDialect {
  return DIALECTS[host];
}

/**
 * How one feature travels on one host, or null when it does not travel.
 *
 * Absent from the table and explicitly `unsupported` collapse to the same null
 * here, deliberately: a caller asking "can this go?" must not have to know
 * which of the two spellings a dialect chose.
 */
export function bindingFor(host: TextModelHost, featureId: string): TextServedBinding | null {
  const binding = DIALECTS[host].bindings[featureId];
  return binding === undefined || binding.kind === "unsupported" ? null : binding;
}

/**
 * Which hosts serve a feature, derived from the dialect tables rather than
 * declared beside them.
 *
 * Derived because a hand-maintained availability list is a second copy of the
 * tables, and the first time the two disagreed the list would be believed. A
 * later host makes a feature travel by adding one dialect row, never by adding
 * a field to the feature.
 *
 * An empty result is a legitimate answer, not an error: it is what a feature id
 * no dialect names derives. Because the self-hosted placeholder binds the whole
 * vocabulary, every feature Vesper has written down is served somewhere in this
 * sense, and a caller that wants "can this actually reach a wire?" asks about
 * the host in force rather than about the list.
 */
export function hostsServing(featureId: string): readonly TextModelHost[] {
  return TEXT_MODEL_HOSTS.filter((host) => bindingFor(host, featureId) !== null);
}
