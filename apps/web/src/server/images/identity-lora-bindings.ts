import { and, desc, eq } from "drizzle-orm";
import {
  evaluateIdentityLoraBinding,
  type IdentityLoraBinding,
  type IdentityLoraBindingCreateRequest,
  identityLoraBindingSchema,
  type IdentityLoraBindingState,
  type IdentityLoraBindingUsability,
} from "@vesper/image-core";
import { diag, type DiagnosticSink } from "@/contracts/diagnostics";
import { newId } from "@/lib/ids";
import { db, imageIdentityLoraBindings, imageIdentityPacks } from "../db";
import { parseRegistryRows } from "./models";

/**
 * The identity-pack-to-LoRA binding store.
 *
 * One job: say which trained character LoRA belongs to which identity pack
 * revision, and whether that claim is still true. The decision itself is pure and
 * lives in `@vesper/image-core`; this module supplies the rows.
 *
 * **Written by operator tooling, not by a route.** Stage 4 trains LoRAs from a
 * hand-curated dataset through `scripts/train-sd-character-lora.ts`, and
 * `scripts/register-sd-character-lora.ts` is what calls {@link
 * createIdentityLoraBinding}. There is deliberately no admin API surface yet:
 * the plan keeps Stage 4 experimental and connects the profile/UI path in Stage
 * 8, and a route that promoted a binding before any render consumed one would be
 * a control over nothing.
 *
 * Rows are parsed at the trust boundary like every other registry read here, so
 * one malformed row costs itself rather than the list (docs/resilience.md §1).
 */

const BINDING_ROW_INVALID = {
  code: "identity_lora_binding.row_invalid",
  message: "an image_identity_lora_bindings row failed to parse and was skipped",
  path: "image_identity_lora_bindings",
} as const;

/** Every binding for one identity pack revision, newest first. */
export async function listIdentityLoraBindings(
  identityPackId: string,
  sink?: DiagnosticSink,
): Promise<IdentityLoraBinding[]> {
  const rows = await db()
    .select()
    .from(imageIdentityLoraBindings)
    .where(eq(imageIdentityLoraBindings.identityPackId, identityPackId))
    .orderBy(desc(imageIdentityLoraBindings.createdAt));
  return parseRegistryRows(rows, identityLoraBindingSchema, BINDING_ROW_INVALID, sink);
}

/** One binding by id, or null when it is missing OR unreadable — the `loadImageLora` reading. */
export async function loadIdentityLoraBinding(id: string): Promise<IdentityLoraBinding | null> {
  const [row] = await db().select().from(imageIdentityLoraBindings).where(eq(imageIdentityLoraBindings.id, id)).limit(1);
  if (!row) return null;
  const parsed = identityLoraBindingSchema.safeParse(row);
  return parsed.success ? parsed.data : null;
}

/**
 * A binding with the usability verdict already resolved against the character's
 * CURRENT pack.
 *
 * The verdict travels with the row rather than being recomputed by each caller,
 * because the input it needs — which pack revision is current — is a second query
 * that a caller holding only a binding has no reason to know it must run.
 */
export interface IdentityLoraBindingWithUsability {
  binding: IdentityLoraBinding;
  usability: IdentityLoraBindingUsability;
}

/**
 * Every binding known for a character, across pack revisions, each judged against
 * the revision that is current now.
 *
 * Deliberately not filtered to the current pack. The superseded rows are the
 * point: they are what tells an operator that this character's LoRA was trained
 * before the last re-crop, which is the whole reason the association exists.
 */
export async function listCharacterIdentityLoraBindings(
  characterId: string,
  sink?: DiagnosticSink,
): Promise<IdentityLoraBindingWithUsability[]> {
  const rows = await db()
    .select({ binding: imageIdentityLoraBindings, current: imageIdentityPacks.current })
    .from(imageIdentityLoraBindings)
    .innerJoin(imageIdentityPacks, eq(imageIdentityLoraBindings.identityPackId, imageIdentityPacks.id))
    .where(eq(imageIdentityPacks.characterId, characterId))
    .orderBy(desc(imageIdentityLoraBindings.createdAt));

  // The current pack id comes from the joined rows rather than a second query:
  // every binding already carries its own pack's `current` flag, and at most one
  // pack per character may hold it (`image_identity_packs_one_current_per_character`).
  // A character whose current pack has no binding yields no row with `current`,
  // and null is exactly the answer the evaluation wants for that case.
  const currentIdentityPackId = rows.find((row) => row.current)?.binding.identityPackId ?? null;

  const parsed = parseRegistryRows(
    rows.map((row) => row.binding),
    identityLoraBindingSchema,
    BINDING_ROW_INVALID,
    sink,
  );
  return parsed.map((binding) => ({
    binding,
    usability: evaluateIdentityLoraBinding({ binding, currentIdentityPackId }),
  }));
}

