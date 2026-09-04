import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { imageLoraSchema, imageModelSchema } from "@vesper/image-core";
import { endTestPool, probeIntegrationDb } from "@/server/test-support";
import { db, imageLoras, imageModels } from "../db";

/**
 * Migrations 0118 and 0127 are the deployed-data half of Qwen 2511 runtime LoRA
 * support.
 *
 * The Image Generator deliberately renders its controls from the registered
 * model's probed capability record. Merely composing `loraFeature()` in the
 * family adapter therefore cannot make the picker appear on an already-deployed
 * 2511 row whose snapshot predates LoRA binding derivation. This test holds the
 * migrated database to the two facts the page needs: the 2511 row has the real
 * provider bindings, and the built-in anatomy LoRA allows that base slug and
 * nothing else — a surviving slug for an endpoint no adapter, dialect or pack
 * binding names any more would offer an operator a pairing every render refuses.
 */
const ready = await probeIntegrationDb("images qwen-2511-lora.int.test", "image_models");

const QWEN_2511 = "qwen/qwen-image-edit-2511";
const NSFW_LORA_ID = "imglorqwennsfwallinclv20";

describe.skipIf(!ready)("Qwen Image Edit 2511 LoRA capability migration", () => {
  it("makes the 2511 row LoRA-bound and the built-in anatomy LoRA compatible", async () => {
    const [modelRow] = await db().select().from(imageModels).where(eq(imageModels.slug, QWEN_2511)).limit(1);
    expect(modelRow).toBeDefined();
    const model = imageModelSchema.parse(modelRow);

    expect(model.advancedCapabilities.controls.loraWeights).toEqual({
      field: "lora_weights",
      type: "string",
    });
    expect(model.advancedCapabilities.controls.loraScale).toEqual({
      field: "lora_scale",
      type: "number",
      minimum: 0,
      maximum: 4,
    });
    expect(model.advancedCapabilities.knownInputFields).toContain("lora_weights");
    expect(model.advancedCapabilities.knownInputFields).toContain("lora_scale");

    const [loraRow] = await db().select().from(imageLoras).where(eq(imageLoras.id, NSFW_LORA_ID)).limit(1);
    expect(loraRow).toBeDefined();
    const lora = imageLoraSchema.parse(loraRow);
    expect(lora.compatibleModelSlugs).toEqual([QWEN_2511]);
  });
});

afterAll(async () => {
  await endTestPool();
});
