---
name: test-t3-app
description: Launch, retain, and test the 456code web app in isolated development environments, including first-try browser authentication with one-time pairing URLs, pairing-token recovery, worktree-safe state directories, cross-turn dev server lifecycle, and direct SQLite inspection or fixture seeding. Use when an agent needs to run T3 locally, iteratively test UI behavior with a human, recover from an expired or consumed pairing token, isolate dev state, or prepare test data in state.sqlite.
---

# Test T3 App

Use this skill for the web client. For iOS Simulator or physical-device testing against an isolated T3 backend, use the sibling [`test-t3-mobile`](../test-t3-mobile/SKILL.md) skill.

## Start an isolated web environment

1. Run commands from the repository root.
2. Choose a base directory that belongs only to the current worktree or test:
   - Use the repository's ignored `.456code` directory for reusable worktree-local state.
   - Use `mktemp -d /tmp/t3code-test.XXXXXX` for disposable state and retain the printed absolute path.
3. Start the full web stack with `vp run dev --home-dir <base-dir>`.
4. Keep the terminal session alive and read the selected server port, web port, base directory, and pairing URL from its output.

Treat a base directory as disposable only when it was created or deliberately selected for the current test. Never delete or directly seed the shared `~/.456code` directory. Prefer starting with a new temporary base directory over clearing state of uncertain ownership.

The dev runner disables browser auto-open by default. Do not pass `--browser` during automated testing: an automatically opened page can consume the one-time bootstrap token before the controlled browser uses it.

## Reuse the environment during focused verification

Follow the current repository `AGENTS.md`: stop verification processes when the focused verification is complete. An active loop can include both web and mobile or an explicitly requested human review window; the end of an assistant turn alone does not end that loop.

- Reuse the owned dev process, base directory, selected ports, authenticated browser tab, registered projects, and fixtures while the identified verification loop is active.
- When web and mobile share one backend, agree on the remaining client checks before teardown. Finishing one client must not stop the backend while the other still needs it.
- Before starting another environment, check whether the existing process and browser tab still serve the task. Reuse them when healthy instead of discarding useful state.
- On a later turn, verify that the existing process is alive and reuse its printed ports and base directory. If it exited, restart with the same base directory; create a new pairing token only when the browser session is no longer valid.
- State the live review window or remaining checks when retaining processes, and include only a non-secret web URL. A possible future follow-up is not a reason to keep servers running indefinitely.

## Authenticate the browser on the first navigation

1. Wait for the server log that says authentication is required and includes a URL ending in `/pair#token=...`.
2. Use the controlled in-app browser or browser-automation surface available to the agent. Do not use a system-browser launch command during automated testing.
3. Open that complete URL exactly once as the controlled browser's first navigation. Preserve the fragment and token verbatim.
4. Wait for the pairing exchange and redirect to finish before navigating elsewhere.
5. Continue in the same browser context so its stored bearer session remains available.

Treat pairing URLs as secrets. Do not copy them into final responses, screenshots, committed files, or durable logs. A pairing token is short-lived and single-use; opening the URL in another browser or opening it twice can consume it.

## Recover a consumed or expired pairing token

Create another token against the same database and web URL as the running dev server:

```bash
T3CODE_PORT=<server-port> node apps/server/src/bin.ts auth pairing create \
  --base-dir <base-dir> \
  --dev-url <web-url> \
  --base-url <web-url> \
  --ttl 15m \
  --label agent-ui-test
```

Use the `Pair URL` from this command once. Derive `<server-port>` and `<web-url>` from the current dev-runner output, including any automatically selected port offset. Setting `T3CODE_PORT` keeps the administrative CLI from probing for an unrelated free port.

Always pass `--dev-url` for a dev-runner environment so the generated pairing URL uses the current web origin. An explicit base directory stores runtime state in `<base-dir>/userdata`; the `<base-dir>/dev` fallback is only used by an implicit dev home. Use `auth pairing list` to inspect active token metadata; it intentionally cannot reveal token secrets.

## Inspect or seed SQLite state

Read [references/sqlite-fixtures.md](references/sqlite-fixtures.md) before changing the database.

- Use `node apps/server/scripts/t3-sqlite-state.ts query` for schema discovery and read-only checks.
- Stop the dev server before using `node apps/server/scripts/t3-sqlite-state.ts exec`, then restart it with the same base directory.
- Seed projection tables only for disposable UI fixtures. Use application commands and APIs when testing business behavior or projection correctness.
- Use the auth CLI, not direct `auth_*` table edits, for pairing and sessions.

The helper refuses to write to the shared `~/.456code` directory by default and creates a database backup before each mutation.

## Tear down when focused verification is finished

Stop the processes owned by this test when the focused verification and any explicitly pending client/human review are complete, or when the user asks. Do not tear down another task's process or a backend still serving the other client. An explicit request to retain an environment should name its purpose and boundary.

When teardown is appropriate:

1. Stop the owned dev process with its terminal interrupt after all participating client checks finish.
2. Preserve the isolated base directory when it contains useful reproduction evidence or state for a likely follow-up.
3. Otherwise remove only a path created for this test after resolving and verifying the exact target.

Preserve useful isolated state for a later restart without requiring the process to stay alive. Record the non-secret base directory and restart command. A fresh isolated base directory remains the safest reset when authentication, migrations, or fixture state becomes ambiguous.

## Troubleshoot predictably

- If the browser shows an unauthenticated pairing screen, issue a new token instead of retrying the consumed URL.
- If the pairing URL is no longer visible, create a replacement token with both `--dev-url` and `--base-url`.
- If the replacement token is rejected, verify that the CLI and server use the identical absolute base directory and web URL.
- If the UI shows unexpected data, verify that every command uses the identical explicit base directory before editing anything.
- If ports move because another instance is running, trust the current dev-runner output rather than assuming ports `13773` and `5733`.
