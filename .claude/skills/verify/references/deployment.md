# Deploy for verification

Read repository-root `docs/deployment.md` before every deployment; it is the authority for the current Fly procedure. Deploy only when verification needs code the current Fly release does not carry and the user has requested or already authorized deployment. Existing authorization for the task persists.

The release candidate must be one exact, clean `main` commit that the deliberate full CI dispatch validated:

1. Confirm the checkout is on `main`, clean, and at the intended commit. Fetch as needed and record its SHA.
2. Run `gh workflow run CI --ref main`, identify that dispatch, and wait for its final result. Confirm its `headSha` equals the recorded local SHA and every gate is green.
3. Run `fly deploy -a vesper` from that unchanged clean checkout. Fly sends the working tree, so any commit or file change after CI invalidates the match and requires a new dispatch.
4. Run `fly status -a vesper`, identify the resulting release, and verify the target behavior. Deployment completion is not behavioral evidence.

Do not bypass a dirty-tree refusal for verification. If the shared checkout cannot be made into the exact clean validated `main` tree without disturbing other work, use a clean temporary worktree at the validated SHA.

Keep the complete deployment output available until the build and release finish. If the remote builder reports `unauthorized`, follow the documented Fly authentication/local-builder recovery path; do not reinterpret it as an application build failure.
