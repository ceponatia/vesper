# Creating items

Items have a **kind** — clothing, object, or container — and kind-specific fields below the shared name/description/tags. **New** on the `/items` library creates a blank item of the kind you're browsing (a clothing item from the Clothing tab, an object from Object, …), and the kind stays switchable in the editor. Every kind can carry a **Color**: a family from the fixed palette (drives the library's filters, sorting, and swatch chips) plus a free-text **Shade** for the precise hue ("aqua", "olive") used in display and image prompts.

The editor's **← Items** link takes you back to the library exactly as you left it — same type tab, search, and filters (the library remembers its view for the browsing session).

## Clothing

- **Category** is a template: picking "top" or "pants" pre-fills coverage and layer, then you adjust. The category name never reaches the story — the narrator only sees name, description, and the final coverage, so a "top" with arm coverage removed plays as a tank top.
- **Wearer** says who the garment is cut for — Women's, Men's, or Unisex. Leave it unspecified and it behaves as unisex: the library's wearer filter and the outfit picker always include unisex and unspecified pieces, so gender-neutral characters are covered by default.
- **Coverage** is a tree of body locations in five groups: head, torso (incl. neck), arms (upper arms → fingers), pelvis (hips/groin/buttocks), legs. Checking a region checks all its parts; uncheck a part to carve it out — a ski mask is "head" minus "eyes", glasses are "eyes" alone, a t-shirt is the torso parts + upper arms. A *dimmed dash* on a parent means partially covered: only the checked parts count. Mind the parents: "arms" includes hands, "torso" includes the neck — prefer the specific parts.
- Hidden layers stay hidden in images: an opaque outer layer that fully covers a lower layer keeps it out of avatar and scene prompts (a t-shirt under a closed abaya won't leak into the picture).
- **Layer** stacks from the skin out — 0 (underwear) · 1 (base) · 2 (mid) · 3 (outerwear); higher layers occlude lower ones. **Opacity: sheer** reveals what's beneath.

## Jewelry, headwear & eyewear

Picking one of these categories reveals a **Type** select (nose ring, choker, tiara, blindfold, …). Set it — the type is what the portrait/scene image models and the narrator lead with ("nose ring: thin gold hoop"), which lands far more reliably than a bare item name. Picking a type also pre-fills coverage (a lip ring anchors to the new **lips** slot under Face, a nose stud to **nose**), and the **Organize** pass fills missing types on old accessories.

## Objects

- **Subtype** (furniture, vehicle, weapon, tool, device, …) is vocabulary for future behavior. Holdable subtypes (tool, device, weapon…) can be carried in a hand — and still stored in containers.

## Containers

- **Capacity note** is free text for now; a quantified size/slot system is planned (see the phase-1 plan, T13).

## Where items come from

Besides this editor: the character forge suggests outfit items (created on character save), and the world forge places items (created on world save). Both reuse an existing library item when the name matches — you never get duplicates from a save.

## Organizing an existing library

The `/items` library browses by structured facets (category, subtype, wearer, color, layer), so items created before those fields existed can look unsorted. The **Organize** button classifies every visible item that's missing a facet — a background pass that infers category/layer/wearer/color (and object subtypes) from each item's name and description. It only fills blanks: anything you set by hand is never overwritten, and you can run it again whenever new unclassified items pile up.
