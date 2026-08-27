/**
 * Stick-to-bottom scroll math shared by the streaming transcript surfaces (the
 * session feed and the chat conversation). Pure: components feed in
 * measurements and apply the returned scrollTop.
 *
 * The pin model: while the reader is at (or within slack of) the bottom, new
 * content keeps the view pinned there; scrolling up releases the pin so
 * rereading is never yanked. A history PREPEND ("Load earlier") must instead
 * keep the viewport on the same rows — the caller snapshots an anchor before
 * prepending and restores with `prependRestoreTop` afterwards, and the pin
 * must NOT fire on that growth.
 */

export interface ScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

/** True while the reader counts as "at the bottom" — the auto-follow state. */
export function isPinnedToBottom(m: ScrollMetrics, slackPx: number): boolean {
  return m.scrollHeight - m.scrollTop - m.clientHeight <= slackPx;
}

/** Snapshot taken immediately before a history prepend mutates the DOM. */
export interface PrependAnchor {
  height: number;
  top: number;
}

/** The scrollTop that keeps the viewport on the same rows after a prepend. */
export function prependRestoreTop(anchor: PrependAnchor, newScrollHeight: number): number {
  return newScrollHeight - anchor.height + anchor.top;
}
