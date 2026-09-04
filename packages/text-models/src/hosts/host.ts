import type { TextProfileValue } from "../features";

/**
 * The upstreams a text call can be asked through.
 *
 * A host is not a provider client and not a credential — this package never
 * reaches a network and never reads an environment variable. It is the answer
 * to a narrower question: given that this call is going THERE, which of the
 * things a profile declares can actually travel, and spelled how?
 *
 * Three of them, and the third is a placeholder on purpose. Two upstreams serve
 * Vesper today; the local runtimes that authors tune their models on serve
 * everything and Vesper reaches none of them. Naming the third here is what
 * makes an unhosted sampler a value that is WITHHELD rather than a value that
 * cannot be written down.
 */
export type TextModelHost = "featherless" | "openrouter" | "self-hosted";

/**
 * The call settings a generation SDK carries as first-class arguments, spelled
 * in the SDK's normalized vocabulary.
 *
 * This union is stated here, in the package, rather than imported: the package
 * does not depend on `ai` and must not, because a provider-neutral description
 * of a model cannot be allowed to pin the application's SDK version. It is a
 * small, slow-moving list, and a setting the SDK adds is a one-line change here
 * plus the dialect rows that want it.
 */
export type TextCallSetting =
  | "temperature"
  | "topP"
  | "topK"
  | "presencePenalty"
  | "frequencyPenalty"
  | "seed"
  | "stopSequences"
  | "maxOutputTokens";

/** Every call setting, in one place, so a merge can walk them without a cast. */
export const TEXT_CALL_SETTINGS: readonly TextCallSetting[] = [
  "temperature",
  "topP",
  "topK",
  "presencePenalty",
  "frequencyPenalty",
  "seed",
  "stopSequences",
  "maxOutputTokens",
];

/** Anything that can be written into a JSON request body. */
export type TextWireValue =
  | number
  | boolean
  | string
  | readonly TextWireValue[]
  | { readonly [key: string]: TextWireValue };

/** Call settings a caller hands the SDK, keyed by the SDK's own argument name. */
export type TextCallSettings = Readonly<Partial<Record<TextCallSetting, TextWireValue>>>;

/** Raw request-body fields, keyed by the host's wire spelling. */
export type TextRequestBody = Readonly<Record<string, TextWireValue>>;

/**
 * How one semantic feature travels on one host — exactly one of three answers.
 *
 * `setting` and `body` are not a style choice. A knob the SDK carries as a call
 * setting is dropped with a warning when the transport does not recognise it,
 * so a knob that the host serves but the SDK does not model has to ride the raw
 * body instead. That is why `topK` is a setting on one host and a body field on
 * the other while meaning the same thing on both.
 */
export type TextFeatureBinding =
  | { readonly kind: "setting"; readonly setting: TextCallSetting }
  | {
      readonly kind: "body";
      readonly field: string;
      /** Reshapes the value for the wire. Absent means the value travels as declared. */
      readonly encode?: (value: TextProfileValue) => TextWireValue;
    }
  | { readonly kind: "unsupported" };

/** A binding that actually carries a value — the two answers that are not "no". */
export type TextServedBinding = Extract<TextFeatureBinding, { readonly kind: "setting" } | { readonly kind: "body" }>;

/**
 * One host's whole answer, as an editable table.
 *
 * `bindings` is keyed by feature id and read as a lookup, so a feature absent
 * from the table and a feature bound to `unsupported` mean the same thing:
 * this host does not serve it. Both spellings are kept because they say
 * different things to a reader — an explicit `unsupported` row is a measurement
 * ("asked, and it is not served"), absence is silence.
 *
 * Two features in one dialect never claim the same wire field. Nothing enforces
 * it at runtime because the tables are constants a reviewer reads whole, but a
 * second claim would silently overwrite the first at bind time, so a new row's
 * field name is checked against its neighbours when it is added.
 */
export interface TextHostDialect {
  readonly host: TextModelHost;
  readonly bindings: Readonly<Record<string, TextFeatureBinding>>;
  /**
   * This dialect names spellings; no transport reaches it.
   *
   * A placeholder's rows are a record of the vocabulary a profile was authored
   * in, not a claim that anything can be asked through it — so a placeholder
   * host SERVES nothing, and `hostsServing` leaves it out. Binding for one
   * still works, because "what would this profile look like over there?" is a
   * question worth answering about a host that does not exist yet.
   */
  readonly placeholder?: true;
}

/** Bind a feature to an SDK call setting. */
export function settingBinding(setting: TextCallSetting): TextFeatureBinding {
  return { kind: "setting", setting };
}

/** Bind a feature to a raw request-body field, optionally reshaping the value. */
export function bodyBinding(field: string, encode?: (value: TextProfileValue) => TextWireValue): TextFeatureBinding {
  return encode === undefined ? { kind: "body", field } : { kind: "body", field, encode };
}