/** A mutation's result: the row as it now stands, or the typed reason it was refused. */
export type IdentityLoraBindingMutation =
  | { ok: true; binding: IdentityLoraBinding }
  | { ok: false; code: "not_found" | "invalid" | "conflict"; message: string };

/**
 * Record that a LoRA was trained from an identity pack.
 *
 * Refusals are values, not exceptions, because both of the ways this fails are
 * ordinary operator states rather than bugs: naming a pack or LoRA that is not
 * there, and binding the same pair twice. The second is a database guarantee
 * (`image_identity_lora_bindings_pack_lora_unique`) rather than a pre-check,
 * so two registrations racing cannot both win.
 */
export async function createIdentityLoraBinding(
  request: IdentityLoraBindingCreateRequest,
): Promise<IdentityLoraBindingMutation> {
  const values = { id: newId(), ...request };
  try {
    const [row] = await db().insert(imageIdentityLoraBindings).values(values).returning();
    const parsed = identityLoraBindingSchema.safeParse(row);
    if (!parsed.success) {
      return { ok: false, code: "invalid", message: "the stored binding did not parse back" };
    }
    return { ok: true, binding: parsed.data };
  } catch (err) {
    return { ok: false, code: refusalCodeOf(err), message: errorText(err) };
  }
}

/**
 * Move a binding to a new state.
 *
 * Promotion to `active` is the interesting one, and it is left to the partial
 * unique index rather than wrapped in a read-then-write: promoting a second
 * binding while one is already active must FAIL, loudly, instead of quietly
 * demoting a row the operator did not name. Retiring the current holder first is
 * the operator's step, and it is a separate call for exactly that reason.
 */
export async function setIdentityLoraBindingState(
  id: string,
  state: IdentityLoraBindingState,
): Promise<IdentityLoraBindingMutation> {
  try {
    const [row] = await db()
      .update(imageIdentityLoraBindings)
      .set({ state, updatedAt: new Date() })
      .where(eq(imageIdentityLoraBindings.id, id))
      .returning();
    if (!row) return { ok: false, code: "not_found", message: `no identity LoRA binding ${id}` };
    const parsed = identityLoraBindingSchema.safeParse(row);
    if (!parsed.success) {
      return { ok: false, code: "invalid", message: "the stored binding did not parse back" };
    }
    return { ok: true, binding: parsed.data };
  } catch (err) {
    return { ok: false, code: refusalCodeOf(err), message: errorText(err) };
  }
}

/**
 * The promoted binding for an identity pack, when there is one and it is usable.
 *
 * Returns nothing rather than a refusal: "this character has no promoted
 * character LoRA" is the ordinary case for every character in Vesper today, and
 * a render lane asking the question has nothing to report about it.
 */
export async function activeIdentityLoraBinding(
  identityPackId: string,
  sink?: DiagnosticSink,
): Promise<IdentityLoraBinding | null> {
  const [row] = await db()
    .select()
    .from(imageIdentityLoraBindings)
    .where(
      and(
        eq(imageIdentityLoraBindings.identityPackId, identityPackId),
        eq(imageIdentityLoraBindings.state, "active"),
      ),
    )
    .limit(1);
  if (!row) return null;
  const parsed = identityLoraBindingSchema.safeParse(row);
  if (!parsed.success) {
    sink?.push(
      diag("warn", BINDING_ROW_INVALID.code, BINDING_ROW_INVALID.message, {
        path: BINDING_ROW_INVALID.path,
        context: { id: row.id },
      }),
    );
    return null;
  }
  return parsed.data;
}

/** Postgres says which of the two refusals happened; the message is what an operator reads. */
function refusalCodeOf(err: unknown): "not_found" | "conflict" {
  const text = errorText(err).toLowerCase();
  // 23503 foreign_key_violation — the pack or the LoRA is not there.
  if (text.includes("foreign key")) return "not_found";
  // 23505 unique_violation — this pair, or this pack's active slot, is taken.
  return "conflict";
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
