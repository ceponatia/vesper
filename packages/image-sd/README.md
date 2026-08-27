# @vesper/image-sd

The Stable Diffusion implementation layer. Everything here is knowledge about
**operating Stable Diffusion well** — which frozen sampler configuration a render
ran under, what the Vesper-owned renderer accepts, how a character LoRA is
trained and whether its dataset is still the one it was trained on, and what a
comparison between two workflow revisions holds fixed. Nothing here knows that
Vesper has characters, chats, a database, or a Next.js application.

**It is not an alternative to `@vesper/image-core`.** The core stays the
provider-neutral image engine: model capabilities, profiles, reference roles,
normalized render intent, reference ordering, prompt fitting, LoRA control
contracts, render planning and provenance, failure vocabulary. This package sits
above it and adds one family's specifics. A Stable Diffusion profile is an
ordinary image profile, a Stable Diffusion render goes through
`renderImageIntent` like every other, and turning every SD profile off restores
current Vesper behavior with no code change. Stable Diffusion enters Vesper as an
optional model-family capability, never as a second image system.

How the application uses the image system: [docs/images/](../../docs/images/README.md).

## Boundary

**May import:** `@vesper/image-core` and `@vesper/contracts`, each by package
name and each declared in this package's manifest.

**May never import:** the web application (no `@/` at all, and no relative path
that climbs out of this package), Next.js, anything database-shaped, Vesper's
character or chat contracts, ambient environment variables — and
`@vesper/image-replicate`.

That last one is the interesting exclusion, because it is not a layering
mistake, it is a peer. The transport package and this one hold the **same layer
rank** above `@vesper/image-core`, and equal-rank packages never import one
another:

```text
                    @vesper/contracts
                           ▲
                  @vesper/image-core
                    ▲             ▲
          @vesper/image-sd   @vesper/image-replicate
                    ▲             ▲
                    └──────┬──────┘
                       @vesper/web
```

The application is where they meet. This package says what the renderer accepts;
the transport package knows how to reach `api.replicate.com`; the application
holds the credential, resolves the state, and puts the two together. There is
deliberately **no Stable Diffusion API client in here**.

**Universal runtime.** This package is browser/server portable, so its runtime
source evaluates no `process`, `Buffer`, `window` or `document`, imports no Node
built-in, and pulls in no server-only module. Its TypeScript project declares
`"lib": ["ES2022"]` and an empty `types` list, so a file that reached for one of
those would fail to compile before any lint gate saw it. Everything here is pure
data and pure functions: no persistence, no network, no clock, no randomness.

These rules are mechanically enforced, not conventions.
`pnpm lint:package-boundaries` resolves every import and owns the real answer —
dependency direction, declared manifest ownership, exact-name package imports,
root-barrel wildcards, and the universal runtime target — and
`pnpm lint:package-resolution` separately imports the package by name through the
installed workspace. Both run in CI's static-checks job.

## Layout

| Folder             | Owns                                                             |
| ------------------ | ---------------------------------------------------------------- |
| `src/recipes/`     | The SD recipe contract and the seeded, versioned recipes         |
| `src/deployment/`  | The Vesper-owned renderer's public input contract                |
| `src/training/`    | Training recipes, manifests, dataset fingerprinting, curation    |
| `src/evaluation/`  | The comparison fixture contract and the seeded Stage 3 fixtures  |
| `deployment/`      | The reproducible Cog/ComfyUI workflow that is frozen and deployed |

Each `src/` folder has an internal `index.ts` for reading and navigation, and
those may use `export *` — they are reading aids, not publication. The package
has one public code import path, `@vesper/image-sd`, and the **root**
`src/index.ts` lists every public name explicitly. Adding an entry there is a
public-API change and should be read as one; adding an internal helper cannot
publish it by accident.

Two things are worth knowing before reading the code:

- **A recipe is deployed configuration, not a tuning range.** Fixed values, one
  revision at a time. The starting bands ("steps 30–40", "CFG roughly
  4–6") describe the search, which runs in the Advanced Image Lab; the value that
  wins becomes the next revision. Every seeded recipe is a revision 1 trial
  starting point and nothing has graded them yet.
- **A training recipe pins what the LoRA learns, never who trains it.** Rank,
  steps, learning rate, resolution, batch size and the base checkpoint are the
  recipe; which trainer runs it is a provider fact, so the operator script pins
  that and records the pin beside the weights. The two seeded recipes differ in
  rank alone, because that is the comparison Stage 4 exists to make, and a
  registry-derived test fails if they ever differ in anything else.
- **A fixture is the fixed half of a comparison, and the package owns no
  results.** `sdEvaluationFixtures` holds the eight Stage 3 scenes — prompt,
  negative prompt and a required seed each — and deliberately describes nobody:
  identity arrives at run time as a reference image, so a prompt naming an age or
  a hair colour would turn those grades into prompt-following. The images, the
  grades and the verdict belong to the run that produced them
  (`scripts/eval/sd-identity-matrix.ts`, writing into `evidence/`).
- **The renderer's input contract is deliberately small and snake_case.** One
  prediction may internally run identity conditioning, a ControlNet, sampling,
  targeted repair and a finishing pass — from Vesper's side that is one image
  render, with one cost line and one retry. The field names are the vocabulary
  Vesper's existing Replicate capability probe already reads, so the deployment
  registers as an ordinary model row.

## What stays in the application

The web application continues to own everything Vesper-specific about an image:

- resolving a character's current visual state — clothing, location, items, and
  which characters are present in a scene;
- identity-pack lookup and reference-image selection;
- the LoRA library, and the identity-pack-to-LoRA association and its lifecycle;
- image jobs, image assets, gallery and queue behavior;
- authorization, ownership, and all database persistence;
- Replicate credentials and every provider call;
- profile selection, the admin screens, and all UI state.

`@vesper/image-core` continues to own the provider-neutral image engine, and
`@vesper/image-replicate` continues to own Replicate access, probing, file
transport, prediction execution and response normalization.

## Working in here

- No production build artifact is emitted; the package exports TypeScript source
  and is consumed as a workspace dependency. Next transpiles it for the app.
- Package-local checks: `pnpm --filter @vesper/image-sd exec vitest run` and
  `pnpm --filter @vesper/image-sd typecheck`. Root `pnpm test` and
  `pnpm typecheck` reach them by recursing over the workspace, without naming
  this package.
- Resolution runs through pnpm and the package `exports` map, not tool aliases.
  Tests here have no application setup and no `@/` alias, so a broken manifest
  fails loudly instead of being papered over.
- Dependencies this package imports belong in **its** `package.json`, including
  test-only ones. Reachability elsewhere in the pnpm install is not ownership.
- Tests live beside their subject. Each one opens by naming the invariant it
  protects and the bad implementation it kills; Zod's own behavior is never
  tested, only the rules layered on it.
- Validation is CI-gated: GitHub Actions on CodeBuild runners is the gate, per
  the root `CLAUDE.md`. There are no local git hooks and no local gate.
