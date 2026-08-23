# Deployment workflow

This directory holds the reproducible workflow that becomes Vesper's own Stable
Diffusion Replicate model — conceptually `vesper/sdxl-character-render`. It is
empty today: Stage 1 creates the package and its contracts, and Stage 2 fills
this directory with the actual workflow. See §3 and §5 of
[sd-rendering-package.plan.md](../../../docs/developer-notes/sd-rendering-package.plan.md).

Do not confuse it with `src/deployment/`. That folder holds the renderer's
**input contract** — the TypeScript schema Vesper builds requests against, which
ships as part of the package's public API. This folder holds the **renderer
itself**: the Cog definition and the ComfyUI graph that implement what that
contract promises. One is what callers see, the other is what runs.

The workflow is prototyped in ComfyUI, because that is the fastest way to try a
sampler change or a new ControlNet against a fixture. But **production must never
depend on arbitrary workflow JSON.** A graph that is edited in a browser and
executed as data has no version, no review, and no way to answer "what produced
this image" six months later — and a node quietly upgraded underneath it changes
every render with nothing in any diff. So once a recipe is validated, the graph
is frozen into a versioned Vesper-owned Cog/Replicate deployment, and Vesper
selects behavior by naming a recipe id rather than by sending a workflow.

That freeze is what lets the rest of the system stay ordinary. The deployment
registers as a normal `image_models` row, its published input schema is read by
the existing capability probe, and its profiles appear in the existing pickers.
Everything complicated — identity conditioning, ControlNet, sampling, targeted
repair, the low-denoise finishing pass — happens inside one prediction, so from
Vesper's side it was a single image render with a single cost line and a single
retry.

Whatever lands here is expected to be buildable and deployable from a clean
checkout, and to name the exact checkpoint, adapter and node versions it was
frozen with. A workflow nobody can rebuild is a workflow nobody can revise.
