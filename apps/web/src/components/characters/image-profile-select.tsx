"use client";

import type { ImageProfileOption } from "@/lib/client/api";
import { Select } from "@/components/ui/select";

/**
 * The shared profile picker (image-model-capabilities.spec.md §"Caller
 * migration" Slice D) — the successor to the registry model picker. Every
 * surface that chooses how an image is made — the portrait studio's two
 * sections, the chat scene strip, the scenario modal — renders this, so they
 * agree on what an empty list and a still-loading list look like.
 *
 * The value is a PROFILE id; `""` means "whatever this task's default is",
 * which is what the server resolves when no id is sent. The stored fields the
 * value lands in (`modelId`, `sceneModel`) are unchanged and may still hold
 * legacy MODEL ids — the resolver's step 2 keeps those working — so the picker
 * maps a legacy value onto that model's profile for display rather than
 * silently showing the first option (see {@link displayedProfileId}).
 *
 * When several profiles use the same model they group under its label
 * (§"Admin UI": "group them under the model label"), and a selected profile's
 * operator warning renders beneath the control — visible BEFORE use, never
 * blocking (the Wan moderation caveat is the first occupant).
 */
export function ImageProfileSelect({
  id,
  profiles,
  value,
  onChange,
  disabled,
  title,
  className = "",
  emptyHint = "No image profile is offered for this.",
}: {
  id?: string;
  /** Null while loading — the picker shows a single placeholder and stays usable. */
  profiles: ImageProfileOption[] | null;
  value: string;
  onChange: (profileId: string) => void;
  disabled?: boolean;
  title?: string;
  className?: string;
  emptyHint?: string;
}) {
  if (profiles !== null && profiles.length === 0) {
    return <p className="text-xs text-paper-500">{emptyHint}</p>;
  }

  const displayed = displayedProfileId(value, profiles);
  const selected = profiles?.find((profile) => profile.id === (displayed || profiles[0]?.id));

  // Group under each model's label, preserving the offered (sort) order.
  const groups: { modelLabel: string; entries: ImageProfileOption[] }[] = [];
  for (const profile of profiles ?? []) {
    const group = groups.find((candidate) => candidate.modelLabel === profile.modelLabel);
    if (group) group.entries.push(profile);
    else groups.push({ modelLabel: profile.modelLabel, entries: [profile] });
  }

  return (
    <div className="flex min-w-0 flex-col gap-1">
      <Select
        id={id}
        value={displayed}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        title={title}
        className={className}
        aria-label="Image profile"
      >
        {profiles === null ? (
          <option value="">Loading profiles…</option>
        ) : (
          groups.map((group) => (
            <optgroup key={group.modelLabel} label={group.modelLabel}>
              {group.entries.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.label}
                </option>
              ))}
            </optgroup>
          ))
        )}
      </Select>
      {selected?.operatorWarning ? (
        <p className="text-[11px] text-paper-500" title={selected.operatorWarning}>
          {selected.operatorWarning}
        </p>
      ) : null}
    </div>
  );
}

/**
 * What the control SHOWS for a stored value: the profile itself when the value
 * names one, or — for a legacy stored MODEL id — that model's default-then-first
 * offered profile, mirroring the resolver's step 2 so the picker displays what
 * the server will actually run. Anything else falls back to `""` (the browser
 * shows the first option, and {@link pickedProfileId} sends it).
 */
function displayedProfileId(value: string, profiles: ImageProfileOption[] | null): string {
  if (!value || !profiles) return value;
  if (profiles.some((profile) => profile.id === value)) return value;
  const onModel = profiles.filter((profile) => profile.modelId === value);
  const preferred = onModel.find((profile) => profile.isDefault) ?? onModel[0];
  return preferred?.id ?? "";
}

/**
 * Resolve what to send the server: the explicit pick (a profile id, or a legacy
 * stored model id — the resolver accepts both), else the first offered profile,
 * else nothing (the server falls back to the task default). Sending the first
 * profile rather than `""` keeps the request honest about what the user is
 * looking at in the dropdown.
 */
export function pickedProfileId(value: string, profiles: ImageProfileOption[] | null): string | undefined {
  if (value) return value;
  return profiles?.[0]?.id;
}
