import { describe, expect, it } from "vitest";
import { resolveOverrideDirection } from "./validate";

/**
 * The developer-override direction rules, pure
 * (romantic-contact-affordances.spec.permission.md §"Authorship and developer
 * controls"; plan ruling 1): targets are roster NPCs only — never the player —
 * actors are the player or a roster NPC, and a direction needs two different
 * participants.
 */

const PLAYER = "player";
const MARA = "char_mara";
const ALEX = "char_alex";
const ROSTER = [MARA, ALEX];

const base = { rosterCharacterIds: ROSTER, playerSubjectId: PLAYER };

describe("resolveOverrideDirection", () => {
  it("accepts player → roster NPC (the ordinary player-side direction)", () => {
    const result = resolveOverrideDirection({ ...base, permittedActorId: PLAYER, grantingTargetId: MARA });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(String(result.permittedActorId)).toBe(PLAYER);
      expect(String(result.grantingTargetId)).toBe(MARA);
    }
  });

  it("accepts NPC → other NPC — one direction, not a symmetric pair", () => {
    expect(resolveOverrideDirection({ ...base, permittedActorId: ALEX, grantingTargetId: MARA })).toMatchObject({
      ok: true,
    });
  });

  it("rejects the player as granting target — no player grant exists to edit", () => {
    expect(resolveOverrideDirection({ ...base, permittedActorId: MARA, grantingTargetId: PLAYER })).toMatchObject({
      ok: false,
      code: "target_is_player",
    });
  });

  it("rejects a granting target outside the roster", () => {
    expect(
      resolveOverrideDirection({ ...base, permittedActorId: PLAYER, grantingTargetId: "char_stranger" }),
    ).toMatchObject({ ok: false, code: "target_not_in_roster" });
  });

  it("rejects a permitted actor that is neither the player nor a roster member", () => {
    expect(
      resolveOverrideDirection({ ...base, permittedActorId: "char_stranger", grantingTargetId: MARA }),
    ).toMatchObject({ ok: false, code: "actor_not_in_chat" });
  });

  it("rejects a self-directed grant", () => {
    expect(resolveOverrideDirection({ ...base, permittedActorId: MARA, grantingTargetId: MARA })).toMatchObject({
      ok: false,
      code: "actor_is_target",
    });
  });

  it("the target-is-player rule outranks the roster check", () => {
    // A roster that (wrongly) contained the player subject still may not grant on
    // the player's behalf.
    expect(
      resolveOverrideDirection({
        permittedActorId: MARA,
        grantingTargetId: PLAYER,
        rosterCharacterIds: [PLAYER, MARA],
        playerSubjectId: PLAYER,
      }),
    ).toMatchObject({ ok: false, code: "target_is_player" });
  });
});
