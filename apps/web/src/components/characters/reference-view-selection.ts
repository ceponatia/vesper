interface ReferenceViewQueueTarget {
  readonly angle: string;
  readonly wardrobe: string;
  readonly state: "queued" | "busy" | "budget" | "storage";
}

const keyOf = (target: Pick<ReferenceViewQueueTarget, "angle" | "wardrobe">) =>
  `${target.angle} ${target.wardrobe}`;

/** Submitted or already-running work no longer belongs in the next selection. */
export function settledReferenceViewSelectionKeys(targets: readonly ReferenceViewQueueTarget[]): ReadonlySet<string> {
  return new Set(targets
    .filter((target) => target.state === "queued" || target.state === "busy")
    .map(keyOf));
}
