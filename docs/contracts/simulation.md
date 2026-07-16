[← Contracts index](README.md)

# Successor simulation contracts (Gate 1)

Gate 1 introduces the first executable authority seam described by
[engine.spec.md](../developer-notes/engine.spec.md): a `transfer_item` request is validated,
resolved to one immutable `item_transferred` event, synchronously projected, replayed, and
compiled into a perspective-safe NarrativeCut.

The implementation is intentionally narrow and lives in:

- `src/contracts/simulation/item-transfer.ts` — trust-boundary schemas and types;
- `src/lib/simulation/item-transfer.ts` — pure resolver, projector, replay, cut compiler,
  prompt formatter, and the temporary in-memory runtime;
- `src/server/engine/world-engine.ts` — the adapter into the existing character-chat
  narrator.

## Authority flow

`TransferItemCommand` includes branch identity, expected version, idempotency key,
principal/controller grants, correlation identity, and the claimed source and destination.
The resolver checks actor control, current source, access to both holding containers, and
destination capacity. Rejection and conflict do not create domain history.

An accepted command emits one `ItemTransferredEvent`. The event records the observer IDs
derived at resolution time under `gate1-perception-v1`; replay therefore does not
recompute historical visibility from newer state. The synchronous projector moves the
item to exactly one container and creates one typed observation per eligible witness.

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

This is an in-memory architecture experiment, not production persistence. It does not yet
provide crash atomicity, concurrent process locking, durable command results, branch
forking, scheduling, movement, or live-chat integration. Those stay outside Gate 1 so the
command/event/projection/perspective contract can be measured and discarded or retained
before a migration fixes it in place.
