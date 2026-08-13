/**
 * The application's entry point for the shared fixed-point integration kernel.
 *
 * The implementation lives in `@vesper/contracts` because
 * `@vesper/simulation-core` integrates its meters through the same kernel, and
 * the chat lane must not reach it by the successor's package name
 * (`packages/contracts/src/fixed-point.ts` carries the full rationale). This
 * file stays because it is a genuine application-facing API — the garment
 * gradients, the affordance unit algebra and the body-surface contracts all
 * import it; it is a re-export barrel and holds no implementation.
 */

export {
  FIXED_POINT_ONE,
  EXP2_SCALE,
  exp2NegativeFixedPoint,
  clampFixedPoint,
  addClamped,
  scaleFixedPoint,
  linearDriftStep,
  proportionalDecayStep,
} from "@vesper/contracts";
