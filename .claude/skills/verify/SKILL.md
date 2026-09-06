---
name: verify
description: Verify live Vesper behavior on Fly through UI observation, authenticated API calls, deployment checks, or feature-flag experiments. Use to reproduce a running-app issue or prove an authorized change works.
---

# Verify Vesper on Fly

Choose the smallest route that proves the requested behavior:

- **Observe the existing deployment:** do not deploy. Read [references/observation.md](references/observation.md), then inspect the live UI and/or make read-only API calls.
- **Call an API:** read [references/api.md](references/api.md). Use `fly-api.sh` for authenticated JSON requests, including authorized mutations.
- **Deploy:** only when the target code is absent from Fly and deployment is part of the user's request or already authorized. Read [references/deployment.md](references/deployment.md) before acting.
- **Run a feature-flag experiment:** read [references/feature-flags.md](references/feature-flags.md) before changing any secret. A flag change restarts the Machine and may require prerequisite flags.

UI verification runs against `https://vesper.fly.dev`, never local Postgres plus `pnpm dev`. Do not run local tests, Vitest, lint, typecheck, or builds as part of this workflow; CI owns code gates. Use the currently available, supported browser skill and browser tool rather than assuming fixed tool identifiers.

Reuse the QA account's existing chats unless the scenario truly needs isolated state. Put screenshots, generated images, and other evaluation artifacts in the repository-root `eval-images/` directory. Keep them untracked.

Live mutations stay within the user's authorized scope. Authorization already given for the current task persists; do not ask generically again before each command. Report the deployed commit or release observed, the inputs used, and the concrete UI/API/log evidence behind the verdict.
