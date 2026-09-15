# Vesper OpenAPI specifications

This directory contains hand-maintained OpenAPI 3.1 specifications for Vesper's largest first-party HTTP API domains.

## Initial coverage

| Specification | Domain | Primary route families |
| --- | --- | --- |
| `chats.yaml` | Conversations, transcript, chat state, scene rendering, successor-world provisioning | `/api/chats/*`, `/api/successor-chats/*` |
| `characters.yaml` | Character library, authoring, cloning, portraits and relationships | `/api/characters/*` |
| `items.yaml` | Item library, item authoring, classification and item images | `/api/items/*` |
| `locations.yaml` | Location library, map links, cloning and location images | `/api/locations/*` |
| `images.yaml` | Gallery browsing/lifecycle and image delivery | `/api/gallery/*`, `/api/images/*` |

These five were chosen because they sit on the most important user-facing seams: gameplay/world interaction, characters, material objects, places, and generated visual assets.

## Conventions

- The specs describe the authenticated application API, not a public third-party API. Authentication is currently enforced by Vesper's server wrappers (`withUser`, `withOwnedChat`, `withAuthorizedResource`, and related helpers), so the files document the session requirement with `x-vesper-auth` rather than inventing a wire-level cookie name.
- `x-vesper-source` points to the implementation file that should be checked when an operation changes.
- Complex simulation, character-profile, and image metadata objects are intentionally represented as extensible objects where their canonical schema lives in TypeScript contracts. The OpenAPI files should not duplicate a large evolving contract inaccurately just to make the YAML look exhaustive.
- Admin, inspector, test/dev, and internal worker routes are out of scope for this initial set.
- These are first-pass specifications. They prioritize correct route shapes, methods, important parameters, status codes, and stable request/response fields over documenting every nested engine-owned object.

## Maintenance

When changing a documented route, update its OpenAPI operation in the same change when the HTTP contract changes. In particular, keep request validation, response status codes, pagination/cursor behavior, and capability restrictions synchronized with the route implementation.

A future follow-up can add OpenAPI linting/validation in CI and render these specs through Swagger UI, Redoc, or Scalar.
