/**
 * The single lifecycle callback registry, installed by images/index.ts.
 * Asset deletion and scheduled maintenance consume these live slots without
 * importing the identity-pack or reference-view implementations, which depend
 * on asset deletion themselves. Leaves never import the public aggregate.
 *
 * Both implementations contain their own failures: maintenance must not fail
 * a delete or the render that kicked a sweep. Sweep counters join the job row.
 */
export interface IdentityPackMaintenanceHooks {
  /**
   * Images whose derived state is no longer valid, at the two moments that can
   * be observed from here: rows `purgeImagesWhere` is ABOUT to delete (the last
   * instant a pack can still be matched by its source id — see that function),
   * and ids whose entity pointers were just nulled while the row itself
   * survived (a kind-guarded delete skipped it).
   */
  invalidateForImages(imageIds: readonly string[]): Promise<void>;
  /** Consistency findings + bounded revision cleanup, run inside the scheduled sweep. */
  sweep(now: Date): Promise<Record<string, number>>;
}

export let identityPackMaintenance: IdentityPackMaintenanceHooks | null = null;

/** Called once, from the folder barrel (`./index.ts`). `null` restores the no-op (tests). */
export function registerIdentityPackMaintenance(hooks: IdentityPackMaintenanceHooks | null): void {
  identityPackMaintenance = hooks;
}

/**
 * The reference-view set's half of the same arrangement, and registered the same
 * way for the same reason: the reference-view service uses asset-deletion,
 * while scheduled maintenance must invoke the service without a reverse import.
 *
 * One hook only. A view is never a pack's source and never an entity pointer, so
 * there is nothing for a delete to invalidate — the read-time projection already
 * refuses a row whose asset went null. What it does own is retention: a
 * superseded view's bytes have no future consumer, and nothing else would ever
 * collect them.
 */
export interface ReferenceViewMaintenanceHooks {
  /** Bounded retention cleanup of retired views' assets, run inside the scheduled sweep. */
  sweep(now: Date): Promise<Record<string, number>>;
}

export let referenceViewMaintenance: ReferenceViewMaintenanceHooks | null = null;

/** Called once, from the folder barrel (`./index.ts`). `null` restores the no-op (tests). */
export function registerReferenceViewMaintenance(hooks: ReferenceViewMaintenanceHooks | null): void {
  referenceViewMaintenance = hooks;
}
