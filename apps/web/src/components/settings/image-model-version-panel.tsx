"use client";

import { useState } from "react";
import { pinnedImageModelVersion } from "@vesper/image-core";
import {
  adminImageModelsApi,
  imageVersionBlockedBodySchema,
  type ImageModel,
  type ImageModelProfile,
  type ImageVersionProbeResponse,
  type ImageVersionProfileFindings,
  type ImageVersionSmokeResponse,
} from "@/lib/client/api";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { Tag } from "@/components/ui/tag";
import { useToast } from "@/components/ui/toast";

/**
 * The candidate-version corner of one model card (image-model-capabilities.spec.md
 * §"Version candidate and promotion flow", §"Admin UI"): what version the row
 * is on, what latest looks like, and the three actions between them.
 *
 * The order is the safe promotion ladder and the panel keeps it visible:
 * **Check latest** (read-only, one schema probe) shows the capability diff and
 * per-profile findings; **Smoke test** (explicitly cost-bearing — a real
 * prediction is spent, nothing persists) proves the candidate renders through a
 * chosen profile; **Activate** atomically pins the row — and a 409 renders the
 * blocking findings the route sends beside its error, instead of asking the
 * operator to re-probe and guess.
 */

/** `version` truncated the way an operator compares shas: enough head to match. */
function shortVersion(versionId: string): string {
  return versionId.length > 14 ? `${versionId.slice(0, 14)}…` : versionId;
}

/** One diff value rendered inline; unknown is honest about non-JSON values. */
function diffValue(value: unknown): string {
  const text = JSON.stringify(value);
  return text === undefined ? "—" : text;
}

