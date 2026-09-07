import type { ChatScenario } from "./types";
import {
  diag,
  applyEnvironmentProposal,
  applySurfaceWetnessProposals,
  parseSurfaceWetnessProposals,
  applySurfaceDepositProposals,
  parseSurfaceDepositProposals,
  applyBodyMarkProposals,
  type ChatSurfaceTraceEntry,
} from "@/contracts";
import { applySurfaceTransferProposals } from "@/contracts/turns/chat-contact-transfer";
import type { ChatExtractionResult } from "../chat-memory";
import type { FinalizeChatStateInput } from "./finalize-types";

type FoldFinalizationSurfaceInput = Pick<
  FinalizeChatStateInput,
  "scenario"
  | "driftedState"
  | "sink"
  | "contactMarkProposals"
  | "surfaceTransfer"
  | "characterId"
>;

export function foldFinalizationSurface(
  input: FoldFinalizationSurfaceInput,
  archivist: ChatExtractionResult,
  garmentStore: ChatScenario["garments"],
) {
  // --- Scene environment + body surface ---
  // The same shape as the garment fold above: a pure apply over typed proposals,
  // a trace, and diagnostics — never a re-read of the narrator's prose.
  //
  // The ENVIRONMENT is chat-wide and lands on the scenario (one sky for the
  // roster, and it rolls back with `pre_exchange_scenario`); the SURFACE is
  // per-character and lands on the state row. Both folds run on a degraded
  // archivist too, as no-ops: an absent proposal leaves the standing weather
  // standing, and the surface fold still prunes anything that has dried to
  // nothing — which cannot change what any read returns.
  //
  // PRIMARY CHARACTER ONLY this release (owner ruling). The player's surface
  // would ride `ChatScenario` (one player, many characters, like `playerState`);
  // an ensemble member's would ride their own row through the per-member personal
  // pass — neither is wired, and the extraction field says so in as many words.
  const environmentFold = applyEnvironmentProposal({
    environment: input.scenario.environment,
    ...(archivist.value ? { proposal: archivist.value.environment } : {}),
    atMinutes: input.scenario.clockMinutes,
  });
  // The environment patch lands FIRST and the surface fold integrates against
  // the result, so an exchange that opens a downpour holds this exchange's
  // wetness rather than drying it under the sky it was standing in a moment ago.
  const surfaceFold = applySurfaceWetnessProposals({
    surface: input.driftedState.bodySurface,
    proposals: parseSurfaceWetnessProposals(
      archivist.value?.surfaceWetness ?? [],
      input.sink,
      "chat_archivist.surfaceWetness",
    ),
    atMinutes: input.scenario.clockMinutes,
    environment: environmentFold.environment,
    sink: input.sink,
  });
  // Deposits fold next, onto the wetness fold's result — the same owner, one
  // more module, and no flag: material on skin is ordinary authoritative body
  // state exactly as wetness is, and gating it behind the contact-effects
  // switch would make "she still has mud on her hands" unrememberable for the
  // continuity system that has nothing to do with contact.
  //
  // No environment argument, and no prune pass: a deposit does not leave a
  // surface on its own, so there is nothing for the clock to integrate and an
  // empty proposal list returns the wetness fold's surface by reference.
  const depositFold = applySurfaceDepositProposals({
    surface: surfaceFold.surface,
    proposals: parseSurfaceDepositProposals(
      archivist.value?.surfaceDeposits ?? [],
      input.sink,
      "chat_archivist.surfaceDeposits",
    ),
    atMinutes: input.scenario.clockMinutes,
    sink: input.sink,
  });
  // --- Contact-effect owner transaction (`CHAT_CONTACT_EFFECTS`, default off) ---
  // The pressure-mark commit: the body-surface owner
  // validates each proposal against its own vocabulary and commits at most one
  // mark per idempotency identity. Runs AFTER the wetness fold so both modules
  // land in one state value under one rollback anchor, and only when the
  // pipeline actually derived proposals — the absent case leaves the fold's
  // result untouched, byte-identical to a build without the flag.
  const effectFold =
    input.contactMarkProposals !== undefined && input.contactMarkProposals.length > 0
      ? applyBodyMarkProposals({
          surface: depositFold.surface,
          proposals: input.contactMarkProposals,
          atMinutes: input.scenario.clockMinutes,
          ...(input.sink === undefined ? {} : { sink: input.sink }),
        })
      : { surface: depositFold.surface, trace: [] };
  // --- Conserved surface transfer ---
  // The second effect proof, and the one that spans owners: material leaves one
  // body's surface and lands on another body, or on a garment layer in between.
  //
  // It runs HERE, last in the fold chain and inside this function, because the
  // conservation law is a statement about exact quantities: the debit has to come
  // off the same surface value that gets persisted. `effectFold.surface` is that
  // value — it already carries this exchange's drying, deposits and pressure
  // marks — so settling against anything else (a copy loaded before the turn, say)
  // would either silently un-apply those folds on write or need a merge that has
  // no correct answer, both sides having edited the same deposit records.
  //
  // The layer side is `garmentStore` for the same reason: it is the post-fold,
  // about-to-be-persisted wardrobe, so an intermediate garment is credited on the
  // value the scenario write actually stores.
  const transferFold =
    input.surfaceTransfer !== undefined
      ? applySurfaceTransferProposals({
          proposals: input.surfaceTransfer.proposals,
          owners: {
            source: effectFold.surface,
            // Same character on both ends ⇒ ONE surface, and it must be the
            // folded one. The pure transaction warns it never assumes the pair
            // differs: handing it the caller's separately-loaded copy here would
            // fold the debit and the credit onto two stale objects and lose
            // whichever landed second.
            destination:
              input.surfaceTransfer.destination.characterId === input.characterId
                ? effectFold.surface
                : input.surfaceTransfer.destination.state.bodySurface,
            layers: garmentStore,
          },
          resolveLayer: input.surfaceTransfer.resolveLayer,
          atMinutes: input.scenario.clockMinutes,
          ...(input.sink === undefined ? {} : { sink: input.sink }),
        })
      : undefined;
  // Nothing committed ⇒ nothing crossed an owner boundary, so there is no
  // cross-row invariant to protect and the ordinary write path is the correct
  // one. This covers every refusal AND the designed duplicate retry, which is
  // exactly the case that must NOT look like a second transfer.
  const transferSettled =
    input.surfaceTransfer !== undefined && transferFold !== undefined && transferFold.committed > 0
      ? {
          bodySurface: transferFold.owners.source,
          garments: transferFold.owners.layers,
          // Absent when the material never left this character's own body: one
          // row, already written above as `bodySurface`.
          destination:
            input.surfaceTransfer.destination.characterId === input.characterId
              ? undefined
              : {
                  characterId: input.surfaceTransfer.destination.characterId,
                  state: {
                    ...input.surfaceTransfer.destination.state,
                    bodySurface: transferFold.owners.destination,
                  },
                  preExchangeState: input.surfaceTransfer.destination.preExchangeState,
                },
        }
      : undefined;
  const surfaceTrace: ChatSurfaceTraceEntry[] = [
    ...environmentFold.trace,
    ...surfaceFold.trace,
    ...depositFold.trace,
    ...effectFold.trace,
    // Refusals included: a transfer that was rejected is a thing the inspector
    // needs to see, and it contributes no entries at all when nobody proposed one.
    ...(transferFold?.trace ?? []),
  ];
  if (surfaceTrace.length > 0) {
    input.sink?.push(
      diag(
        "info",
        "chat_surface.applied",
        surfaceTrace.map((entry) => `${entry.kind}:${entry.target} ${entry.outcome}`).join(", "),
      ),
    );
  }

  return { environmentFold, effectFold, transferSettled };
}

export type FinalizationSurface = ReturnType<typeof foldFinalizationSurface>;
