import { and, eq } from "drizzle-orm";
import {
  emptyImageLabSettings,
  type ImageLabCreateExperimentRequest,
  type ImageLabExperiment,
} from "@vesper/image-core";
import { REPLICATE_DEFAULT_EDIT_MODEL } from "@vesper/image-replicate";
import type { DiagnosticSink } from "@/contracts/diagnostics";
import { characterChats, characters, db, imageLabExperiments } from "../db";
import {
  type ImageLabRefusal,
  labCharacterNames,
  labRefusal,
  ownedExperiment,
  sourceRefusal,
  toWireExperiment,
  twoCharacterCast,
} from "./image-lab-store";

/**
 * Creating an experiment: validate what the admin asked for against the row it
 * would produce, and write it.
 */

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

export interface CreateImageLabExperimentInput {
  ownerId: string;
  request: ImageLabCreateExperimentRequest;
  sink?: DiagnosticSink;
}

export type CreateImageLabExperimentResult =
  | { ok: true; experiment: ImageLabExperiment }
  | { ok: false; refusal: ImageLabRefusal };

/**
 * Record one experiment. The ROUTE starts the job that runs it (see the module
 * note), so a created experiment is `pending` until that job claims it.
 *
 * Three things are checked here and nowhere else, all because they are
 * authorization rather than configuration: a named chat, a named character, and
 * every character a two-character scene names on its INPUTS must be THIS
 * owner's. `image_lab_experiments` has plain foreign keys with no owner
 * constraint, so without these an admin could point a baseline at someone else's
 * chat and have the runner read its look anchor, or name a stranger's character
 * on an identity input and have the runner read their name into the prompt.
 *
 * A fourth check is not authorization but feedback: a two-character scene whose
 * two subjects answer to one name (or to none) is refused here as well as by the
 * runner, because the fix is a rename the admin makes in another screen and a
 * settled `failed` row is a poor way to ask for one.
 *
 * Deliberately NOT checked: that a probe carries any particular inputs, that it
 * names a control at all, or that the control it names is a real fixture. Those
 * are the runner's recorded refusals (spec §Algorithms steps 1 and 3) — a 400
 * there would leave no trace of the attempt, and the whole point of the bench is
 * that attempts leave traces. (The request SCHEMA does refuse a declaration that
 * contradicts its own inputs, which is a client bug rather than an attempt, and
 * the runner re-checks it anyway for rows that predate the rule.)
 */
