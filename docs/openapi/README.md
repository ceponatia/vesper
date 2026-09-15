# Vesper OpenAPI specifications

This directory contains hand-maintained OpenAPI 3.1 specifications for Vesper's largest first-party HTTP API domains.

## Initial coverage

| Specification | Domain | Primary route families |
| --- | --- | --- |
| `chats.yaml` | Conversations, transcript, aggregate chat-state read model, scene rendering, successor-world provisioning | `/api/chats/*`, `/api/successor-chats/*` |
| `chat-state/` | Focused scenario, participant-state, wardrobe, player-state, and inspector-state resources | `/api/chats/*/scenario`, `/api/chats/*/participants/*/state`, `/api/chats/*/participants/*/wardrobe`, `/api/chats/*/player-state`, `/api/chats/*/player/wardrobe`, `/api/admin/*/chat-inspector/*` |
| `characters.yaml` | Character library, authoring, cloning, portraits and relationships | `/api/characters/*` |
| `items.yaml` | Item library, item authoring, classification and item images | `/api/items/*` |
| `locations.yaml` | Location library, map links, cloning and location images | `/api/locations/*` |
| `images.yaml` | Gallery browsing/lifecycle and image delivery | `/api/gallery/*`, `/api/images/*` |

These specifications cover the most important user-facing seams: gameplay/world interaction, character state and material authority, characters, material objects, places, and generated visual assets.

## Focused chat-state contracts

Issue #601 promoted the accepted `drafts/chat-state/` design into the implemented `chat-state/` contracts. The historical `GET /api/chats/:chatId/state` remains as an aggregate compatibility read model for the conversation UI, while first-party mutation is split by authority:

- chat-wide authored scenario data → `chat-state/scenario.yaml`
- one roster participant's non-wardrobe live state → `chat-state/participant-state.yaml`
- participant/player material clothing state → `chat-state/wardrobe.yaml`
- player persona selection/reset semantics → `chat-state/player-state.yaml`
- engine/debug recovery fields → `chat-state/inspector-state.yaml`

The old mixed `PATCH /api/chats/:chatId/state` remains only as a deprecated compatibility path while external/internal stragglers migrate. It no longer accepts inspector/debug fields, and first-party UI authoring does not use it as a general mutation contract.

## Design drafts

`drafts/` contains **proposed future HTTP contracts**, not descriptions of routes that already exist. Drafts should be promoted into an implemented domain directory when the routes land, rather than remaining indefinitely labeled as future design.

## Conventions

- The specs describe the authenticated application API, not a public third-party API. Authentication is currently enforced by Vesper's server wrappers (`withUser`, `withOwnedChat`, `withAuthorizedResource`, and related helpers), so the files document the session requirement with `x-vesper-auth` rather than inventing a wire-level cookie name.
- `x-vesper-source` points to the implementation file that should be checked when an operation changes.
- Complex simulation, character-profile, and image metadata objects are intentionally represented as extensible objects where their canonical schema lives in TypeScript contracts. The OpenAPI files should not duplicate a large evolving contract inaccurately just to make the YAML look exhaustive.
- Admin, inspector, test/dev, and internal worker routes are normally out of scope for the broad domain specs. Focused contracts may include them when moving an existing responsibility behind the correct authorization boundary is part of the API design.
- The specs prioritize correct route shapes, methods, important parameters, status codes, and stable request/response fields over duplicating every nested engine-owned object.

## Maintenance

When changing a documented route, update its OpenAPI operation in the same change when the HTTP contract changes. In particular, keep request validation, response status codes, pagination/cursor behavior, and capability restrictions synchronized with the route implementation.

A future follow-up can add OpenAPI linting/validation in CI and render these specs through Swagger UI, Redoc, or Scalar.
