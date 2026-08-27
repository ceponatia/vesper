/**
 * Run `work` over `items` in sequential batches of `size`: the items inside a
 * batch run in parallel, and the next batch starts only once the previous one
 * has settled. A rejection is swallowed — one failure never aborts the rest, it
 * just isn't counted. Returns how many items completed.
 *
 * The bounded-concurrency loop behind the image lanes' batch buttons, written
 * twice byte-for-byte before this. Each caller keeps its own batch size; a size
 * below 1 degrades to one at a time rather than looping forever.
 */
export async function runInBatches<T>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<unknown>,
): Promise<number> {
  const step = size >= 1 ? Math.floor(size) : 1;
  let done = 0;
  for (let i = 0; i < items.length; i += step) {
    await Promise.all(
      items.slice(i, i + step).map((item) =>
        work(item)
          .then(() => {
            done += 1;
          })
          .catch(() => undefined),
      ),
    );
  }
  return done;
}
