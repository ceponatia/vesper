import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { ImageProfileTask } from "@/contracts";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { endTestPool, probeIntegrationDb } from "@/server/test-support";
import { db, imageModelProfiles, imageModels } from "../db";
import { loadImageModelProfiles, loadImageModelProfilesForTask, resolveImageProfileForTask } from "./model-profiles";

/**
 * The profile registry against a migrated database (image-model-capabilities.spec.md
 * §`image_model_profiles`). Two jobs:
 *
 * 1. BEHAVIOR PRESERVATION. Slice 1 ships the profile layer dormant, and the whole
 *    claim is that resolving a task's profile picks the model that task's lane
 *    renders with today. If that is wrong, slice 2 silently changes every image the
 *    moment it wires a lane through here. Nothing else in the suite catches that —
 *    the pure contract tests cannot see the seeded rows, and no lane calls this yet.
 * 2. Degradation: a dead stored pick, an unparseable row, and a task with nothing
 *    offered each degrade with the documented diagnostic code, never an exception.
 *
 * `purgeOwnerRows` does NOT reach these tables — `image_models` and
 * `image_model_profiles` have no owner column, they are global registry data — so
 * every fixture row here is deleted by id, and nothing may touch the seeded rows.
 */

const ready = await probeIntegrationDb("images model-profiles.int.test", "image_model_profiles");

/**
 * A model row of our own, so the row-invalid and cascade cases have something to
 * hang off that is not a seeded row. Every surface toggle is off and its profiles
 * live on `text_repair` (a task the migration seeds nothing for), so it cannot enter
 * any candidate list the seeded-behavior assertions read.
 */
const FIXTURE_MODEL_ID = "imgmdlprofilefixtureaaaa";
const FIXTURE_OK_PROFILE_ID = "imgprffixtureokaaaaaaaaa";
const FIXTURE_BAD_PROFILE_ID = "imgprffixturebadaaaaaaaa";
const FIXTURE_PROFILE_IDS = [FIXTURE_OK_PROFILE_ID, FIXTURE_BAD_PROFILE_ID];

/**
 * The seeded rows, as the migrations wrote them. Any drift here is a render change.
 * 17 from migration 0100, plus 5 from 0104 (three portrait-only text-to-image
 * models and the two SDXL PuLID edit profiles).
 */
const SEEDED_PROFILE_COUNT = 22;
const QWEN_GENERATE = "qwen/qwen-image-2512";
const QWEN_EDIT = "qwen/qwen-image-edit-2511";

beforeAll(async () => {
  if (!ready) return;
  // Delete first so a run that died before `afterAll` cannot leave a stale fixture
  // behind: the leftover would be an unparseable row the FIRST describe asserts the
  // absence of, and the suite would fail for the previous run's crash.
  await db().delete(imageModels).where(eq(imageModels.id, FIXTURE_MODEL_ID));
  await db().insert(imageModels).values({
    id: FIXTURE_MODEL_ID,
    slug: "vesper-test/profile-fixture",
    label: "Profile Fixture",
    canGenerate: true,
    canEdit: false,
  });
});

afterAll(async () => {
  if (ready) {
    // By id, in child-then-parent order. The cascade test already removes both, so
    // these are the net that keeps a mid-suite failure from leaving registry rows
    // behind for the next run to trip over.
    await db().delete(imageModelProfiles).where(inArray(imageModelProfiles.id, FIXTURE_PROFILE_IDS));
    await db().delete(imageModels).where(eq(imageModels.id, FIXTURE_MODEL_ID));
  }
  await endTestPool();
});

/** Insert one fixture profile on the fixture model. `label` is a parameter because
 * an empty label is how this suite forges an unparseable row. */
async function insertFixtureProfile(id: string, label: string): Promise<void> {
  await db().insert(imageModelProfiles).values({
    id,
    imageModelId: FIXTURE_MODEL_ID,
    key: `fixture-${id}`,
    label,
    task: "text_repair",
    operation: "generate",
    promptStrategy: "text_to_image_description",
    // Never `isDefault`: the partial unique index allows one enabled default per
    // task, and a fixture claiming one would make the suite order-dependent.
    isDefault: false,
    sort: 900,
  });
}

