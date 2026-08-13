/**
 * The application's entry point for the one string hash — 32-bit FNV-1a.
 *
 * The implementation lives in `@vesper/contracts` because the simulation
 * package hashes through the same function and a determinism seam may have only
 * one implementation (`packages/contracts/src/hash.ts` carries the full
 * rationale and the "the algorithm can never change" warning). This file stays
 * because it is a genuine application-facing API that the image cache keys and
 * the character forge already import; it is a re-export barrel and holds no
 * implementation.
 */

export { fnv1a32, fnv1aHex } from "@vesper/contracts";