export async function createImageLabExperiment(
  input: CreateImageLabExperimentInput,
): Promise<CreateImageLabExperimentResult> {
  const { ownerId, request, sink } = input;
  if (request.characterId !== undefined && !(await ownsCharacter(request.characterId, ownerId))) {
    return {
      ok: false,
      refusal: labRefusal("character_not_found", "character not found", sink, { characterId: request.characterId }),
    };
  }
  if (request.chatId !== undefined && !(await ownsChat(request.chatId, ownerId))) {
    return { ok: false, refusal: labRefusal("chat_not_found", "chat not found", sink, { chatId: request.chatId }) };
  }
  // A two-character scene names its subjects on the INPUTS, so each of them is an
  // authorization check of exactly the same weight as the top-level one above —
  // and without it the runner would read a foreign character's name to build the
  // prompt with. Refused identically, so a client cannot tell an unowned
  // character from one that does not exist.
  for (const input of request.inputs) {
    if (input.characterId !== undefined && !(await ownsCharacter(input.characterId, ownerId))) {
      return {
        ok: false,
        refusal: labRefusal("character_not_found", "character not found", sink, { characterId: input.characterId }),
      };
    }
  }

  // The one cast rule the request schema cannot reach: two DIFFERENT character
  // ids can carry one NAME (or a blank one), and the numbered bindings that tell
  // the model which face is whose would then say the same words twice. Checked
  // here as well as in the runner because the admin can act on it — rename one
  // character — and a form that took the row would answer with a failed
  // experiment they have to go and read the reason off instead.
  //
  // ASSETS are deliberately not checked here (whether each identity image is a
  // render of the character it is bound to): a create-time asset check would go
  // stale between the queue and the render, and the runner is authoritative for
  // rows that arrive around this path at all. One refusal code covers the blank
  // and the colliding pair, the way `control_invalid` covers a family — the
  // MESSAGE names which of them happened.
  if (request.kind === "two_character_scene") {
    const subjectIds = request.inputs.flatMap((entry) => (entry.characterId === undefined ? [] : [entry.characterId]));
    // `null` means a character went away between the ownership check above and
    // this read — nothing to rule on, and the runner refuses the row anyway.
    const cast = subjectIds.length === 0 ? null : await labCharacterNames(subjectIds, ownerId);
    const named = cast === null ? null : twoCharacterCast(subjectIds, cast);
    if (named !== null && !named.ok) {
      return { ok: false, refusal: labRefusal("characters_share_name", named.message, sink, { subjectIds }) };
    }
  }

  // A finishing pass is defined by the run it refines, so the source is resolved
  // BEFORE the row exists: its subject is inherited from that run, and an
  // experiment stored against a source that cannot be finished would be a queued
  // render that can only fail. The runner re-checks all of it anyway (rows
  // outlive their sources), so this is speed of feedback, not the authority.
  const source = request.sourceExperimentId === undefined ? null : await ownedExperiment(request.sourceExperimentId, ownerId);
  if (request.sourceExperimentId !== undefined) {
    const refusal = sourceRefusal(request.sourceExperimentId, source, sink);
    if (refusal) return { ok: false, refusal };
  }

  const [row] = await db()
    .insert(imageLabExperiments)
    .values({
      ownerId,
      kind: request.kind,
      mode: request.mode ?? null,
      // Inherited from the source on a finishing pass (the request carries
      // neither, per the create schema): the two arms of one comparison must file
      // against the same subject, and a client that could name a third would be
      // able to file the finished render under someone else entirely.
      characterId: request.characterId ?? source?.characterId ?? null,
      chatId: request.chatId ?? source?.chatId ?? null,
      // The model the plan is about. A named slug is how the fallback connector
      // gets probed if the first verdict reads `ignores_control`.
      modelSlug: request.modelSlug ?? REPLICATE_DEFAULT_EDIT_MODEL,
      instruction: request.instruction,
      inputs: request.inputs,
      controlImageId: request.controlImageId ?? null,
      controlKind: request.controlKind ?? null,
      settings: request.settings ?? emptyImageLabSettings(),
      // The create-time meta keys — a finishing pass's two (the run it refines
      // and the arm it runs) and a staged scene's one. Written here and
      // preserved by every later write through `labMeta`.
      ...createMeta(request),
      status: "pending",
    })
    .returning();
  if (!row) throw new Error("image_lab_experiments insert returned no row");
  return { ok: true, experiment: toWireExperiment(row, sink) };
}

/**
 * The `meta` column a create writes, or nothing at all.
 *
 * Only two kinds have create-time meta — a finishing pass and a staged scene
 * (the create schema refuses each key on every other kind) — so most inserts
 * contribute no `meta` key whatsoever and take the column's own `{}` default.
 * Spread rather than assigned for that reason: writing `meta: {}` on every kind
 * would be an empty bag standing where "this row never had create-time facts" is
 * the truth.
 *
 * The variant is stored EXACTLY as sent, including an explicit `"identity"`. A
 * request that names its arm is a request that made a choice, and flattening the
 * chosen default into an absence would lose the one fact distinguishing a Stage 5
 * identity arm from a Stage 3 pass that predates the question.
 *
 * The staging is stored the same way and for a blunter reason: the staged lane
 * reads the ROW, so this write is the only thing that makes the kind runnable at
 * all. It is NOT validated against the registry here — that is the runner's
 * `subject_invalid`, settled onto the row where an admin can read which id
 * nothing answered to, exactly as the control-fixture gates are the runner's.
 */
function createMeta(request: ImageLabCreateExperimentRequest): { meta?: Record<string, unknown> } {
  const meta: Record<string, unknown> = {};
  if (request.sourceExperimentId !== undefined) meta.sourceExperimentId = request.sourceExperimentId;
  if (request.finishingVariant !== undefined) meta.finishingVariant = request.finishingVariant;
  if (request.staging !== undefined) meta.staging = request.staging;
  return Object.keys(meta).length === 0 ? {} : { meta };
}



async function ownsCharacter(characterId: string, ownerId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.ownerId, ownerId)))
    .limit(1);
  return row !== undefined;
}

async function ownsChat(chatId: string, ownerId: string): Promise<boolean> {
  const [row] = await db()
    .select({ id: characterChats.id })
    .from(characterChats)
    .where(and(eq(characterChats.id, chatId), eq(characterChats.ownerId, ownerId)))
    .limit(1);
  return row !== undefined;
}
