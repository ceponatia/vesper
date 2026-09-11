import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import type { ImageProfileTask } from "@vesper/image-core";
import { DiagnosticCollector } from "@/contracts/diagnostics";
import { endTestPool, probeIntegrationDb } from "@/server/test-support";
import { db, imageModelProfiles, imageModels } from "../db";
import {
  loadImageModelProfiles,
  loadImageModelProfilesForTask,
  resolveImageProfileForTask,
  updateImageModelProfile,
} from "./model-profiles";

/**
 * The profile registry against a migrated database. Two jobs:
 *
 * 1. DEFAULT/ROUTING PRESERVATION. These assertions pin the deliberately chosen
 *    model for every task: changing a default or offered set is a render change,
 *    and must move these expectations in the same patch as the migration.
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
 * The seeded rows, as the migrations wrote them. 0134 added six Qwen Image 3
 * profiles, then 0135 converted that regular/Pro fiction into fal's real
 * operation split: one portrait text-to-image profile plus variant and scene
 * edit profiles. Three obsolete cross-operation profiles are deleted, leaving 32.
 */
const SEEDED_PROFILE_COUNT = 32;
const QWEN_GENERATE = "qwen/qwen-image-2512";
const QWEN_EDIT = "qwen/qwen-image-edit-2511";
const QWEN_3_TEXT = "alibaba/qwen-image-3/text-to-image";
const QWEN_3_EDIT = "alibaba/qwen-image-3/edit";

/**
 * The 0107 curated rows, pinned individually: which model each hangs off, the
 * job it is for, and the sort that keeps it BELOW every Standard row in the
 * resolver's ordering. `PRE_CURATED_MAX_SORT` is the highest 0100/0104 sort —
 * a curated row sorting at or under it would change which profile a stored
 * legacy model pick resolves to, which is a render change.
 */
