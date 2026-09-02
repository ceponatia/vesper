import {
  compositionFallbackSchema,
  type CompositionFallback,
  type CompositionFallbackCode,
  type CompositionFallbackSite,
} from "@/contracts/turns/composition-fallback";
import { logEvent } from "../events";

/**
 * Recording side of the composition-fallback telemetry (contract + tally in
 * `contracts/turns/composition-fallback.ts` — C15). Writes one `events` row per degradation
 * (`type = "composition_fallback"`) so the admin inspector can show WHICH composed leg fell
 * back and HOW OFTEN — instead of the degradation vanishing into a `log.warn` line.
 *
 * Deliberately reuses the existing `events` table (nullable session, typed payload, already
 * fire-and-forget), exactly as the agent-failure log does: a debug surface must not cost a
 * migration, and this is append-only observability.
 *
 * **Never throws, never awaited by a turn.** `logEvent` swallows its own errors; this adds no
 * path by which recording could break the turn it is observing.
 */

/** The `events.type` for a composed-turn degradation. */
export const COMPOSITION_FALLBACK_EVENT = "composition_fallback";

const DETAIL_CAP = 300;

export interface RecordCompositionFallbackInput {
  site: CompositionFallbackSite;
  code: CompositionFallbackCode;
  chatId?: string | null;
  /** The beat/reply this attaches to, when known (often null — minted after the warn site). */
  messageId?: string | null;
  /** The private cause — events-row ONLY, never surfaced to a player. */
  detail?: string;
  /** Injectable for tests; defaults to now. */
  at?: Date;
}

/** Build the record (pure). */
export function buildCompositionFallback(input: RecordCompositionFallbackInput): CompositionFallback {
  return compositionFallbackSchema.parse({
    site: input.site,
    code: input.code,
    chatId: input.chatId ?? null,
    messageId: input.messageId ?? null,
    detail: (input.detail ?? "").slice(0, DETAIL_CAP),
    at: (input.at ?? new Date()).toISOString(),
  });
}

/**
 * Record one composed-turn degradation. Fire-and-forget — callers do not await it.
 *
 * The private `detail` can quote the turn, so it rides `content`: the dev
 * inspector shows it, production stores the `site`/`code` pair alone — which is
 * what the tally is built from.
 */
export function recordCompositionFallback(input: RecordCompositionFallbackInput): void {
  const { detail, ...diagnostic } = buildCompositionFallback(input);
  void logEvent(COMPOSITION_FALLBACK_EVENT, diagnostic, { chatId: input.chatId ?? null, content: { detail } });
}

/**
 * A per-turn collector that feeds BOTH surfaces from one call (ruling 1). Each `note` fires
 * the durable events row immediately (with the private detail) and accumulates the
 * **public-safe code** for the reply meta. `codes()` is what a persist site writes into
 * `meta.compositionFallbacks` — codes only, never the detail (ruling 2, admin-only).
 *
 * One collector is created per turn and threaded through the choreography; passing the same
 * instance means every site is one `note(...)` line and the persist site reads `codes()`.
 */
export class CompositionFallbackCollector {
  private readonly accumulated: CompositionFallbackCode[] = [];

  constructor(private readonly chatId: string) {}

  /** Record a degradation on both surfaces: durable events row now, code for the reply meta. */
  note(entry: { site: CompositionFallbackSite; code: CompositionFallbackCode; detail?: string }): void {
    this.accumulated.push(entry.code);
    recordCompositionFallback({
      site: entry.site,
      code: entry.code,
      chatId: this.chatId,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    });
  }

  /** The public-safe codes accumulated this turn — for `meta.compositionFallbacks`. */
  codes(): CompositionFallbackCode[] {
    return [...this.accumulated];
  }
}
