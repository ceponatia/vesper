# The successor lane's ownership anchor

`sim_worlds` and `sim_branches` deliberately carry **no owner column**, so the successor lane's
only account boundary is the chat anchor: `character_chats.sim_branch_id` →
`character_chats.owner_id`.

The route gate (`requireSimChat`) enforces it at the edge, and the **durable command layer proves
it again for itself**, so a new caller cannot reach the world by supplying an envelope.
`authorizeSimulationCommand` (`server/engine/simulation/command-authz.ts`) is called by all three
command shells — `runSimulationCommand` plus the space store's and scheduler store's inlined copies
— **above** the idempotency read and the transaction that owns every write.

| Principal kind                                         | Rule                                                                                                                                                                         |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `player`                                               | `principalId` must equal the owning chat's `owner_id`. It is the only kind minted from a player-supplied request, and its id is a `users.id`.                                |
| `director`, `storyteller`                              | Pass. Their entry points are the admin sim routes (404 for a non-admin before an envelope exists) and world provisioning; an admin is allowed on any branch by construction. |
| `npc_policy`, `npc_deliberator`, `system`, `migration` | Pass. Engine-internal — the arbiter, the scheduler drain, the world seeders — whose `principalId` is a fixed label (`sim-scheduler`), not an account.                        |

- **A branch no chat points at is unanchored** and admits: a fixture branch, a fork not yet linked,
  or a world provisioned in the moments before its chat row exists (`/api/successor-chats` seeds
  the authored relationship first, then flips the chat onto the branch). Nothing outside the server
  can name a branch id — the player route derives it from a chat it already proved you own.
- **Two accounts' chats on one branch** means ownership is unreadable, so **nobody** passes
  (`ambiguous_anchor`).
- The refusal is **not-found-shaped** (`branch_mismatch`, the same result an absent branch returns)
  so it is never a branch-existence oracle; the private cause rides a `sim.command_denied` warn
  diagnostic. Matrix in `server/engine/simulation/command-authz.int.test.ts`.
- A drain resubmission re-proves the *same* owner: `scheduleDurableTrigger` copies the scheduled
  command's principal, so a player-originated arrival fires under the principal its parent command
  was admitted with.
