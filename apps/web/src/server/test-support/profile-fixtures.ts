import type { AttributeValue } from "@/contracts/attributes";
import type { ChatDrive } from "@/contracts/personality/drives";
import { emptyCharacterProfile, type CharacterProfile } from "@/contracts/world/profile";

/**
 * Character-profile builders for the pure prompt/state unit tests.
 *
 * Six suites each defined their own `profile(overrides)` — the identical
 * `{ ...emptyCharacterProfile(), ...overrides }` — and three defined the same
 * `attr()` helper, one of them casting a bare string into the attribute id type
 * because it did not use the contract's own template-literal id.
 *
 * `maraProfile` is the seeded character the prompt suites assert against: her
 * bio/personality/voice strings and her five attributes appear in dozens of
 * `toContain` expectations, so the VALUES here are load-bearing and must not be
 * "improved".
 */

/** `emptyCharacterProfile()` with the given fields replaced. */
export function makeProfile(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  return { ...emptyCharacterProfile(), ...overrides };
}

/**
 * One attribute value. `id` is the contract's `<category>.<snake_case>` template
 * type, so a typo is a compile error rather than a silently-ignored attribute.
 */
export function attr(
  id: AttributeValue["id"],
  value: AttributeValue["value"],
  source: AttributeValue["source"] = "creation",
): AttributeValue {
  return { id, value, source };
}

/**
 * The seeded prompt-test character: a harbor-town glassblower, 29, with the five
 * attributes the identity/voice/appearance blocks are asserted against. Note
 * `age: "29"` alongside `identity.apparent_age: "late twenties"` — the pair
 * proves the identity block renders the real age and never the apparent one.
 */
export function maraProfile(overrides: Partial<CharacterProfile> = {}): CharacterProfile {
  return makeProfile({
    bio: "A harbor-town glassblower with salt in her hair.",
    personality: "Wry, guarded, fiercely loyal once you earn it.",
    voice: "Low and dry, with a coastal lilt.",
    age: "29",
    attributes: [
      attr("identity.apparent_age", "late twenties"),
      attr("identity.gender", "female"),
      attr("hair.color", "auburn"),
      attr("voice.pitch", "low"),
      attr("voice.cadence", "measured"),
    ],
    ...overrides,
  });
}

/**
 * One runtime chat drive. Defaults to the open, unrevealed, unresolved want the
 * initiative tests use; override `secrecy: "secret"` for the withheld case.
 */
export function drive(overrides: Partial<ChatDrive> = {}): ChatDrive {
  return {
    want: "to reopen the gallery",
    why: "",
    secrecy: "open",
    progress: "",
    revealed: false,
    resolved: false,
    ...overrides,
  };
}