const PRE_CURATED_MAX_SORT = 95;
const CURATED_PROFILES: ReadonlyArray<{ id: string; slug: string; key: string; task: ImageProfileTask; sort: number }> = [
  { id: "imgprf2512portfastaaaaaa", slug: QWEN_GENERATE, key: "portrait-fast", task: "portrait", sort: 110 },
  { id: "imgprf2512portqualityaaa", slug: QWEN_GENERATE, key: "portrait-quality", task: "portrait", sort: 111 },
  { id: "imgprfs45ensemble2kaaaaa", slug: "bytedance/seedream-4.5", key: "ensemble-scene-2k", task: "scene", sort: 130 },
  { id: "imgprfs45location4kaaaaa", slug: "bytedance/seedream-4.5", key: "location-4k", task: "location", sort: 131 },
  { id: "imgprfs5lscene3kaaaaaaaa", slug: "bytedance/seedream-5-lite", key: "quality-scene-3k", task: "scene", sort: 140 },
  {
    id: "imgprfsd35highguidanceaa",
    slug: "stability-ai/stable-diffusion-3.5-large",
    key: "stylized-portrait-high-guidance",
    task: "portrait",
    sort: 150,
  },
  {
    id: "imgprfwan27multiedit2kaa",
    slug: "wan-video/wan-2.7-image-pro",
    key: "multi-reference-edit-2k",
    task: "scene",
    sort: 160,
  },
];

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
  it("the migrations seeded 32 built-in profiles, in sort order, all parseable", async () => {
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

  // The global defaults after 0135. Portrait creation is fal text-to-image;
  // variant/reference-view and scene work are fal edit. Item/location/chat-place
  // stay on Qwen 2512 and chat-look keeps its dedicated Qwen 2511 path.
  const anchorExpectations: ReadonlyArray<readonly [ImageProfileTask, string]> = [
    ["portrait", QWEN_3_TEXT],
    ["item", QWEN_GENERATE],
    ["location", QWEN_GENERATE],
    ["chat_place", QWEN_GENERATE],
    ["variant", QWEN_3_EDIT],
    ["scene", QWEN_3_EDIT],
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

  it("offers each task exactly the models its lane can reach after the fal Qwen Image 3 split", async () => {
    const offeredSlugs = async (task: ImageProfileTask): Promise<string[]> =>
      (await loadImageModelProfilesForTask(task))
        .filter((candidate) => candidate.profile.builtin)
        .map((candidate) => candidate.model.slug);

    // Prompt-only fal Qwen 3 leads portrait creation; the edit endpoint is not a
    // fake generate option and therefore does not appear in this lane.
    expect(await offeredSlugs("portrait")).toEqual([
      QWEN_3_TEXT,
      QWEN_GENERATE,
      "bytedance/seedream-4.5",
      "bytedance/seedream-5-lite",
      "stability-ai/stable-diffusion-3.5-large",
      "wan-video/wan-2.7-image-pro",
      "aisha-ai-official/nsfw-flux-dev:fb4f086702d6a301ca32c170d926239324a7b7b2f0afc3d232a9c4be382dc3fa",
      "aisha-ai-official/likereality-pony-v1:f777e1c330555044053ad5089fbcee89804e3df2419c1e09d9bbc80a399b01a2",
      "prunaai/p-image",
      QWEN_GENERATE,
      QWEN_GENERATE,
      "stability-ai/stable-diffusion-3.5-large",
    ]);
    // The fal edit endpoint leads scene work and can carry up to three ordered
    // references; the prior instruction editors and curated choices remain.
    expect(await offeredSlugs("scene")).toEqual([
      QWEN_3_EDIT,
      QWEN_EDIT,
      "bytedance/seedream-4.5",
      "bytedance/seedream-5-lite",
      "wan-video/wan-2.7-image-pro",
      "nsfw-api/sdxl-pulid:83bea633f1fbae0729dcfca1c431b01ae2a9e3e39c25b055fed6da2b916822d5",
      "bytedance/seedream-4.5",
      "bytedance/seedream-5-lite",
      "wan-video/wan-2.7-image-pro",
    ]);
    expect(await offeredSlugs("variant")).toEqual([
      QWEN_3_EDIT,
      QWEN_EDIT,
      "bytedance/seedream-4.5",
      "bytedance/seedream-5-lite",
      "wan-video/wan-2.7-image-pro",
      "nsfw-api/sdxl-pulid:83bea633f1fbae0729dcfca1c431b01ae2a9e3e39c25b055fed6da2b916822d5",
    ]);
    // The anchor lanes item and chat_look remain seeded on one model each. Location
    // gained the opt-in Seedream 4.5 "Location 4K" row in 0107 — non-default, so the
    // anchor lane (which stores no pick) still resolves Qwen 2512.
    expect(await offeredSlugs("chat_look")).toEqual([QWEN_EDIT]);
    expect(await offeredSlugs("item")).toEqual([QWEN_GENERATE]);
    expect(await offeredSlugs("location")).toEqual([QWEN_GENERATE, "bytedance/seedream-4.5"]);
  });

  // The 0107 curated rows, row by row. Every one must be present (its model is
  // seeded, so WHERE EXISTS wrote it), enabled, builtin, NON-default, and sorted
  // after every 0100/0104 row — non-default plus tail-sorted is the whole
  // "nothing resolves differently at seed time" claim, because the resolver's
  // model-scoped fallback takes the lowest sort on the stored model.
  it("seeds the seven 0107 curated profiles enabled, non-default, and sorted after the standard set", async () => {
    const sink = new DiagnosticCollector();
    const profiles = await loadImageModelProfiles(sink);
    const models = await db().select({ id: imageModels.id, slug: imageModels.slug }).from(imageModels);
    const slugById = new Map(models.map((model) => [model.id, model.slug]));

    for (const expected of CURATED_PROFILES) {
      const profile = profiles.find((candidate) => candidate.id === expected.id);
      expect(profile, `curated profile ${expected.id} must be seeded and parseable`).toBeDefined();
      if (!profile) continue;
      expect(slugById.get(profile.imageModelId)).toBe(expected.slug);
      expect(profile.key).toBe(expected.key);
      expect(profile.task).toBe(expected.task);
      expect(profile.sort).toBe(expected.sort);
      expect(profile.sort).toBeGreaterThan(PRE_CURATED_MAX_SORT);
      expect(profile.enabled).toBe(true);
      expect(profile.isDefault).toBe(false);
      expect(profile.builtin).toBe(true);
    }
    expect(sink.items.filter((d) => d.code === "image_profile.row_invalid")).toEqual([]);
  });

  // The curated control defaults, plus the Qwen 3 trial-cost ruling. The fal
  // portrait/variant/scene profiles all start at 1K; 2K remains selectable in the
  // Admin Image Generator through the model's resolutionTier capability.
  it("carries the curated control defaults and the fal Qwen 3 1K production defaults", async () => {
    const profiles = await loadImageModelProfiles();
    const byId = new Map(profiles.map((profile) => [profile.id, profile]));

    expect(byId.get("imgprfqwen3portraitaaaaaa")?.controlDefaults).toMatchObject({ resolution: "1K" });
    expect(byId.get("imgprfqwen3provariantaaaa")?.controlDefaults).toMatchObject({ resolution: "1K" });
    expect(byId.get("imgprfqwen3prosceneaaaaaa")?.controlDefaults).toMatchObject({ resolution: "1K" });
    expect(byId.get("imgprf2512portfastaaaaaa")?.controlDefaults).toMatchObject({ steps: 28 });
    expect(byId.get("imgprf2512portqualityaaa")?.controlDefaults).toMatchObject({ steps: 50 });
    expect(byId.get("imgprf2512portqualityaaa")?.providerOverrides).toEqual({ go_fast: false });
    expect(byId.get("imgprfs45ensemble2kaaaaa")?.controlDefaults).toMatchObject({ resolution: "2K" });
    expect(byId.get("imgprfs45ensemble2kaaaaa")?.referencePolicy).toMatchObject({
      allowedRoles: ["identity", "location", "style", "object"],
      requiredRoles: [],
      roleOrder: ["identity", "location", "style", "object"],
      maxPerRole: { identity: 4, location: 1, style: 1, object: 2 },
    });
    expect(byId.get("imgprfs45location4kaaaaa")?.controlDefaults).toMatchObject({ resolution: "4K" });
    expect(byId.get("imgprfs5lscene3kaaaaaaaa")?.controlDefaults).toMatchObject({ resolution: "3K" });
    expect(byId.get("imgprfsd35highguidanceaa")?.controlDefaults).toMatchObject({ guidance: 8 });
    expect(byId.get("imgprfsd35highguidanceaa")?.controlDefaults.negativePrompt).toBeTruthy();
    expect(byId.get("imgprfwan27multiedit2kaa")?.controlDefaults).toMatchObject({ resolution: "2K" });
  });

  it("still honors a stored legacy model slug, resolving to that model's own profile", async () => {
    const sink = new DiagnosticCollector();
    const resolved = await resolveImageProfileForTask("scene", "bytedance/seedream-4.5", sink);

    expect(resolved?.model.slug).toBe("bytedance/seedream-4.5");
    expect(resolved?.profile.id).toBe("imgprfs45sceneaaaaaaaaaa");
    // fal Qwen Image 3 edit carries the global scene default, so a stored Seedream
    // pick lands on a NON-default profile without a degradation warning.
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

    expect(resolved?.model.slug).toBe(QWEN_3_EDIT);
    expect(resolved?.profile.id).toBe("imgprfqwen3prosceneaaaaaa");
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
    expect(resolved?.model.slug).toBe(QWEN_3_EDIT);
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

// The PATCH lockout decision table: configuration validity gates only the
// ENABLED merged row. A profile whose stored config went invalid (here: an
// edit-operation row on a model that cannot edit) must still be disableable
// and editable WHILE disabled — that is what makes activation's "disable that
// profile and retry" possible, and what unblocks a seeded row whose override
// cannot validate on an unprobed deploy. Enabling it, or breaking an enabled
// row, refuses exactly as before.
const BROKEN_PROFILE_ID = "imgprffixturebrokenaaaaa";
const VALID_PROFILE_ID = "imgprffixturevalidaaaaaa";

describe.skipIf(!ready)("updateImageModelProfile enabled-gated validation", () => {
  beforeAll(async () => {
    // Direct inserts on purpose: the broken row models a config that WENT
    // invalid after save (a version move, an unprobed deploy) — the create
    // path would rightly refuse it today. The fixture model cannot edit, so
    // the edit-operation row is `operation_unsupported`.
    await db()
      .insert(imageModelProfiles)
      .values([
        {
          id: BROKEN_PROFILE_ID,
          imageModelId: FIXTURE_MODEL_ID,
          key: "fixture-broken-edit",
          label: "Broken Edit",
          task: "text_repair",
          operation: "edit",
          promptStrategy: "instruction_edit",
          enabled: true,
          isDefault: false,
          sort: 901,
        },
        {
          id: VALID_PROFILE_ID,
          imageModelId: FIXTURE_MODEL_ID,
          key: "fixture-valid-generate",
          label: "Valid Generate",
          task: "text_repair",
          operation: "generate",
          promptStrategy: "text_to_image_description",
          enabled: true,
          isDefault: false,
          sort: 902,
        },
      ]);
  });

  afterAll(async () => {
    // Removed HERE, not in the suite afterAll: the resilience describe below
    // asserts exactly which text_repair rows exist.
    await db()
      .delete(imageModelProfiles)
      .where(inArray(imageModelProfiles.id, [BROKEN_PROFILE_ID, VALID_PROFILE_ID]));
  });

  it("disables an invalid row (disable-while-invalid succeeds)", async () => {
    const result = await updateImageModelProfile(FIXTURE_MODEL_ID, BROKEN_PROFILE_ID, { enabled: false });
    if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`);
    // The returned row is the merged row the update wrote — no re-read.
    expect(result.profile.enabled).toBe(false);
    expect(result.profile.label).toBe("Broken Edit");
  });

  it("edits a disabled invalid row (rename-while-disabled succeeds)", async () => {
    const result = await updateImageModelProfile(FIXTURE_MODEL_ID, BROKEN_PROFILE_ID, {
      label: "Broken Edit (parked)",
    });
    if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`);
    expect(result.profile.label).toBe("Broken Edit (parked)");
    expect(result.profile.enabled).toBe(false);
  });

  it("refuses to ENABLE an invalid row (enable-while-invalid is a 400)", async () => {
    const result = await updateImageModelProfile(FIXTURE_MODEL_ID, BROKEN_PROFILE_ID, { enabled: true });
    expect(result).toMatchObject({ ok: false, code: "invalid" });
    // And the refusal really did keep the row disabled.
    const rows = await db()
      .select({ enabled: imageModelProfiles.enabled })
      .from(imageModelProfiles)
      .where(eq(imageModelProfiles.id, BROKEN_PROFILE_ID));
    expect(rows[0]?.enabled).toBe(false);
  });

  it("validates an edit while the merged row stays enabled", async () => {
    // Breaking a healthy ENABLED row refuses…
    const broken = await updateImageModelProfile(FIXTURE_MODEL_ID, VALID_PROFILE_ID, { operation: "edit" });
    expect(broken).toMatchObject({ ok: false, code: "invalid" });
    // …and a benign edit passes the same validation and lands.
    const renamed = await updateImageModelProfile(FIXTURE_MODEL_ID, VALID_PROFILE_ID, { label: "Valid Renamed" });
    if (!renamed.ok) throw new Error(`expected success, got ${renamed.code}: ${renamed.message}`);
    expect(renamed.profile.label).toBe("Valid Renamed");
    expect(renamed.profile.enabled).toBe(true);
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
