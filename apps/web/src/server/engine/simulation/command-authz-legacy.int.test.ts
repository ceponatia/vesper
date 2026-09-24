import { describe, expect, it } from "vitest";
import {
  branchFootprint,
  commandAuthzFixture,
  expectAccepted,
  LEGACY_ENGINE_TEST_PLAYER_ID,
  legacyUnanchoredEngineTestMode,
  simulationSuiteHarness,
} from "@/server/test-support";
import { SIM_COMMAND_DENIED } from "./command-authz";
import { submitDurableMoveActor } from "./space-store";

/**
 * The legacy synthetic-player capability, proven from INSIDE the legacy
 * integration mode — what it admits, and the two boundaries it never crosses.
 *
 * `VESPER_ALLOW_LEGACY_ENGINE_TEST_PLAYER=1` (under `NODE_ENV=test`) lets the
 * durable-engine suites that predate account/chat ownership submit an
 * account-less `player` principal against the branches they seed directly.
 * `authorizeSimulationCommand` admits that on an unanchored branch only when the
 * claimed id names NO account, and never on an anchored branch. This suite pins
 * all three halves with the capability ON; command-authz.int.test.ts pins that
 * the same ghost-on-an-unanchored-branch claim is refused with it OFF.
 *
 * `legacyPlayerMode: true` fails the file at collection unless the capability is
 * on, so this file must be a listed legacy exception in
 * `scripts/integration-policy.mjs`. The seeded shapes and real-account fixtures
 * are the strict suite's own (`commandAuthzFixture`).
 */

const harness = await simulationSuiteHarness({
  suite: "command-authz-legacy.int.test",
  table: "sim_physical_loci",
  legacyPlayerMode: true,
});
const ready = harness.ready;
const {
  accounts,
  seedUnanchoredCase,
  seedAnchoredCase,
  moveCommand,
  branchCounters,
  wroteNothingBaseline,
  expectWroteNothing,
  warnScopes,
} = commandAuthzFixture(harness, "cmd-authz-legacy");

describe.runIf(ready)("legacy synthetic-player capability", () => {
  it("admits the legacy fixture id (no account row) on an unanchored branch", async () => {
    expect(
      legacyUnanchoredEngineTestMode(),
      "command-authz-legacy must run in the legacy integration mode (capability on)",
    ).toBe(true);
    const ids = await seedUnanchoredCase();
    const result = await submitDurableMoveActor(moveCommand(ids, LEGACY_ENGINE_TEST_PLAYER_ID, "legacy-fixture"));
    expectAccepted(result, "the legacy fixture's move on a directly seeded, unanchored branch");
    expect(await branchFootprint(ids.branchId)).toMatchObject({ sim_commands: 1 });
    expect(await branchCounters(ids.branchId)).toMatchObject({ version: 1 });
  });

  it("still refuses a REAL account's player principal on an unanchored branch, and writes NOTHING", async () => {
    const ids = await seedUnanchoredCase();
    const before = await wroteNothingBaseline(ids.branchId);
    let result: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
    const scopes = await warnScopes(async () => {
      result = await submitDurableMoveActor(moveCommand(ids, accounts.ownerA, "legacy-real-account"));
    });
    expect(result).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    await expectWroteNothing(ids.branchId, before);
  });

  it("refuses the legacy fixture id on a branch a real account's chat anchors, and writes NOTHING", async () => {
    const ids = await seedAnchoredCase(accounts.ownerA);
    const before = await wroteNothingBaseline(ids.branchId);
    let result: Awaited<ReturnType<typeof submitDurableMoveActor>> | undefined;
    const scopes = await warnScopes(async () => {
      result = await submitDurableMoveActor(moveCommand(ids, LEGACY_ENGINE_TEST_PLAYER_ID, "legacy-anchored"));
    });
    expect(result).toMatchObject({ status: "rejected", code: "branch_mismatch" });
    expect(scopes).toContain(SIM_COMMAND_DENIED);
    await expectWroteNothing(ids.branchId, before);
  });
});
