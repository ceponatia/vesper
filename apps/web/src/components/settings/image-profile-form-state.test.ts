import { imageControlDefaultsSchema, type ImageControlDefaults } from "@vesper/image-core";
import { describe, expect, it } from "vitest";
import {
  imageProfileControlDefaults,
  imageProfileControlForm,
  type ImageProfileControlForm,
  type ImageProfileControlNumbers,
} from "./image-profile-form-state";

/**
 * The profile editor's control block, read out and read back.
 *
 * The defect this file kills: `updateImageModelProfile` writes
 * `control_defaults` with `.set(request)` — a whole-column replace — so a
 * control the editor can DISPLAY but cannot EMIT is deleted the moment an admin
 * opens a profile and presses Save without editing anything. `fastMode` was
 * exactly that control, and Qwen Edit's reviewed ruling is now stored in it
 * (migration 0140): the silent outcome was every identity-critical 2511 render
 * falling back to the row's `go_fast: true` provider default, with no drop, no
 * refusal and nothing in the run's record to read.
 *
 * So the claim here is the round trip, over the whole supported field list
 * rather than the one control that broke.
 */

/** The form's numeric fields, parsed the way the component's own save parses them. */
function numbersOf(form: ImageProfileControlForm): ImageProfileControlNumbers {
  const fields: [keyof ImageProfileControlNumbers, string][] = [
    ["guidance", form.guidance],
    ["steps", form.steps],
    ["editStrength", form.editStrength],
    ["width", form.width],
    ["height", form.height],
    ["loraScale", form.loraScale],
  ];
  const numbers: ImageProfileControlNumbers = {};
  for (const [name, field] of fields) {
    if (field.trim() !== "") numbers[name] = Number(field);
  }
  return numbers;
}

/** Open the editor on a stored row and press Save, touching nothing. */
function untouchedSave(stored: ImageControlDefaults): ImageControlDefaults {
  const form = imageProfileControlForm(stored);
  return imageProfileControlDefaults(form, numbersOf(form));
}

/**
 * Which `ImageControlDefaults` members this editor can say, and which it
 * deliberately cannot — checked against the SCHEMA's own key list, so a control
 * added to the contract fails here until somebody decides which list it joins
 * rather than quietly becoming a field an untouched Save deletes.
 */
const EDITABLE = [
  "seedPolicy",
  "guidance",
  "steps",
  "negativePrompt",
  "editStrength",
  "resolution",
  "width",
  "height",
  "fastMode",
  "thinkingMode",
  "lora",
] as const;
const NOT_OFFERED = ["outputCount", "coherentSet"] as const;

describe("the profile editor's control fields", () => {
  it("classifies every control the profile contract declares", () => {
    expect([...EDITABLE, ...NOT_OFFERED].sort()).toEqual(Object.keys(imageControlDefaultsSchema.shape).sort());
  });

  it("offers the accelerated path, which a reviewed ruling is stored in", () => {
    expect(EDITABLE).toContain("fastMode");
  });

  it("returns every editable control unchanged through an untouched save", () => {
    // One row carrying a value for all of them at once: a field dropped on the
    // way out cannot hide behind another field's default.
    const stored: ImageControlDefaults = {
      seedPolicy: "caller",
      guidance: 7,
      steps: 30,
      negativePrompt: "blurry, watermark",
      editStrength: 0.4,
      resolution: "custom",
      width: 832,
      height: 1216,
      fastMode: false,
      thinkingMode: true,
      lora: { id: "imglorasabrinaaaaaaaaaaa", scale: 0.9 },
    };
    expect(untouchedSave(stored)).toEqual(stored);
  });

  it("keeps Qwen Edit's reviewed fast-mode ruling across an untouched save", () => {
    // THE regression. Migration 0140 stores the ruling as this control, and
    // nothing re-applies it at the render boundary any more (#244).
    const stored: ImageControlDefaults = { seedPolicy: "random", fastMode: false };
    expect(untouchedSave(stored).fastMode).toBe(false);
  });

  it("tells an unset control from an explicit false", () => {
    // `fastMode` has three states, not two: the wrappers that expose it default
    // it ON, so "do not accelerate" must travel as a value while "say nothing"
    // stays absent. A checkbox would collapse the two and silently accelerate
    // every render that meant to say nothing.
    expect(imageProfileControlForm({ seedPolicy: "random" }).fastMode).toBe("");
    expect(imageProfileControlForm({ seedPolicy: "random", fastMode: false }).fastMode).toBe("off");
    expect(imageProfileControlForm({ seedPolicy: "random", fastMode: true }).fastMode).toBe("on");
    expect(untouchedSave({ seedPolicy: "random" }).fastMode).toBeUndefined();
    expect(untouchedSave({ seedPolicy: "random", fastMode: true }).fastMode).toBe(true);
  });

  it("round-trips the Pony ruling's empty negative through an untouched save", () => {
    // The second instance of the same defect: `negativePrompt: ""` is a VALUE —
    // it clears the wrapper's hidden `"nsfw, naked"` default — and a form whose
    // blank box meant "unset" dropped it on a Save nobody thought was an edit,
    // with nothing left to re-apply it (#244).
    const stored: ImageControlDefaults = {
      seedPolicy: "random",
      negativePrompt: "",
      resolution: "custom",
      width: 832,
      height: 1216,
    };
    expect(untouchedSave(stored)).toEqual(stored);
  });

  it("tells a deliberate empty negative from an unset one, and both from text", () => {
    expect(imageProfileControlForm({ seedPolicy: "random", negativePrompt: "" }).clearNegativePrompt).toBe(true);
    expect(imageProfileControlForm({ seedPolicy: "random" }).clearNegativePrompt).toBe(false);
    expect(imageProfileControlForm({ seedPolicy: "random", negativePrompt: "blurry" }).clearNegativePrompt).toBe(false);
    expect(untouchedSave({ seedPolicy: "random", negativePrompt: "" }).negativePrompt).toBe("");
    expect(untouchedSave({ seedPolicy: "random" }).negativePrompt).toBeUndefined();
    expect(untouchedSave({ seedPolicy: "random", negativePrompt: "blurry" }).negativePrompt).toBe("blurry");
  });

  it("lets typed text outrank a flag left over from the row the form was seeded from", () => {
    const form = { ...imageProfileControlForm({ seedPolicy: "random", negativePrompt: "" }) };
    form.negativePrompt = "blurry, watermark";
    expect(imageProfileControlDefaults(form, numbersOf(form)).negativePrompt).toBe("blurry, watermark");
  });

  it("unsets the negative when an admin empties the box and unticks the flag", () => {
    const form = { ...imageProfileControlForm({ seedPolicy: "random", negativePrompt: "" }) };
    form.clearNegativePrompt = false;
    expect(imageProfileControlDefaults(form, numbersOf(form))).toEqual({ seedPolicy: "random" });
  });

  it("clears a control whose field an admin blanks", () => {
    // The other half of the contract, and why this is not a blanket spread of
    // the stored row: blanking a field is how an admin REMOVES a default, so a
    // merge that preserved the stored value would make removal impossible.
    const form = { ...imageProfileControlForm({ seedPolicy: "random", guidance: 7, fastMode: false }) };
    form.guidance = "";
    form.fastMode = "";
    const saved = imageProfileControlDefaults(form, numbersOf(form));
    expect(saved).toEqual({ seedPolicy: "random" });
  });
});
