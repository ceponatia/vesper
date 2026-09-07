"use client";

import { Field } from "@/components/ui/field";
import { Select } from "@/components/ui/select";
import type {
  ImageLabControl,
  ImageLabControlledKind,
  ImageLabExperimentKind,
  ImageReferenceRole,
} from "@vesper/image-core";
import type { ImageRecord } from "@/lib/client/api";
import type { AsyncState } from "@/components/hooks/use-async";
import { ImageChoiceGrid, LabRenderPicker } from "../image-lab-pickers";
import { OwnedImagePicker } from "../owned-image-picker";
import { imageLabControlKindLabel, imageLabRoleLabel } from "../image-lab-copy";
import { DEFAULT_MODEL_SLUG, isReviewedFixture } from "./request";

/**
 * The optional third reference each controlled recipe is offered — exactly the
 * roles the recipes allow: [outfit, style, object] on a portrait and
 * [location, outfit, style] on a scene (`imageLabRecipeContentRoles`).
 * `object` joined when the general owned-image picker existed to feed it: the
 * character/scene pickers hold no item imagery, and filing a picture of a
 * person as "an object reference" would have poisoned the record — so the role
 * waited for a source that can honestly supply one.
 */
export const EXTRA_REFERENCE_ROLES = {
  controlled_portrait: ["outfit", "style", "object"],
  controlled_scene: ["location", "outfit", "style"],
} as const satisfies Record<ImageLabControlledKind, readonly ImageReferenceRole[]>;
export type ExtraReferenceRole = (typeof EXTRA_REFERENCE_ROLES)[ImageLabControlledKind][number];

/**
 * Which picker feeds each extra role. A scene's location and style come from
 * the conversation's own scene renders (a previous scene IS a picture of the
 * place, and of the scene lane's look); wardrobe comes from the character's
 * portrait renders in both kinds, because a variant render wearing the outfit
 * is the only wardrobe imagery the lab can reach. An object is the one role no
 * scoped list can supply — an item is not a portrait and not a scene — so it
 * draws from the general owned-image picker.
 */
function extraReferenceSource(
  kind: ImageLabControlledKind,
  role: ExtraReferenceRole,
): "portraits" | "scenes" | "general" {
  if (role === "object") return "general";
  return kind === "controlled_scene" && role !== "outfit" ? "scenes" : "portraits";
}

/** What picking each extra role means — the picker's hint, in the recipe's terms. */
function extraRoleHint(role: ExtraReferenceRole): string {
  switch (role) {
    case "outfit":
      return "Dress the subject in exactly this render's clothing.";
    case "style":
      return "Take this render's palette and finish; no subject from it.";
    case "location":
      return "The place the scene is set — one of this conversation's scene renders.";
    case "object":
      return "An item the render should include beside the subject — any of your stored images can supply it.";
  }
}

/** The scene-sourced pickers' empty states, in the noun the admin actually failed to choose. */
const SCENE_EMPTY_HINTS = {
  unscoped: "Choose a conversation first.",
  none: "This conversation has no finished scene renders yet.",
};

/**
 * Why a render that fed a fixture is barred from every picker on this form —
 * the server's `control_source_sent` refusal, explained before it is spent.
 */
export const FIXTURE_SOURCE_REASON = "source of the selected fixture — sending it invalidates the run";

/** Empty states name the conversation when it owns the identity source. */
function chatPortraitHints(kind: ImageLabExperimentKind, chatId: string) {
  return kind === "controlled_scene"
    ? {
        unscoped:
          chatId === ""
            ? "Choose a conversation first."
            : "This conversation has no primary character whose renders can be offered.",
        none: "This conversation's character has no finished renders yet.",
      }
    : undefined;
}

export function LabIdentityFields({
  isProbe,
  isStaged,
  kind,
  chatId,
  identityCharacterId,
  portraits,
  sourceImageId,
  setSourceImageId,
  fixtureSourceId,
  fixtureSourceShown,
}: {
  isProbe: boolean;
  isStaged: boolean;
  kind: ImageLabExperimentKind;
  chatId: string;
  identityCharacterId: string;
  portraits: AsyncState<ImageRecord[]>;
  sourceImageId: string | null;
  setSourceImageId: (value: string | null) => void;
  fixtureSourceId: string | null;
  fixtureSourceShown: boolean;
}) {
  const chatPortraitEmptyHints = chatPortraitHints(kind, chatId);
  return (
    <div className="flex flex-col gap-2">
      <LabRenderPicker
        label="Identity reference"
        hint={
          isProbe
            ? "The render whose face the output must keep. Optional — a probe may test structure alone."
            : isStaged
              ? "The render whose face this act is performed by. Required — a staged render with no likeness in it is the act happening to a stranger."
              : "The render whose face the output must keep. Required — the controlled recipes refuse to run without one."
        }
        scopeId={identityCharacterId}
        images={portraits}
        value={sourceImageId}
        onChange={setSourceImageId}
        excluded={
          fixtureSourceId === null ? null : { imageId: fixtureSourceId, reason: FIXTURE_SOURCE_REASON }
        }
        emptyHints={chatPortraitEmptyHints}
      />
      {fixtureSourceShown ? (
        <p className="text-xs text-paper-500">
          One render is greyed out because the selected fixture was extracted from it. Sending that render as
          the identity reference would hand the model the answer — the output could match the control by
          copying it, instead of proving the model obeys a control at all.
        </p>
      ) : null}
    </div>
  );
}

