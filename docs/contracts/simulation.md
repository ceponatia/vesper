[← Contracts index](README.md)

# Successor simulation contracts

The successor engine begins with the executable authority seam described by
[engine.spec.md](../developer-notes/engine.spec.md). Gate 1 proved that a
`transfer_item` request can be validated, resolved to one immutable
`item_transferred` event, synchronously projected, replayed, and compiled into a
perspective-safe NarrativeCut. Gate 2 target E2.1 promotes the causal primitives into
reusable production contracts.

The implementation lives in:

- `src/contracts/simulation/identity.ts` — opaque branded identities and safe integer
  causal primitives;
- `src/contracts/simulation/envelopes.ts` — principals and strict command, event, and
  exhaustive-result schema factories;
- `src/contracts/simulation/item-transfer.ts` — the first command/event/projection,
  observation, and NarrativeCut family;
- `src/lib/simulation/item-transfer.ts` — pure resolver, projector, replay, cut compiler,
  prompt formatter, and the temporary in-memory runtime;
- `src/server/engine/world-engine.ts` — the adapter into the existing character-chat
  narrator.

## Identity and causal primitives

Each identity family is a nominal TypeScript type backed by the same strict opaque string
shape. IDs are never trimmed, case-folded, resolved from display names, or accepted with
whitespace. World, branch, character, place, item, action, activity, commitment, journey,
engagement, command, event, trigger, observation, cut, outbox, and snapshot identities
therefore cannot be interchanged accidentally after parsing.

Deterministically derived identities use length-prefixed parts rather than ambiguous raw
delimiter concatenation. Event identity includes branch plus command identity, so the
same command ID on a causally isolated branch cannot collide in the global event catalog.

Story time and branch versions are nonnegative safe integers. Event sequence and schema
version are positive safe integers. Fractional, negative, infinite, and unsafe values fail
at the trust boundary.

## Command and event envelopes

Every command family uses one envelope factory: command identity, branch identity,
optimistic version, idempotency key, principal/controller grants, strict ISO operational
timestamp, optional requested story boundary, literal type/schema version, correlation
identity, and typed payload. The principal vocabulary includes player, deterministic NPC
policy, sparse NPC deliberator, system, director, storyteller, and migration authority.

Every event family uses one envelope factory with world/branch identity, branch sequence,
story time, ruleset, optional derivation and causation, correlation, stable actor/entity
reference sets, optional location, operational timestamp, and typed payload. Reference
sets must be sorted and unique so insertion order cannot become replay behavior.

Command outcomes share an accepted/rejected/conflict union. Accepted ranges cannot run
backward, skip a sequence, or repeat an event ID. Rejected public reasons and alternatives
remain separate from private predicates, while conflicts report the current branch
version.

## Item-transfer authority flow

`TransferItemCommand` uses the shared envelope and checks actor control, current source,
access to both holding containers, and destination capacity. Rejection and conflict do
not create domain history.

An accepted command emits one `ItemTransferredEvent` using the shared event envelope. The
event records observer IDs derived at resolution time under `gate1-perception-v1`; replay
therefore does not recompute historical visibility from newer state. The synchronous
projector moves the item to exactly one container and creates one typed observation per
eligible witness.

## Perspective and narration

The NarrativeCut query joins through the observation ledger before it reads event detail.
An observer receives the transfer as one required beat. A non-observer receives no actor,
item, source, destination, event, or denial-cause detail—only a generic prohibition on
claiming unobserved inventory changes.

The existing narrator receives the cut only through
`buildCharacterChatPromptForNarrativeCut`. It may vary presentation, but the prompt grants
no additional hard transition. Rerender variants reuse the same cut ID and semantic hash
and have no command or persistence capability.

## Deliberate limits

E2.1 defines contracts, not durability. The item-transfer adapter remains in memory and
does not provide crash atomicity, concurrent process locking, durable command results,
branch forking, scheduling, movement, or live-chat integration. E2.2 replaces that adapter
with the minimum PostgreSQL branch transaction while retaining these schemas.
