---
name: neon-postgres
description: Configure and troubleshoot Neon Postgres connections, branches, pooling, and database operations. Use for Neon-specific database work, neonctl, or Neon drivers; preserve the repository's existing deployment and migration workflow.
---

# Neon Serverless Postgres

## Codex workflow

Read the repository's `AGENTS.md` and existing database/deployment configuration
before applying provider examples. In Vesper, Fly remains the UI test surface,
Better Auth owns application sign-in, and the existing Drizzle migration flow
and no-local-application-gates rule apply. A Neon task does not imply changing
those choices or adding another environment loader.

Use the installed Neon CLI or an already available Neon MCP connection. Inspect
its actual command help or tool schema and target project/branch before acting;
reuse the task's selected resource and existing authorization. Fetch only the
current official documentation relevant to the operation. Keep connection
strings and credentials out of tool output and git.

Configure Codex tools or install missing provider skills only when setup is part
of the request. Use Codex's available skill-installer for an explicitly requested
skill installation, preserving these repository-owned skills. An optional Neon
MCP connection is not required when the CLI or API can complete the task.

Use this skill for Neon Postgres setup, connections, branches, and database operations. Deliver the requested configuration, diagnosis, or documented answer within the existing project scope.

Neon is a serverless Postgres platform that separates compute and storage to offer autoscaling, branching, instant restore, and scale-to-zero. It's fully compatible with Postgres and works with any language, framework, or ORM that supports Postgres.

## Neon Documentation

The Neon documentation is the source of truth for all Neon-related information. Always verify claims against the official docs before responding. Neon features and APIs evolve, so prefer fetching current docs over relying on training data.

### Fetching Docs as Markdown

Any Neon doc page can be fetched as markdown in two ways:

1. **Append `.md` to the URL** (simplest): https://neon.com/docs/introduction/branching.md
2. **Request `text/markdown`** on the standard URL: `curl -H "Accept: text/markdown" https://neon.com/docs/introduction/branching`

Both return the same markdown content. Use whichever method your tools support.

### Finding the Right Page

The docs index lists every available page with its URL and a short description:

```
https://neon.com/docs/llms.txt
```

Common doc URLs are organized in the topic links below. If you need a page not listed here, search the docs index: https://neon.com/docs/llms.txt. Don't guess URLs.

## What Is Neon

Use this for architecture explanations and terminology (organizations, projects, branches, endpoints) before giving implementation advice.

Link: https://neon.com/docs/introduction/architecture-overview.md

## Getting Started

Use this section when guiding a user through first-time Neon setup.

### Check Status Quo

Before starting setup, inspect the user's codebase and environment:

- Existing database connection code
- Existing Neon MCP server or Neon CLI configuration
- Existence of a `.env` file and `DATABASE_URL` environment variable
- Existing ORM (Prisma, Drizzle, TypeORM) configuration

### Setup for Codex

First inspect the existing CLI, connection, and project selection. An installed
CLI or connected MCP server can be used directly; ordinary database operations
do not require a new installation or global configuration.

