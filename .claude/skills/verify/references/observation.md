# Observe the live deployment

Use this route when the requested behavior may already be deployed. Establish the current release or commit first, then gather only the evidence needed for the claim. A successful deploy command, browser navigation, or client notification is not itself proof of application behavior.

For UI work, invoke the supported browser-control skill available in the current environment (for example, `browser:control-in-app-browser`) and use the browser tool it documents. Do not hard-code old Playwright MCP function names.

Sign in at `https://vesper.fly.dev/sign-in` as `uxtest-main@vesper.local`. Retrieve `DEV_PASSWORD` from the Fly Machine only when needed, never echo it or save it. `/api/dev/impersonate` is disabled in the production build. If the account is unavailable, treat seeding as a separate live mutation and perform it only when authorized.

List the QA account's existing chats before creating one. Prefer editing a suitable existing chat. If isolation requires a new chat, record why and delete it after verification when that cleanup is within the authorized scope.

Use viewports appropriate to the behavior: about 1440 by 900 for desktop, 390 by 844 for phone, and at least 1024 pixels wide for the standing-portrait column. Capture screenshots and downloaded/generated evidence under repository-root `eval-images/`.

Treat console errors as evidence to investigate. A one-time React hydration error immediately after a release can come from old assets crossing the Machine cutover; retry on the settled release with a fresh load. Do not dismiss a repeatable hydration error or any error observed on a settled build.

For JSON-shaped evidence, follow [api.md](api.md). Record the observed release, scenario, viewport or request, expected behavior, actual behavior, and any relevant logs.