describe.skipIf(!ready)("seeded image model profiles", () => {
  it("the migrations seeded 22 built-in profiles, in sort order, all parseable", async () => {
    const sink = new DiagnosticCollector();
    const profiles = await loadImageModelProfiles(sink);
    const builtin = profiles.filter((profile) => profile.builtin);

    expect(builtin).toHaveLength(SEEDED_PROFILE_COUNT);
    expect(builtin.every((profile) => profile.enabled)).toBe(true);
    // The loader orders by `sort`, and the resolver's "first offered profile" step
    // depends on that being true at the boundary rather than in the caller.
    const sorts = profiles.map((profile) => profile.sort);
    expect([...sorts].sort((a, b) => a - b)).toEqual(sorts);
    expect(sink.items.filter((d) => d.code === "image_profile.row_invalid")).toEqual([]);
  });

  it("carries exactly one enabled default per seeded task and never two for any task", async () => {
    const profiles = await loadImageModelProfiles();
    const defaultsByTask = new Map<string, string[]>();
    for (const profile of profiles) {
      if (!profile.isDefault || !profile.enabled) continue;
      defaultsByTask.set(profile.task, [...(defaultsByTask.get(profile.task) ?? []), profile.id]);
    }

    // Every task a lane resolves today has a default; the three unseeded tasks
    // (`text_repair`, `example_transform`, `image_set`) deliberately have none.
    const tasksWithDefaults = [...defaultsByTask.keys()].sort();
    expect(tasksWithDefaults).toEqual(["chat_look", "chat_place", "item", "location", "portrait", "scene", "variant"]);
    for (const [task, ids] of defaultsByTask) {
      expect(ids, `task ${task} must have one default`).toHaveLength(1);
    }
  });

  // THE behavior-preservation assertion, and no longer a forecast: since
  // capabilities slice 2 these seven lanes resolve through THIS function on every
  // render. `portrait`/`item`/`location`/`chat_place` must land on the generator
  // they used when they resolved a surface model; `variant`/`scene`/`chat_look` on
  // the instruction editor. A null stored pick is the anchor-lane case: `item`,
  // `location`, `chat_place` and `chat_look` have no picker at all.
  const anchorExpectations: ReadonlyArray<readonly [ImageProfileTask, string]> = [
    ["portrait", QWEN_GENERATE],
    ["item", QWEN_GENERATE],
    ["location", QWEN_GENERATE],
    ["chat_place", QWEN_GENERATE],
    ["variant", QWEN_EDIT],
    ["scene", QWEN_EDIT],
    ["chat_look", QWEN_EDIT],
  ];

  for (const [task, slug] of anchorExpectations) {
    it(`resolves ${task} to ${slug} with no stored selection`, async () => {
      const sink = new DiagnosticCollector();
      const resolved = await resolveImageProfileForTask(task, null, sink);

      expect(resolved?.model.slug).toBe(slug);
      expect(resolved?.profile.task).toBe(task);
      expect(resolved?.profile.isDefault).toBe(true);
      // Resolving the documented default is the normal path, not a substitution.
      expect(sink.items).toEqual([]);
    });
  }

  it("offers each task exactly the models its lane could reach today", async () => {
    const offeredSlugs = async (task: ImageProfileTask): Promise<string[]> =>
      (await loadImageModelProfilesForTask(task))
        .filter((candidate) => candidate.profile.builtin)
        .map((candidate) => candidate.model.slug);

    // Portrait is generate-only, so every `for_portrait` model qualifies — including
    // the three 0104 text-to-image models, which have no reference input at all.
    expect(await offeredSlugs("portrait")).toEqual([
      QWEN_GENERATE,
      "bytedance/seedream-4.5",
      "bytedance/seedream-5-lite",
      "stability-ai/stable-diffusion-3.5-large",
      "wan-video/wan-2.7-image-pro",
      "aisha-ai-official/nsfw-flux-dev:fb4f086702d6a301ca32c170d926239324a7b7b2f0afc3d232a9c4be382dc3fa",
      "aisha-ai-official/likereality-pony-v1:f777e1c330555044053ad5089fbcee89804e3df2419c1e09d9bbc80a399b01a2",
      "prunaai/p-image",
    ]);
    // Scene is identity-critical: the two `img2img`/`weak` models are absent because
    // they are portrait-only AND `profileEligibility` would refuse them anyway. The
    // three 0104 generators are absent for a blunter reason — no reference input, so
    // `can_edit` is false. SDXL PuLID is the one of that batch that qualifies.
    expect(await offeredSlugs("scene")).toEqual([
      QWEN_EDIT,
      "bytedance/seedream-4.5",
      "bytedance/seedream-5-lite",
      "wan-video/wan-2.7-image-pro",
      "nsfw-api/sdxl-pulid:83bea633f1fbae0729dcfca1c431b01ae2a9e3e39c25b055fed6da2b916822d5",
    ]);
    // The anchor lanes are seeded on one model each — nothing new became eligible.
    expect(await offeredSlugs("chat_look")).toEqual([QWEN_EDIT]);
    expect(await offeredSlugs("item")).toEqual([QWEN_GENERATE]);
  });

  it("still honors a stored legacy model slug, resolving to that model's own profile", async () => {
    const sink = new DiagnosticCollector();
    const resolved = await resolveImageProfileForTask("scene", "bytedance/seedream-4.5", sink);

    expect(resolved?.model.slug).toBe("bytedance/seedream-4.5");
    expect(resolved?.profile.id).toBe("imgprfs45sceneaaaaaaaaaa");
    // Only Qwen Edit carries the global scene default, so a stored Seedream pick
    // lands on a NON-default profile. Warning here would flag every legacy chat that
    // is working exactly as its owner chose.
    expect(resolved?.profile.isDefault).toBe(false);
    expect(sink.items).toEqual([]);
  });

  it("still honors a stored legacy model id", async () => {
    const sink = new DiagnosticCollector();
    const resolved = await resolveImageProfileForTask("variant", "imgmdlseedream5liteaaaaa", sink);

    expect(resolved?.model.slug).toBe("bytedance/seedream-5-lite");
    expect(resolved?.profile.id).toBe("imgprfs5lvariantaaaaaaaa");
    expect(sink.items).toEqual([]);
  });

  it("degrades a dead stored pick to the task default AND records image_profile.pick_unavailable", async () => {
    // A pre-registry Venice key: the exact value owner ruling 5 says existing chats
    // still carry, because they were never migrated.
    const sink = new DiagnosticCollector();
    const resolved = await resolveImageProfileForTask("scene", "venice-hidream", sink);

    expect(resolved?.model.slug).toBe(QWEN_EDIT);
    expect(resolved?.profile.id).toBe("imgprf2511sceneaaaaaaaaa");
    const warned = sink.items.filter((d) => d.code === "image_profile.pick_unavailable");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.severity).toBe("warn");
    expect(warned[0]?.context).toMatchObject({ task: "scene", stored: "venice-hidream" });
  });

  it("degrades a real profile id belonging to another task, rather than honoring it", async () => {
    // The portrait profile is a live row, so this is not a "row is gone" case: it is
    // simply not among the scene candidates, and step 1 of the resolver must skip it.
    const sink = new DiagnosticCollector();
    const resolved = await resolveImageProfileForTask("scene", "imgprf2512portraitaaaaaa", sink);

    expect(resolved?.profile.task).toBe("scene");
    expect(resolved?.model.slug).toBe(QWEN_EDIT);
    expect(sink.items.map((d) => d.code)).toContain("image_profile.pick_unavailable");
  });

  it("returns null AND records image_profile.none_offered for a task nothing is seeded for", async () => {
    const sink = new DiagnosticCollector();
    const resolved = await resolveImageProfileForTask("example_transform", null, sink);

    expect(resolved).toBeNull();
    expect(await loadImageModelProfilesForTask("example_transform")).toEqual([]);
    const errors = sink.items.filter((d) => d.code === "image_profile.none_offered");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.severity).toBe("error");
    expect(errors[0]?.context).toMatchObject({ task: "example_transform" });
  });
});

