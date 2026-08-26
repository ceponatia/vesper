/**
 * `@vesper/contracts` — the shared foundation.
 *
 * Four primitive groups, and deliberately nothing else: the diagnostic contract
 * every workspace reports degradation through, the defensive parser a trust
 * boundary reads untrusted data with, and the two DETERMINISM primitives more
 * than one workspace has to reproduce bit for bit — the FNV-1a string hash and
 * the fixed-point integration kernel. A reader should be able to finish this
 * file and know the complete shared foundation.
 *
 * The determinism pair joined when the simulation domain became
 * `@vesper/simulation-core`: both were application files that the new package
 * and the application now share, and a shared determinism seam must have
 * exactly one implementation. The owner is always the LOWEST workspace every
 * consumer can reach, which is this one — putting either in a lane package
 * would make the other lane import it by that lane's name. The application
 * keeps `@/lib/hash` and `@/lib/fixed-point` as re-export barrels over them,
 * exactly as it does for `@/lib/parse`.
 *
 * This is NOT the new home for `src/contracts/` at large — attributes, meters,
 * body locations, species, facts and the rest are Vesper's game vocabulary and
 * stay in the application. The rule of thumb: if a primitive can describe a
 * chat, a character or the simulation, it belongs to the app; if it is generic
 * infrastructure for the boundary between workspaces, it may belong here.
 * Convenience alone is never a reason to move something in.
 *
 * **This list is the package's entire public API, and it is deliberately
 * explicit.** `export *` in a package root barrel would publish helpers without
 * showing them in any diff, and `pnpm lint:package-boundaries` fails the build
 * if one appears.
 */

export { DiagnosticCollector, diag, diagnosticSchema, diagnosticSeveritySchema, teeSink } from "./diagnostics";
export type { Diagnostic, DiagnosticSeverity, DiagnosticSink } from "./diagnostics";
export { parseOr, parseOrNull } from "./parse";
export { fnv1a32, fnv1aHex } from "./hash";
export {
  FIXED_POINT_ONE,
  EXP2_SCALE,
  exp2NegativeFixedPoint,
  clampFixedPoint,
  addClamped,
  scaleFixedPoint,
  linearDriftStep,
  proportionalDecayStep,
} from "./fixed-point";
