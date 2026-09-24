import { describe, expect, it } from "vitest";
import { newId } from "@/lib/ids";
import {
  branchFootprint,
  commandAuthzFixture,
  expectAccepted,
  expectRejected,
  legacyUnanchoredEngineTestMode,
  simCommand,
  simulationSuiteHarness,
  type CommandAuthzCase,
} from "@/server/test-support";
import { SIM_COMMAND_DENIED } from "./command-authz";
import { submitDurableCreateCohort } from "./cohort-store";
import { submitDurableMoveActor } from "./space-store";

/**
 * The durable command layer proves ownership itself.
 *
 * The seam is exercised DIRECTLY (no route, no `requireSimChat`): a player
 * principal must resolve exactly one chat anchor and match its owner. Unanchored
 * branches remain usable by engine-internal principals, never by a player claim.
 * Both command shells are covered: the shared `runSimulationCommand` (via
 * `submitDurableCreateCohort`) and space-store's older inlined copy (via
 * `submitDurableMoveActor`).
 *
 * This suite runs in the STRICT integration mode: the legacy synthetic-player
 * capability (`VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER`) is absent from the
 * process. That is load-bearing, because the capability is exactly what lets a
 * player whose id names no account onto an unanchored branch — so the ghost-on-
 * an-unanchored-branch denial below only proves the production boundary when it
 * is off, and that test asserts the mode rather than trusting the harness option
 * (`legacyPlayerMode: false` only skips the legacy collection guard). What the
 * capability admits, and what it still refuses, is proven separately in
 * command-authz-legacy.int.test.ts. The seeded shapes and the real-user +
 * chat-anchor fixtures are shared with it (`commandAuthzFixture`); the claimed
 * principal id stays a parameter — it IS the subject.
 */

const harness = await simulationSuiteHarness({
  suite: "command-authz.int.test",
  table: "sim_physical_loci",
  legacyPlayerMode: false,
});
const ready = harness.ready;
const {
  accounts,
  seedUnanchoredCase,
  seedAnchoredCase,
  anchorChat,
  claimedPlayer,
  moveCommand,
  branchCounters,
  wroteNothingBaseline,
  expectWroteNothing,
  warnScopes,
} = commandAuthzFixture(harness, "cmd-authz");

function systemMoveCommand(ids: CommandAuthzCase, key: string) {
  return {
    ...moveCommand(ids, "sim-provisioner", key),
    principal: { kind: "system" as const, principalId: "sim-provisioner", controlledActorIds: [ids.actorId] },
  };
}

function cohortCommand(ids: CommandAuthzCase, principalId: string, key: string) {
  return simCommand({
    branchId: ids.branchId,
    name: `cohort-${key}`,
    type: "create_cohort",
    principal: claimedPlayer(ids, principalId),
    payload: {
      cohort: {
        id: newId(),
        name: "cafe regulars",
        population: 40,
        presenceWindows: [
          { zoneId: ids.zoneB, startMinuteOfDay: 480, endMinuteOfDay: 1_080, shareFixedPoint: 8_000 },
        ],
        registryVersion: "cohort-v1",
      },
    },
  });
}

describe.runIf(ready)("durable command ownership", () => {
  it("admits the owning account's player principal", async () => {
    const ids = await seedAnchoredCase(accounts.ownerA);
    const result = await submitDurableMoveActor(moveCommand(ids, accounts.ownerA, "owner"));
    expectAccepted(result, "the owning account's move on its own anchored branch");
    expect(await branchFootprint(ids.branchId)).toMatchObject({ sim_commands: 1 });
    expect(await branchCounters(ids.branchId)).toMatchObject({ version: 1 });
  });

  it("refuses another account's player principal, and writes NOTHING", async () => {
    const ids = await seedAnchoredCase(accounts.ownerA);
    const before = await wroteNothingBaseline(ids.branchId);
    let result: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
    const scopes = await warnScopes(async () => {
      result = await submitDurableMoveActor(moveCommand(ids, accounts.ownerB, "stranger"));
    });
    expect(result).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    await expectWroteNothing(ids.branchId, before);
  });

  it("refuses a principal id that belongs to no account at all", async () => {
    const ids = await seedAnchoredCase(accounts.ownerA);
    const before = await wroteNothingBaseline(ids.branchId);
    let result: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
    const scopes = await warnScopes(async () => {
      result = await submitDurableMoveActor(moveCommand(ids, `ghost-${newId()}`, "ghost"));
    });
    expect(result).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    await expectWroteNothing(ids.branchId, before);
  });

  it("fails closed when two accounts' chats cross-link the same branch", async () => {
    const ids = await seedAnchoredCase(accounts.ownerA);
    await anchorChat(ids.branchId, accounts.ownerB);
    const before = await wroteNothingBaseline(ids.branchId);
    let result: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
    const scopes = await warnScopes(async () => {
      result = await submitDurableMoveActor(moveCommand(ids, accounts.ownerA, "ambiguous"));
    });
    expect(result).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    await expectWroteNothing(ids.branchId, before);
  });

  it("refuses a PLAYER principal on an unanchored branch, and writes NOTHING", async () => {
    const ids = await seedUnanchoredCase();
    const before = await wroteNothingBaseline(ids.branchId);
    let result: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
    const scopes = await warnScopes(async () => {
      result = await submitDurableMoveActor(moveCommand(ids, accounts.ownerA, "unanchored-player"));
    });
    expect(result).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    await expectWroteNothing(ids.branchId, before);
  });

  // The one combination the legacy capability admits: an account-less player on
  // a branch no chat anchors. With the capability absent it is refused like any
  // other unproven claim. With it present this test fails on its precondition,
  // and would fail on the admitted move even without one.
  it("refuses a player principal whose id names NO account on an UNANCHORED branch, and writes NOTHING", async () => {
    expect(
      legacyUnanchoredEngineTestMode(),
      "command-authz must run in strict integration mode (legacy capability absent)",
    ).toBe(false);
    const ids = await seedUnanchoredCase();
    const before = await wroteNothingBaseline(ids.branchId);
    let result: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
    const scopes = await warnScopes(async () => {
      result = await submitDurableMoveActor(moveCommand(ids, `ghost-${newId()}`, "unanchored-ghost"));
    });
    expect(result).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    await expectWroteNothing(ids.branchId, before);
  });

  it("still admits an unanchored branch for an engine-internal principal", async () => {
    const ids = await seedUnanchoredCase();
    const result = await submitDurableMoveActor(systemMoveCommand(ids, "unanchored-system"));
    expectAccepted(result, "an engine-internal system move on an unanchored branch");
  });

  it("guards the SHARED runner too, above its command-ledger insert", async () => {
    const ids = await seedAnchoredCase(accounts.ownerA);
    const owned = await submitDurableCreateCohort(cohortCommand(ids, accounts.ownerA, "owner"));
    expectRejected(owned, "unauthorized_principal", "a player principal authoring a cohort");
    const afterOwner = await wroteNothingBaseline(ids.branchId);
    expect(afterOwner.footprint).toMatchObject({ sim_commands: 1 });

    let stranger: Awaited<ReturnType<typeof submitDurableCreateCohort>> | undefined;
    const scopes = await warnScopes(async () => {
      stranger = await submitDurableCreateCohort(cohortCommand(ids, accounts.ownerB, "stranger"));
    });
    expect(stranger).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    await expectWroteNothing(ids.branchId, afterOwner);
  });
});
