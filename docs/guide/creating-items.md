# Creating items

Items have a **kind** — clothing, object, or container — and kind-specific fields below the shared name/description/tags.

## Clothing

- **Category** is a template: picking "top" or "pants" pre-fills coverage and layer, then you adjust. The category name never reaches the story — the narrator only sees name, description, and the final coverage, so a "top" with arm coverage removed plays as a tank top.
- **Coverage** is a tree of body locations in five groups: head, torso (incl. neck), arms (upper arms → fingers), pelvis (hips/groin/buttocks), legs. Checking a region checks all its parts; uncheck a part to carve it out — a ski mask is "head" minus "eyes", glasses are "eyes" alone, a t-shirt is the torso parts + upper arms. A *dimmed dash* on a parent means partially covered: only the checked parts count. Mind the parents: "arms" includes hands, "torso" includes the neck — prefer the specific parts.
- Hidden layers stay hidden in images: an opaque outer layer that fully covers a lower layer keeps it out of avatar and scene prompts (a t-shirt under a closed abaya won't leak into the picture).
- **Layer** stacks 0 (underwear) → 3 (outerwear); higher layers occlude lower ones. **Opacity: sheer** reveals what's beneath.

## Objects

- **Subtype** (furniture, vehicle, weapon, tool, device, …) is vocabulary for future behavior. Holdable subtypes (tool, device, weapon…) can be carried in a hand — and still stored in containers.

## Containers

- **Capacity note** is free text for now; a quantified size/slot system is planned (see the phase-1 plan, T13).

## Where items come from

Besides this editor: the character forge suggests outfit items (created on character save), and the world forge places items (created on world save). Both reuse an existing library item when the name matches — you never get duplicates from a save.
