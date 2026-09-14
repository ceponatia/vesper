/**
 * The one dismissal decision every confirmation shares: Cancel, Escape, and a
 * backdrop click must never end a confirmation while its operation (`busy`)
 * is still running. Without this guard a still-running deletion can look
 * cancelled onscreen while the request that will finish it keeps going.
 */
export function confirmDialogDismissal(args: { busy: boolean }): boolean {
  return !args.busy;
}