/** The per-profile findings list, shared by the probe result and the 409 body. */
function FindingsList({ profiles }: { profiles: ImageVersionProfileFindings[] }) {
  const withFindings = profiles.filter((profile) => profile.findings.length > 0);
  if (withFindings.length === 0) {
    return <p className="text-[11px] text-paper-500">Every enabled profile keeps working on this version.</p>;
  }
  return (
    <div className="flex flex-col gap-1">
      {withFindings.map((profile) => (
        <div key={profile.profileId} className="text-[11px]">
          <span className="text-paper-300">{profile.label || profile.key}</span>
          <ul className="mt-0.5 ml-4 list-disc">
            {profile.findings.map((finding, index) => (
              <li key={index} className={finding.level === "blocking" ? "text-danger-300" : "text-paper-400"}>
                {finding.level === "blocking" ? "blocks activation: " : ""}
                {finding.message}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function ImageModelVersionPanel({
  model,
  profiles,
  onChanged,
}: {
  model: ImageModel;
  /** This model's profiles — the smoke test runs through one of them. */
  profiles: ImageModelProfile[];
  /** Silent registry refetch after an activation changed the row. */
  onChanged: () => void;
}) {
  const toast = useToast();
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ImageVersionProbeResponse | null>(null);
  const [smokeProfileId, setSmokeProfileId] = useState("");
  const [smokeOpen, setSmokeOpen] = useState(false);
  const [smoking, setSmoking] = useState(false);
  const [smoke, setSmoke] = useState<ImageVersionSmokeResponse["smoke"] | null>(null);
  const [activateOpen, setActivateOpen] = useState(false);
  const [activating, setActivating] = useState(false);
  const [blocked, setBlocked] = useState<ImageVersionProfileFindings[] | null>(null);

  const pinned = pinnedImageModelVersion(model);
  const isPinnedSlug = model.slug.includes(":");
  const candidateVersion = probe?.candidate.versionId ?? null;
  const enabledProfiles = profiles.filter((profile) => profile.enabled);

  const checkLatest = async () => {
    setProbing(true);
    const result = await adminImageModelsApi.probeLatest(model.id);
    setProbing(false);
    if (!result.ok) {
      toast.push({ title: "Probe failed", description: result.error.message, tone: "error" });
      return;
    }
    setProbe(result.data);
    setSmoke(null);
    setBlocked(null);
    setSmokeProfileId(enabledProfiles[0]?.id ?? "");
  };

  const runSmoke = async () => {
    if (!candidateVersion || !smokeProfileId) return;
    setSmoking(true);
    const result = await adminImageModelsApi.smokeTest(model.id, {
      versionId: candidateVersion,
      profileId: smokeProfileId,
    });
    setSmoking(false);
    setSmokeOpen(false);
    if (!result.ok) {
      toast.push({ title: "Smoke test failed", description: result.error.message, tone: "error" });
      return;
    }
    setSmoke(result.data.smoke);
  };

  const activate = async () => {
    if (!candidateVersion) return;
    setActivating(true);
    const result = await adminImageModelsApi.activateVersion(model.id, { versionId: candidateVersion });
    setActivating(false);
    setActivateOpen(false);
    if (!result.ok) {
      // The 409 carries the blocking findings beside the error envelope —
      // render WHICH profile blocks rather than a bare "blocked".
      const body = imageVersionBlockedBodySchema.safeParse(result.error.body);
      if (result.error.status === 409 && body.success) setBlocked(body.data.profiles);
      toast.push({ title: "Activation refused", description: result.error.message, tone: "error" });
      return;
    }
    setBlocked(null);
    setProbe(null);
    toast.push({ title: `Pinned ${model.label} to ${shortVersion(candidateVersion)}`, tone: "success" });
    onChanged();
  };

  return (
    <div className="mt-3 border-t border-ink-600/60 pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="text-[11px] font-medium tracking-wide text-paper-400 uppercase">Version</h4>
        {pinned ? (
          <Tag tone={isPinnedSlug ? "ok" : "default"} title={pinned}>
            {isPinnedSlug ? "pinned" : "probed"} {shortVersion(pinned)}
          </Tag>
        ) : (
          <Tag title="No version recorded — official models track whatever Replicate publishes">floating latest</Tag>
        )}
        {probe ? (
          probe.latestDiffers ? (
            <Tag tone="danger">latest differs</Tag>
          ) : (
            <Tag tone="ok">up to date</Tag>
          )
        ) : null}
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="quiet"
            busy={probing}
            onClick={() => void checkLatest()}
            title="Read the latest published version's schema and compare — read-only, no render"
          >
            Check latest
          </Button>
        </div>
      </div>

      {probe ? (
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-[11px] text-paper-500">
            {candidateVersion ? (
              <>
                Latest published: <code title={candidateVersion}>{shortVersion(candidateVersion)}</code>
                {probe.activatable ? "" : " — this candidate cannot be activated"}
              </>
            ) : (
              "The provider does not disclose a version id for this model."
            )}
          </p>

          {probe.diff.length > 0 ? (
            <ul className="ml-4 list-disc text-[11px] text-paper-400">
              {probe.diff.map((entry, index) => (
                <li key={index}>
                  <code>{entry.field}</code> {entry.kind}
                  {entry.kind === "changed" ? `: ${diffValue(entry.active)} → ${diffValue(entry.candidate)}` : ""}
                  {entry.ownerOwned ? (
                    <Tag
                      className="ml-1.5"
                      title="The stored value is the owner's judgment — activation reports this drift but never rewrites the field"
                    >
                      owner-curated
                    </Tag>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11px] text-paper-500">No capability differences against the stored probe.</p>
          )}

          <FindingsList profiles={probe.profiles} />

          {candidateVersion ? (
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={smokeProfileId}
                onChange={(e) => setSmokeProfileId(e.target.value)}
                className="h-7 w-48 text-xs"
                aria-label="Smoke-test profile"
              >
                {enabledProfiles.length === 0 ? <option value="">no enabled profile</option> : null}
                {enabledProfiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.label}
                  </option>
                ))}
              </Select>
              <Button
                size="sm"
                variant="quiet"
                disabled={!smokeProfileId}
                onClick={() => setSmokeOpen(true)}
                title="One real render on the candidate version — costs provider money, keeps nothing"
              >
                Smoke test
              </Button>
              <Button
                size="sm"
                variant="quiet"
                disabled={!probe.activatable}
                onClick={() => setActivateOpen(true)}
                title="Pin this model to the candidate version"
              >
                Activate version
              </Button>
            </div>
          ) : null}

          {smoke ? (
            <p className="text-[11px] text-paper-400">
              Smoke test passed in {(smoke.durationMs / 1000).toFixed(1)}s — {String(smoke.imageBytes)} bytes
              {smoke.width && smoke.height ? `, ${String(smoke.width)}×${String(smoke.height)}` : ""}
              {smoke.predictionId ? (
                <>
                  {", prediction "}
                  <code>{smoke.predictionId}</code>
                </>
              ) : null}
            </p>
          ) : null}

          {blocked ? (
            <div className="rounded-card border border-danger-500/40 bg-ink-950/40 p-2">
              <p className="mb-1 text-[11px] text-danger-300">Activation refused — these profiles would break:</p>
              <FindingsList profiles={blocked} />
            </div>
          ) : null}
        </div>
      ) : null}

      <Dialog
        open={smokeOpen}
        onClose={() => {
          if (!smoking) setSmokeOpen(false);
        }}
        title="Run a paid smoke test?"
        footer={
          <>
            <Button onClick={() => setSmokeOpen(false)} disabled={smoking}>
              Cancel
            </Button>
            <Button variant="primary" busy={smoking} onClick={() => void runSmoke()}>
              Spend one render
            </Button>
          </>
        }
      >
        This sends ONE real prediction to the candidate version through{" "}
        {enabledProfiles.find((profile) => profile.id === smokeProfileId)?.label ?? "the selected profile"} — it spends
        provider money, and nothing is kept: the image is measured and dropped.
      </Dialog>

      <Dialog
        open={activateOpen}
        onClose={() => {
          if (!activating) setActivateOpen(false);
        }}
        title={`Pin ${model.label} to the candidate?`}
        footer={
          <>
            <Button onClick={() => setActivateOpen(false)} disabled={activating}>
              Cancel
            </Button>
            <Button variant="primary" busy={activating} onClick={() => void activate()}>
              Activate
            </Button>
          </>
        }
      >
        Every future render on this model runs the candidate version, and the slug is pinned to it. Activation re-probes
        the exact version first and refuses if any enabled profile would stop being runnable.
      </Dialog>
    </div>
  );
}