export function LabFixtureFields({
  isTwoCharacter,
  controls,
  control,
  controlImageId,
  setControlImageId,
}: {
  isTwoCharacter: boolean;
  controls: ImageLabControl[];
  control: ImageLabControl | null;
  controlImageId: string | null;
  setControlImageId: (value: string | null) => void;
}) {
  const unreviewedCount = controls.filter((entry) => !isReviewedFixture(entry)).length;
  return (
    <>
      <Field
        label={isTwoCharacter ? "Control fixture (optional)" : "Control fixture"}
        hint={
          isTwoCharacter
            ? "Optional here — the two identities are the required references, and a fixture spends the slot after them. Click a chosen tile again to go back to no control. Only a reviewed fixture may be sent."
            : "The structure the output must obey. Required, and only a reviewed fixture may be sent."
        }
      >
        <ImageChoiceGrid
          choices={controls.map((entry) => ({
            imageId: entry.imageId,
            label: imageLabControlKindLabel(entry.meta.controlKind),
            detail: isReviewedFixture(entry) ? "reviewed" : "unreviewed — review it first",
            disabled: !isReviewedFixture(entry),
          }))}
          value={controlImageId}
          // Clicking the chosen tile again clears it — the render picker's own
          // idiom, needed here because one kind's fixture is optional and a
          // picker with no way back to none would hide that arm.
          onChange={(imageId) => setControlImageId(imageId === controlImageId ? null : imageId)}
          fit="contain"
          emptyHint="No fixtures yet — extract or upload one above."
        />
      </Field>
      {isTwoCharacter ? (
        <p className="text-xs text-paper-500">
          {control === null
            ? "No control — the scene is composed from the two identity references alone, which is the arm this kind starts on."
            : `Controlled arm — the ${imageLabControlKindLabel(control.meta.controlKind)} is sent after both identities, and the trial reads it for pose ownership: whose body the structure claimed.`}
        </p>
      ) : null}
      {unreviewedCount > 0 ? (
        <p className="text-xs text-paper-500">
          {unreviewedCount}
          {" fixture(s) above are greyed out because nobody has reviewed them. Look at each one in "}
          {"the fixtures panel and mark it reviewed — a run that comes back “ignores the control” has "}
          {"to rule out a bad fixture before it rules on the model."}
        </p>
      ) : null}
    </>
  );
}

export function LabControlledFields({
  controlledKind,
  chatId,
  identityCharacterId,
  extraRole,
  setExtraRole,
  extraRoleOptions,
  extraImageId,
  setExtraImageId,
  fixtureSourceId,
  portraits,
  scenes,
}: {
  controlledKind: ImageLabControlledKind;
  chatId: string;
  identityCharacterId: string;
  extraRole: ExtraReferenceRole | "";
  setExtraRole: (value: ExtraReferenceRole | "") => void;
  extraRoleOptions: readonly ExtraReferenceRole[];
  extraImageId: string | null;
  setExtraImageId: (value: string | null) => void;
  fixtureSourceId: string | null;
  portraits: AsyncState<ImageRecord[]>;
  scenes: AsyncState<ImageRecord[]>;
}) {
  const chatPortraitEmptyHints = chatPortraitHints(controlledKind, chatId);

  const extraSource: "portraits" | "scenes" | "general" =
    controlledKind !== null && extraRole !== ""
      ? extraReferenceSource(controlledKind, extraRole)
      : "portraits";

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[16rem_1fr]">
        <Field
          label="Extra reference"
          hint="Optional third reference the recipe allows. Pick a role, then its image — or leave it at none."
        >
          {(id) => (
            <Select
              id={id}
              value={extraRole}
              onChange={(e) => setExtraRole(e.target.value as ExtraReferenceRole | "")}
            >
              <option value="">— None —</option>
              {extraRoleOptions.map((role) => (
                <option key={role} value={role}>
                  {imageLabRoleLabel(role)}
                </option>
              ))}
            </Select>
          )}
        </Field>
        {extraRole !== "" ? (
          extraSource === "general" ? (
            // The object role's source is the GENERAL picker: no scoped
            // list holds item imagery, and the recipe already accepts the
            // role — same fixture-source bar as every other slot.
            <OwnedImagePicker
              label={imageLabRoleLabel(extraRole)}
              hint={extraRoleHint(extraRole)}
              value={extraImageId}
              onChange={setExtraImageId}
              excluded={
                fixtureSourceId === null ? null : { imageId: fixtureSourceId, reason: FIXTURE_SOURCE_REASON }
              }
            />
          ) : (
            <LabRenderPicker
              label={imageLabRoleLabel(extraRole)}
              hint={extraRoleHint(extraRole)}
              scopeId={extraSource === "scenes" ? chatId : identityCharacterId}
              images={extraSource === "scenes" ? scenes : portraits}
              value={extraImageId}
              onChange={setExtraImageId}
              excluded={
                fixtureSourceId === null ? null : { imageId: fixtureSourceId, reason: FIXTURE_SOURCE_REASON }
              }
              emptyHints={extraSource === "scenes" ? SCENE_EMPTY_HINTS : chatPortraitEmptyHints}
            />
          )
        ) : null}
      </div>
      <p className="text-xs text-paper-500">
        {`${DEFAULT_MODEL_SLUG} accepts at most 3 reference images, so identity, the control, and one `}
        {"extra fill it exactly. References past a model's capacity are not refused on a controlled "}
        {"run — the plan drops them and records the drop on the result."}
      </p>
    </>
  );
}
