# Call the live API

Use `../fly-api.sh` from this skill directory for authenticated JSON calls. It obtains the QA password without printing it, maintains a mode-600 cookie jar, adds the required `Origin`, retries once after a 401, prints only the final response body to stdout, and fails on non-2xx responses by default.

From the repository root:

```bash
.agents/skills/verify/fly-api.sh login
.agents/skills/verify/fly-api.sh GET /api/gallery | jq '.images | length'
.agents/skills/verify/fly-api.sh PATCH /api/admin/self/image-models/<id> '{"reprobe":true}'
```

For a deliberate negative case, name the one acceptable status. The body remains jq-friendly stdout and a different status fails:

```bash
.agents/skills/verify/fly-api.sh --expect 403 POST /api/example '{}'
```

A cookie-bearing `POST`, `PUT`, `PATCH`, or `DELETE` requires `Origin: https://vesper.fly.dev`; otherwise CSRF rejects it before authorization. Owner-admin handlers live below `/api/admin/self`. Lab and admin data are owner-scoped, so the QA account cannot exercise owner-only rows belonging to another account.

Use API mutations only when the request authorizes them. Inspect relevant route and parser code before inventing a payload, and preserve created records and their IDs for owner review under the [live-test retention rule](../SKILL.md). Testing authorization does not authorize deleting test-created state as cleanup; deletion requires an explicit owner request. Do not infer success only from HTTP status: parse the documented response shape and inspect the resulting resource or UI state.
