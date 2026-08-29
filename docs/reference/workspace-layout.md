<!-- docs/reference/workspace-layout.md -->
<!-- maps application and package workspace ownership -->

# Workspace layout

- `/apps/server`: Node.js HTTP/WebSocket server. Serves the built web app and manages Codex,
  Claude, Cursor, Grok, and OpenCode provider sessions. It also owns architecture-analysis
  lifecycle and serves authorized bounded projections over Effect RPC.
- `/apps/web`: React + Vite UI. Owns session control, conversation and provider event rendering,
  plus native Impact Diff and the Architecture/Structure Repository Map lenses. Connects to the
  server via WebSocket.
- `/apps/mobile`: Expo client for iPhone and iPad. Connects to registered environments through the
  shared client runtime.
- `/apps/desktop`: Electron host. Supervises a primary 456code server backend and optional WSL
  backends, then loads the shared web client through the desktop protocol.
- `/packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types.
- `/packages/shared`: Shared runtime utilities consumed by server and clients. Uses explicit subpath exports (e.g. `@t3tools/shared/git`, `@t3tools/shared/DrainableWorker`) — no barrel index.
- `/packages/client-runtime`: Shared connection, RPC, environment, operations, and state runtime used
  by both web and mobile.
- `/packages/cartographer-core`: Repository graph analysis, storage, bounded query, CLI, and MCP
  engine used by the server through explicit package subpaths. It does not own 456code UI.

The external relay deployable is retired. Relay exports in `packages/contracts`, `packages/shared`,
and `packages/client-runtime` remain supported client compatibility surfaces; they do not imply an
in-repository relay deployment.