When initial tool setup is requested, use the current
[CLI installation guide](https://neon.com/docs/reference/cli-install.md) and
installed `neonctl init --help` to select Codex-specific options. Inspect the
initializer's changes before running it: it may install tools, provision
credentials, or add skills. Preserve the existing `.agents/skills` files and
their compatibility links. Use native Codex configuration tooling when a new
MCP connection is actually required; do not run editor extension installers.

If OAuth requires user interaction, keep that step pending and continue useful
independent inspection. Do not claim authentication or setup succeeded until
an authenticated read verifies the selected resource.

### Setup Flow

**1. Select Organization and Project**

Use the MCP server or CLI to inspect organizations and projects. Reuse the project named by the task or configured workspace; ask only when the target remains ambiguous. Create a new project only within the authorized setup scope.

**2. Get Connection String**

Use MCP server or CLI to get the connection string. Store it in `.env` as `DATABASE_URL`. Read the file first before modifying to avoid overwriting existing values.

**3. Pick Connection Method & Driver**

Refer to the connection methods guide to pick the correct driver based on deployment platform: https://neon.com/docs/connect/choose-connection.md

**4. User Authentication with Neon Auth (if needed)**

Keep the application's existing authentication. Configure Neon Auth only when the task explicitly includes adopting it, using the current auth overview (https://neon.com/docs/auth/overview.md) and available tool schema. Vesper already uses Better Auth; needing user accounts does not authorize replacing it.

**5. ORM Setup (optional)**

Check for existing ORM (Prisma, Drizzle, TypeORM). If none, ask if they want one. For Drizzle integration, see https://neon.com/docs/guides/drizzle.md.

**6. Schema Setup**

- Check for existing migration files or ORM schemas
- If none: offer to create an example schema or design one together

### Resume Support

If resuming setup, check what's already configured (MCP connection, `.env` with `DATABASE_URL`, dependencies, schema) and continue from the next incomplete step.

### Security Reminders

Use the repository's existing environment mechanism for credentials, keep connection strings out of git and output, and preserve appropriate database role scope.

## Connection Methods & Drivers

Use this when you need to pick the correct transport and driver based on runtime constraints (TCP, HTTP, WebSocket, edge, serverless, long-running).

Link: https://neon.com/docs/connect/choose-connection.md

### Recommended: Drizzle + the right driver for your runtime

Preserve the existing ORM and driver unless the task calls for changing them. For a new integration, choose from the current connection guide based on the runtime:

- **Long-running or shared-runtime environments → node-postgres (`pg`).** Neon Functions, and any host where the function runtime is shared across requests / runs on fluid compute (e.g. **Vercel** with Fluid compute), keep a module-scope process alive across many requests. Open a `pg` pool **once at module scope** and reuse it across requests.
- **Fully isolated serverless (Lambda-style) → Neon's serverless driver (`@neondatabase/serverless`).** Hosts like **Netlify** spin up a fresh, isolated instance per request, so a persistent TCP pool can't be reused; the serverless driver queries over HTTP and is built for this.

**Neon Functions / Vercel / fluid compute — Drizzle + node-postgres:**

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

// Created once at module scope; reused by every request the instance handles.
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
const db = drizzle({ client: pool, schema });
```

On **Vercel** (Fluid compute) also attach the pool with `attachDatabasePool` from `@vercel/functions`, so the function runtime drains idle connections before an instance suspends:

```typescript
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { attachDatabasePool } from "@vercel/functions";
import * as schema from "./schema";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
attachDatabasePool(pool); // let the Vercel runtime manage the pooled connections
const db = drizzle({ client: pool, schema });
```

**Netlify and other fully-isolated serverless — Drizzle + Neon serverless driver:**

```typescript
import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";

const sql = neon(process.env.DATABASE_URL!);
const db = drizzle({ client: sql });
```

### Serverless Driver

Use this for `@neondatabase/serverless` patterns, including HTTP queries, WebSocket transactions, and runtime-specific optimizations.

Link: https://neon.com/docs/serverless/serverless-driver.md

### Neon JS SDK

Use this for combined Neon Auth + Data API workflows with PostgREST-style querying and typed client setup.

Link: https://neon.com/docs/reference/javascript-sdk.md

## Developer Tools

Use this for local development enablement with `npx -y neonctl@latest init --agent <agent-name>`, VSCode extension setup, and Neon MCP server configuration.

| Tool             | URL                                             |
| ---------------- | ----------------------------------------------- |
| CLI Init Command | https://neon.com/docs/reference/cli-init.md     |
| VSCode Extension | https://neon.com/docs/local/vscode-extension.md |
| MCP Server       | https://neon.com/docs/ai/neon-mcp-server.md     |
| Neon CLI         | https://neon.com/docs/reference/neon-cli.md     |

### Neon CLI

Use this for terminal-first workflows, scripts, and CI/CD automation with `neonctl`.

Link: https://neon.com/docs/reference/neon-cli.md

## Neon Admin API

The Neon Admin API can be used to manage Neon resources programmatically. It is used behind the scenes by the Neon CLI and MCP server, but can also be used directly for more complex automation workflows or when embedding Neon in other applications.

### Neon REST API

Use this for direct HTTP automation, endpoint-level control, API key auth, rate-limit handling, and operation polling.

Link: https://neon.com/docs/reference/api-reference.md

### Neon TypeScript SDK

Use this when implementing typed programmatic control of Neon resources in TypeScript via `@neondatabase/api-client`.

Link: https://neon.com/docs/reference/typescript-sdk.md

### Neon Python SDK

Use this when implementing programmatic Neon management in Python with the `neon-api` package.

Link: https://neon.com/docs/reference/python-sdk.md

## Neon Auth

Use this for managed user authentication setup, UI components, auth methods, and Neon Auth integration pitfalls in Next.js and React apps.

Link: https://neon.com/docs/auth/overview.md

Neon Auth is also embedded in the Neon JS SDK. Depending on your use case, you may want to use the Neon JS SDK instead of Neon Auth alone. See https://neon.com/docs/connect/choose-connection.md for more details.

## Neon Infrastructure as Code (`neon.ts`)

`neon.ts` is Neon's branch config and infrastructure-as-code file: declare which services your branches have, get type-safe env vars, and program per-branch compute — all in TypeScript (see the `neon` skill for the full reference). Postgres always exists on every branch, so you never declare the database itself; what you codify here is the Postgres-adjacent surface — Neon Auth, the Data API, and per-branch compute settings (autoscaling and scale-to-zero).

Add it with `@neondatabase/config`:

```bash
npm i @neondatabase/config
```

```typescript
// neon.ts
import { defineConfig } from "@neondatabase/config/v1";

export default defineConfig({
  auth: true, // Neon Auth (adds NEON_AUTH_* env vars)
  dataApi: true, // Data API (adds NEON_DATA_API_URL); requires auth: true (or an external IdP)
  // Postgres exists on every branch; tune its compute per branch:
  branch: (branch) => {
    if (branch.exists) return {}; // leave existing branches untouched
    if (branch.isDefault) return { protected: true }; // prod keeps default compute
    return {
      ttl: "7d", // non-prod branches auto-expire (max 30d)
      postgres: {
        computeSettings: {
          autoscalingLimitMinCu: 0.25, // scale to zero
          autoscalingLimitMaxCu: 1, // keep dev/preview cheap
          suspendTimeout: "5m",
        },
      },
    };
  },
});
```

Reconcile the declaration from the CLI — the Neon equivalent of `terraform plan` / `apply`:

```bash
neonctl config status   # print the branch's live config
neonctl config plan     # dry-run diff of what apply would change
neonctl config apply    # provision the declared services / settings
neonctl deploy          # alias for `neonctl config apply`
```

Because `neonctl checkout` applies the policy as it **creates** a branch, a fresh branch comes up with these compute settings (and Auth / Data API) already in place. Checking out an _existing_ branch never reconciles it — run `neonctl deploy` to apply changes.

Since `neon.ts` is TypeScript, invalid combinations fail to compile with an actionable message: the Data API verifies requests with Neon Auth by default, so `dataApi: true` without `auth: true` is a type error (the fix — `auth: true`, or `authProvider: 'external'` with a `jwksUrl` — is in the message). See the `neon` skill's type-safe config note.

Read the resulting env back, typed and validated against the policy, with `parseEnv` from `@neondatabase/env`:

```typescript
import { parseEnv } from "@neondatabase/env";
import config from "./neon";

const env = parseEnv(config);
env.postgres.databaseUrl; // typed; enabling auth / dataApi above surfaces env.auth / env.dataApi
```

## Branching

Use this when the user is planning isolated environments, schema migration testing, preview deployments, or branch lifecycle automation.

Key points:

- Branches are instant, copy-on-write clones (no full data copy).
- Each branch has its own compute endpoint.
- Use the neonctl CLI or MCP server to create, inspect, and compare branches.

Link: https://neon.com/docs/introduction/branching.md

For detailed branch creation workflows (normal vs schema-only branches, reset-from-parent, CLI/MCP selection), use the `neon-postgres-branches` skill if available

Or fetch the full branching skill from the following URL:

https://neon.com/docs/ai/skills/neon-postgres-branches/SKILL.md

If that specialist is unavailable, use its official documentation directly. Install it through Codex's available skill-installer only when installation is requested.

## Autoscaling

Use this when the user needs compute to scale automatically with workload and wants guidance on CU sizing and runtime behavior.

Link: https://neon.com/docs/introduction/autoscaling.md

## Scale to Zero

Use this when optimizing idle costs and discussing suspend/resume behavior, including cold-start trade-offs.

Key points:

- Idle computes suspend automatically (default 5 minutes, configurable) (unless disabled - launch & scale plan only)
- First query after suspend typically has a cold-start penalty (around hundreds of ms)
- Storage remains active while compute is suspended.

Link: https://neon.com/docs/introduction/scale-to-zero.md

## Instant Restore

Use this when the user needs point-in-time recovery or wants to restore data state without traditional backup restore workflows.

Key points:

- History windows for instant restore depend on plan limits.
- Users can create branches from historical points-in-time.
- Time Travel queries can be used for historical inspection workflows.

Link: https://neon.com/docs/introduction/branch-restore.md

## Read Replicas

Use this for read-heavy workloads where the user needs dedicated read-only compute without duplicating storage.

Key points:

- Replicas are read-only compute endpoints sharing the same storage.
- Creation is fast and scaling is independent from primary compute.
- Typical use cases: analytics, reporting, and read-heavy APIs.

Link: https://neon.com/docs/introduction/read-replicas.md

## Connection Pooling

Use this when the user is in serverless or high-concurrency environments and needs safe, scalable Postgres connection management.

Key points:

- Neon pooling uses PgBouncer.
- Add `-pooler` to endpoint hostnames to use pooled connections.
- Pooling is especially important in serverless runtimes with bursty concurrency.

Link: https://neon.com/docs/connect/connection-pooling.md

## IP Allow Lists

Use this when the user needs to restrict database access by trusted networks, IPs, or CIDR ranges.

Link: https://neon.com/docs/introduction/ip-allow.md

## Logical Replication

Use this when integrating CDC pipelines, external Postgres sync, or replication-based data movement.

Key points:

- Neon supports native logical replication workflows.
- Useful for replicating to/from external Postgres systems.

Link: https://neon.com/docs/guides/logical-replication-guide.md
