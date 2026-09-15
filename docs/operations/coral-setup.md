# Coral local setup and acceptance

Validated on 2026-09-12. These changes finish local Coral usage on
`codex/t3-thin-fork`; they do not merge either main, publish a release, replace
the installed 456code application, or import old sessions.

The September 14 update through upstream `5ea6439816470288d3f2b6b43635fea41fbbb101` completed its deferred live checks after the user renewed permission to run models. The built desktop backend used the normal launcher: Muse resumed the existing native session, switching to Qwen completed a turn, a fresh Coral task generated its title, and a clean restart preserved the same session without replay. See [the final acceptance record](thin-fork.md#final-acceptance-on-september-14). The retained fixture has Coral disabled again after testing. The Coral build and normal launcher are unchanged; the validation below records their original finishing pass.

## Build provenance

| Item                | Value                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------- |
| Coral source        | `/Users/ggfincke/Projects/Worktrees/coral/coral-acp-finish`                                         |
| Coral branch        | `codex/456code-acp-finish`                                                                          |
| Coral base          | `c2370d9e4b5624c9cbaec3bdd1cd56c578695b4a` (0.15.0)                                                 |
| Coral finish        | `3fcc35854f740462aa6ec48b6d97d23cd0909087` ([PR #82](https://github.com/ggfincke/coral/pull/82))    |
| Node executable     | `/Users/ggfincke/.local/share/mise/installs/node/24.20.0/bin/node`                                  |
| Built entrypoint    | `/Users/ggfincke/Projects/Worktrees/coral/coral-acp-finish/dist/cli/main.js`                        |
| 456code source      | `/Users/ggfincke/Projects/Worktrees/456code/456code-t3-thin-fork`                                   |
| 456code branch      | `codex/t3-thin-fork`                                                                                |
| 456code finish base | Original finishing commit `2f634894544b4ccb02638d60e2b6d624e3617975`, retained by the rebase backup |
| Upstream T3 base    | `d1d15c67f4a5fb82fd8d5e01e5e3b288296789c3`                                                          |

The compiled Coral entrypoint SHA-256 is
`adb5ab2d66903aa2d9a5859c661f6e8b86bcb82897f928525a3c9d7b669fa323`.
The Coral build-input fingerprint is
`cea523bbf1d01e3cde3fe4758404f64541e8a402115a2047db86ee33d1a50d07`.
It hashes the sorted lines `SHA256  relative-path\n` for all `src/**/*.ts`,
`src/**/*.tsx`, `package.json`, `package-lock.json`, and `tsconfig.json`.
Docs/tests are excluded from this build fingerprint. Local build outputs are
rebuildable; keep the source worktree while its launcher is installed. Version
output remains `0.15.0`, so version alone cannot distinguish this ACP build.

Rebuild from that Coral worktree with Node 24 on PATH:

```sh
npm ci
npm run typecheck
npm run build
```

The ACP SDK 1.3.0 is the only added direct dependency. Existing dependency
versions, the current Agent/TUI runtime and native snapshot codec are retained.

## Normal command and recovery

`/Users/ggfincke/.local/bin/coral` now executes the explicit Node and entrypoint
above, forwarding all arguments. The old wrapper recursively asked mise to
resolve another `coral`; it could select itself and hang. The repaired launcher
does not depend on PATH to find its runtime or build.

The original executable and restoration note are preserved in:

`/Users/ggfincke/.local/state/coral/installation-backups/20260912-155244-acp-finish/`

To restore that exact previous launcher, first stop clients using this build,
then copy the backup `coral` over `/Users/ggfincke/.local/bin/coral` and retain
its executable permission. This restores the old recursive behavior as well;
it is a recovery option, not the recommended working installation. The original
npm link and `/Users/ggfincke/Projects/Tools/coral` checkout are unchanged.
No global `CORAL_HOME` was changed, so normal TUI sessions remain in their
existing home. The TUI smoke test used a disposable home instead.

## Replacement configuration

In T3's existing **Settings > Providers > Add provider** flow, select Coral:

- Executable: `/Users/ggfincke/.local/bin/coral`.
- Ollama host: `http://127.0.0.1:11434` (the existing endpoint).
- `CORAL_HOME`: a new absolute directory owned by this replacement instance.
- For Coral-generated titles, set **General > Text generation model** to an
  installed Coral model. Ordinary task providers remain independently selected.

The verified isolated environments are retained under the thin worktree's
`.t3/coral-finish/` directory. Web settings are in
`t3-home/userdata/settings.json` and use `coral-home`. Desktop settings are in
`desktop-home/456code-thin/userdata/settings.json` and use `desktop-coral-home`.
These homes contain only this verification's fresh state. Their project is the
disposable `.t3/coral-finish/repo` Git fixture.

Start the same web environment from the thin worktree:

```sh
vp run dev --home-dir /Users/ggfincke/Projects/Worktrees/456code/456code-t3-thin-fork/.t3/coral-finish/t3-home
```

Start the built desktop against its separate backend home:

```sh
T3CODE_HOME=/Users/ggfincke/Projects/Worktrees/456code/456code-t3-thin-fork/.t3/coral-finish/desktop-home \
  node apps/desktop/scripts/start-electron.mjs
```

Desktop identity remains `com.ggfincke.456code.thin`, profile
`456code-thin`, and protocol `code456-thin`. Automatic app updates/publication
remain disabled. Never point these clients at the old 456code database.

## Provider behavior and limits

Readiness starts an ACP subprocess with a four-second deadline, initializes
protocol v1, requires native resume, refuses advertised authentication, and
closes the process. It never creates/resumes a session or authenticates.
A separate bounded `GET /api/tags` discovers exact Ollama names without loading
a model or running inference. The inventory is capped at 512 models and 1 MiB;
transient failures preserve its last good value. Empty inventory is explicit.

Text sessions support once-only supervised approvals, cancellation, model
changes and native resume. Attachments and client MCP servers are rejected;
app-MCP access remains deferred. `exec --permission-profile none` exposes no
tools, never starts MCP, and never saves a conversation.

Coral stores native snapshots and token-owned leases under its configured home.
A live lease blocks concurrent ACP ownership and ordinary saves/renames.
Resume validates the canonical working directory. A failed save preserves the
last valid snapshot and retries the captured turn before admitting another.
Keep the owning process alive while repairing disk failures. If the process is
lost before recovery, only the last successfully saved snapshot is durable.
Foreign-host or ambiguous ownership is never reclaimed automatically; only a
conclusively absent process on the same host is recoverable. Detailed runtime
recovery lives in the Coral worktree's `docs/acp.md`.

## Validation record

- All 543 Coral tests passed. The 116 focused integration tests cover ACP
  protocol/controller, the real CLI subprocess, headless exec, leases, native
  session/concurrency, the current Agent and interactive runtime. They include
  shutdown during setup, failed-save retry, legacy snapshots, concurrent
  ownership and restart/resume without replay.
- Eight focused Vite+ provider tests passed: five real child-process adapter
  lifecycle cases and three compatibility/timeout/metadata probe cases.
- Coral typecheck, targeted Prettier/ESLint, architecture boundary check and
  build passed. Server package typecheck, targeted Vite+ formatting/lint and
  the desktop build (seven dependency-scoped tasks) passed. Full-workspace
  validation remains assigned to CI. The finishing commits were later published in Coral PR #82 and 456code PR #111.
- Normal-shell and mise command resolution, `coral --version`, and
  `coral acp --help` passed. The current TUI opened, rendered its model/workspace
  and prompt, then exited successfully in a fresh home.
- In the actual isolated web app, Coral completed multiple turns, approved a
  write, rejected a write (no file created), cancelled and continued, switched
  from `qwen3.8:27b-mlx` to `muse-glimmer:30b-mlx`, and generated a task title.
  An ordinary Codex task returned `T3_FINISH_OK`.
- Clean backend restart resumed the same native session. Its previous 18
  messages remained intact apart from the rebuilt system prompt, and exactly
  one new user/assistant pair was added. Original context was recalled; no
  replay or extra native session was created. A prior watcher restart during
  a turn also recovered through native resume on the next submission.
- The built desktop used its separate identity/backend/home, displayed Coral
  as Available with all three installed models through the normal launcher,
  and returned `DESKTOP_CORAL_OK` from its own fresh Coral task. No old
  projects/sessions were imported.
- Original 456code main (25 changed paths), Coral main, and the older ACP
  worktree (50 recorded dirty/untracked paths) matched their preservation
  fingerprints. `apps/mobile` still matches the final upstream base exactly.

Runtime changes in Coral, provider changes in 456code, and the host launcher
remain three separately reviewable changes. No old worktree or app data was
removed. The isolated verification processes are stopped. Both native lease tables are
empty, and verification ports 14150, 6110 and 3773 have no listeners.
