# AGENTS.md

## Task Completion Requirements

- Tests are not colocated with sources. Every test lives under the repo-root `tests/` tree, which mirrors the source layout with the `src` segment dropped — `apps/server/src/service/bootService.ts` is tested by `tests/apps/server/service/bootService.test.ts`. New tests go there too. Each package's `vite.config.ts` points its suite at that tree via `test.dir`, so `vp test run` from a package still runs only that package's tests. `tests/package.json` is a resolution-only workspace package: a module a test imports must be declared there, including modules named solely in `vi.mock("...")`.
- Keep local verification focused on the files and packages changed. Run the smallest relevant test set; do not run the full workspace test suite as a routine completion step.
  - Use `vp test run <test-files>` for focused built-in Vite+ tests. Use `vp run test` only when the affected package specifically requires its `test` script.
  - Backend changes must include and run focused tests for the changed behavior.
  - Run targeted formatting, lint, and type checks for the affected scope when available.
- Do not run repo-wide `vp check`, `vp run typecheck`, `vp run test`, or equivalent full-suite commands locally unless the user explicitly requests them. CI is responsible for the full verification suite.
- After frontend feature development or any user-visible frontend behavior change, the primary agent must run one integrated verification pass for each affected client surface after integrating the work:
  - Web: use the `test-t3-app` skill. Launch one isolated environment, authenticate through the printed pairing URL, and verify the affected flow in the controlled browser.
  - Mobile: use the `test-t3-mobile` skill. Connect one representative iOS Simulator to one isolated environment and verify the affected flow. Stream it through serve-sim in the 456code in-app browser or another available agent browser when supported by the host.
  - Subagents must not independently launch dev servers or repeat integrated client verification unless their delegated task explicitly requires it.
  - Stop dev servers, watchers, and other long-running verification processes when the focused verification is complete.

## Package Roles

- `apps/server`: Node.js HTTP/WebSocket server. Wraps Codex app-server (JSON-RPC over stdio), serves the React web app, manages provider sessions, and publishes authorized bounded architecture projections.
- `apps/web`: React/Vite UI. Owns session UX, conversation/event rendering, native architecture resources, and client-side state. Connects to the server via WebSocket.
- `apps/mobile`: Expo client for iPhone and iPad. Reuses the shared client runtime while owning native navigation, notifications, and iOS integration.
- `apps/desktop`: Electron host. Supervises one primary 456code server backend and optional WSL backends, loads the shared web client, and owns desktop IPC, updates, previews, and native lifecycle.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by both server and client applications. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for sharing client code across web and mobile.
- `packages/cartographer-core`: Local-first repository analysis, graph, storage, query, CLI, and MCP implementation. The server consumes its explicit engine surfaces; UI and application ownership remain outside the package.

## Documentation Ownership

- Follow the tracked [formatting and comment style guide](docs/contributing/comment-style.md) for
  every new, moved, or substantially revised owned source file.
- `docs/` owns maintained public product, architecture, contributor, and operations documentation.
- `.plans/` owns self-contained publishable implementation plans, decisions, checkpoints, and
  closeout state. A tracked plan must not require ignored local evidence to be understood.
- `dev-docs/` owns ignored local audits, speculative designs, raw evidence, and working notes. It is
  not secret storage; promote durable active decisions into `docs/` or `.plans/` before relying on
  them.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Pull Request Evidence

- Upload screenshots, recordings, and other pull request evidence to GitHub; never commit them under `.github/pr-assets/` (CI rejects repository-owned PR assets).

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vpr sync:repos`; use `vpr sync:repos --repo <id>` to sync one configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.
