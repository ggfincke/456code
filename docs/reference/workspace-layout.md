# Workspace layout

- `/apps/server`: Node.js HTTP/WebSocket server. Serves the built web app and manages Codex,
  Claude, Cursor, Grok, and OpenCode provider sessions.
- `/apps/web`: React + Vite UI. Session control, conversation, and provider event rendering. Connects to the server via WebSocket.
- `/apps/mobile`: Expo client for iOS and Android. Connects to registered environments through the
  shared client runtime.
- `/apps/desktop`: Electron shell. Spawns a desktop-scoped `t3` backend process and loads the shared web app.
- `/packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types.
- `/packages/shared`: Shared runtime utilities consumed by server and clients. Uses explicit subpath exports (e.g. `@t3tools/shared/git`, `@t3tools/shared/DrainableWorker`) — no barrel index.
- `/packages/client-runtime`: Shared connection, RPC, environment, operations, and state runtime used
  by both web and mobile.

The external relay deployable is retired. Relay exports in `packages/contracts`, `packages/shared`,
and `packages/client-runtime` remain supported client compatibility surfaces; they do not imply an
in-repository relay deployment.
