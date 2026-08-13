/**
 * Assertions for the prompt builders — the ones that stop a prompt edit from
 * breaking a test for the wrong reason.
 *
 * Three brittleness patterns this replaces:
 *
 * 1. A run of `expect(prompt).toContain(x)` fails on the FIRST miss, so a prompt
 *    refactor that dropped three blocks is discovered three runs later.
 *    `expectSections` reports every miss at once.
 * 2. Section ORDER was asserted as raw `indexOf(a) > indexOf(b)` pairs whose
 *    failure message is `expected 412 to be greater than 980` — two numbers with
 *    no names. `expectOrder` names the offending pair.
 * 3. `expect(prefix).toContain("16. When Theo's message carries attached
 *    photos")` pins a RULE ORDINAL. That exact assertion already broke once when
 *    a duplicate rule folded away and every later rule renumbered (17 → 16); the
 *    comment recording the fix is still in the file. `expectNumberedRule` matches
 *    the rule's text at whatever number it currently holds.
 *
 * Plus one home for the untrusted-fence nonce. Production keeps `FENCE_TOKEN`
 * MODULE-PRIVATE in `src/server/engine/prompts/untrusted.ts` (only the composed
 * `UNTRUSTED_DATA_NOTICE` is exported), so there is no constant to assert
 * against; suites split into two camps — a `/vsp-untrusted-[0-9a-f]+:/` shape
 * match and a hardcoded `vsp-untrusted-7f3a9c2e` literal. The shape match is the
 * right one (rotating the nonce is a security action, not a test break), and it
 * lives here.
 */

/** The fence marker shape: the stable prefix plus whatever hex nonce is current. */
export const UNTRUSTED_FENCE_RE = /vsp-untrusted-[0-9a-f]+:/;

/** The nonce pattern without the trailing colon, for composing marker regexes. */
const FENCE_TOKEN_SOURCE = String.raw`vsp-untrusted-[0-9a-f]+`;

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

/** A stateless clone: a caller's `/g/` regex would otherwise carry `lastIndex` between calls. */
function stateless(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replace(/[gy]/gu, ""));
}

function describeNeedle(needle: string | RegExp): string {
  return typeof needle === "string" ? JSON.stringify(needle) : String(needle);
}

function present(text: string, needle: string | RegExp): boolean {
  return typeof needle === "string" ? text.includes(needle) : stateless(needle).test(text);
}

/**
 * Assert every needle appears somewhere in the prompt, reporting ALL misses in
 * one message. Strings are substring matches; regexes are tested statelessly.
 */
export function expectSections(text: string, needles: readonly (string | RegExp)[]): void {
  const missing = needles.filter((needle) => !present(text, needle));
  if (missing.length === 0) return;
  throw new Error(
    `prompt is missing ${missing.length} of ${needles.length} expected section(s):\n` +
      missing.map((needle) => `  - ${describeNeedle(needle)}`).join("\n"),
  );
}

/**
 * Assert the needles appear in this relative order — the prompt-cache layout
 * rule (stable rules in the cached prefix, per-turn volatile blocks below).
 * Reports the first out-of-order PAIR by name, and any absent needle first,
 * because "missing" and "misordered" have different fixes.
 */
export function expectOrder(text: string, needles: readonly string[]): void {
  const positions = needles.map((needle) => ({ needle, index: text.indexOf(needle) }));
  const missing = positions.filter((entry) => entry.index < 0);
  if (missing.length > 0) {
    throw new Error(
      `prompt order cannot be checked — ${missing.length} needle(s) never appear:\n` +
        missing.map((entry) => `  - ${JSON.stringify(entry.needle)}`).join("\n"),
    );
  }
  for (let index = 1; index < positions.length; index += 1) {
    const before = positions[index - 1];
    const after = positions[index];
    if (!before || !after) continue;
    if (before.index > after.index) {
      throw new Error(
        `prompt section order violated: expected ${JSON.stringify(before.needle)} (found at ${before.index}) ` +
          `to come BEFORE ${JSON.stringify(after.needle)} (found at ${after.index})`,
      );
    }
  }
}

/**
 * Assert a numbered rule with this body exists, at ANY ordinal — `12. <body>`
 * and `16. <body>` both pass. Pin the number only when the number itself is the
 * thing under test.
 */
export function expectNumberedRule(text: string, body: string | RegExp): void {
  const source = typeof body === "string" ? escapeRegExp(body) : body.source;
  const flags = typeof body === "string" ? "u" : stateless(body).flags;
  const rule = new RegExp(String.raw`\d+\.\s+${source}`, flags);
  if (rule.test(text)) return;
  throw new Error(
    `prompt has no numbered rule whose body matches ${describeNeedle(body)} ` +
      `(searched for /\\d+\\. / followed by it — the ordinal is deliberately not pinned)`,
  );
}

/**
 * Assert a span is wrapped in the untrusted-data fences for `label` — BOTH
 * markers, because an unclosed fence is exactly the failure the fences exist to
 * prevent.
 */
export function expectFenced(text: string, label: string): void {
  const escaped = escapeRegExp(label);
  const open = new RegExp(`<<${FENCE_TOKEN_SOURCE}:${escaped}>>`, "u");
  const close = new RegExp(`<</${FENCE_TOKEN_SOURCE}:${escaped}>>`, "u");
  const missing = [
    ...(open.test(text) ? [] : [`opening <<…:${label}>>`]),
    ...(close.test(text) ? [] : [`closing <</…:${label}>>`]),
  ];
  if (missing.length === 0) return;
  throw new Error(`prompt is missing the ${missing.join(" and ")} untrusted fence marker(s) for ${JSON.stringify(label)}`);
}

/**
 * The body of ONE section, for assertions that must not accidentally match text
 * from a neighbouring block ("the recall block does not name the secret" is only
 * meaningful when scoped to the recall block).
 *
 * The section starts just after `heading` and ends at `until`. The default
 * terminator is the next markdown heading (`# …`) or the next blank line
 * followed by a `Title:`-style label — the two shapes these prompts use. Pass an
 * explicit `until` whenever a prompt does something else; guessing is the only
 * part of this helper that can be wrong, so it is overridable.
 */
export function promptSection(text: string, heading: string, until?: string | RegExp): string {
  const start = text.indexOf(heading);
  if (start < 0) throw new Error(`prompt has no section headed ${JSON.stringify(heading)}`);
  const body = text.slice(start + heading.length);
  const terminator =
    until === undefined
      ? /\n(?:#{1,6}\s|\n[A-Z][^\n]{0,80}:\s*\n)/u
      : typeof until === "string"
        ? new RegExp(escapeRegExp(until), "u")
        : stateless(until);
  const end = body.search(terminator);
  return (end < 0 ? body : body.slice(0, end)).trim();
}