describe.skipIf(!ready)("profile registry resilience and cascade", () => {
  it("skips an unparseable row AND records image_profile.row_invalid, keeping the rest", async () => {
    // An empty `label` passes the column (`text not null`) and fails the contract
    // (`z.string().min(1)`) — the cheapest honest way to forge the row a bad admin
    // edit or a half-applied deploy produces.
    await insertFixtureProfile(FIXTURE_BAD_PROFILE_ID, "");

    const sink = new DiagnosticCollector();
    const profiles = await loadImageModelProfiles(sink);

    expect(profiles.map((profile) => profile.id)).not.toContain(FIXTURE_BAD_PROFILE_ID);
    expect(profiles.filter((profile) => profile.builtin)).toHaveLength(SEEDED_PROFILE_COUNT);
    const warned = sink.items.filter((d) => d.code === "image_profile.row_invalid");
    expect(warned).toHaveLength(1);
    expect(warned[0]?.severity).toBe("warn");
    expect(warned[0]?.context).toMatchObject({ id: FIXTURE_BAD_PROFILE_ID });

    // The only `text_repair` row is the broken one, so the task degrades to nothing
    // offered rather than to a half-parsed profile.
    const resolveSink = new DiagnosticCollector();
    expect(await resolveImageProfileForTask("text_repair", null, resolveSink)).toBeNull();
    expect(resolveSink.items.map((d) => d.code)).toContain("image_profile.none_offered");
  });

  it("deleting a model takes its profiles with it", async () => {
    await insertFixtureProfile(FIXTURE_OK_PROFILE_ID, "Fixture Text Repair");

    // Proves the loader sees a new row and the resolver's last step (first offered
    // profile in sort order) works with no default and no legacy surface toggle.
    const resolved = await resolveImageProfileForTask("text_repair", null);
    expect(resolved?.profile.id).toBe(FIXTURE_OK_PROFILE_ID);
    expect(resolved?.profile.isDefault).toBe(false);

    // `on delete cascade` on `image_model_id` is what keeps an orphaned profile from
    // reaching the render path — unlike a stored model pick, which is a plain string
    // the resolver is allowed to degrade.
    await db().delete(imageModels).where(eq(imageModels.id, FIXTURE_MODEL_ID));

    const survivors = await db()
      .select({ id: imageModelProfiles.id })
      .from(imageModelProfiles)
      .where(inArray(imageModelProfiles.id, FIXTURE_PROFILE_IDS));
    expect(survivors).toEqual([]);
    // And the seeded set is untouched by any of it.
    expect((await loadImageModelProfiles()).filter((profile) => profile.builtin)).toHaveLength(SEEDED_PROFILE_COUNT);
  });
});
