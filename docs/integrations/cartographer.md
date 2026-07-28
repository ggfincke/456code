<!-- docs/integrations/cartographer.md -->
<!-- configures the optional exact proposal and Cartographer explorer integration -->

# Cartographer proposal previews

456code can attach immutable proposed edits to a plan, render their exact source diff, and open a
Cartographer atlas for the captured base and proposed trees. Cartographer is an optional supervised,
trusted Node.js sidecar; proposal storage and native code diffs continue to work when it is not
configured.

## Configure the sidecar

Cartographer currently requires Node.js 24 or newer and a built checkout of the Cartographer
repository.

```bash
cd /absolute/path/to/cartographer
npm install
npm run build
node --version
```

Set both paths in the environment that starts the 456code server:

```bash
export T3CODE_CARTOGRAPHER_NODE=/absolute/path/to/node
export T3CODE_CARTOGRAPHER_CLI=/absolute/path/to/cartographer/dist/cli/index.js
```

`T3CODE_CARTOGRAPHER_NODE` may be omitted only when the server's `node` already resolves to Node 24
or newer. `T3CODE_CARTOGRAPHER_CLI` must name the built CLI file, not the Cartographer source
entrypoint. Restart 456code after changing either value. The server advertises Cartographer support
only when the CLI path is configured; launch and handshake failures are shown in Explorer instead
of falling back to an approximate result.

The configured Cartographer checkout is part of the trusted server installation. Embedded mode
removes Cartographer's GraphPatch proposal-authoring UI and does not register its patch list,
preview, save, or `.cartographer/patches` routes. Standalone Cartographer keeps those features.

For a source checkout of 456code:

```bash
pnpm exec vp run dev --home-dir /absolute/path/to/an/isolated-base-dir
```

For a production build, export the same variables before starting
`node apps/server/dist/bin.mjs`.

## Use proposal previews

In a Codex plan-mode task, the configured provider instructions require a decision-complete agent
to call the thread-scoped `proposal_preview_upsert` tool before it emits the final plan. The tool
accepts bounded typed file operations and an optional safe MDX narrative. It does not accept
environment, project, thread, provider-session, worktree-root, or plan authority from tool
arguments; the authenticated server derives those values from the active invocation.

The proposal call:

1. verifies that the authenticated provider session, its active turn, the projected running turn,
   and the thread's interaction mode all identify the same live plan-mode turn;
2. derives a deterministic future plan identity from that thread and turn, so the proposal can be
   submitted before the provider emits the final plan item;
3. captures the current Git working tree with raw-byte Git object plumbing and an isolated
   temporary index, without invoking clean, smudge, EOL, text-conversion, or checkout filters;
4. verifies every operation against the captured bytes and mode;
5. writes a new immutable revision and content-addressed blobs;
6. retains exact base and proposed Git trees without changing the user's index or worktree; and
7. links the revision to the derived plan identity.

Calls outside that exact active plan-mode turn fail closed. A stale MCP session, default-mode turn,
ended turn, mismatched projected turn, or missing proposal capability cannot create a revision.
The call requirement is provider guidance, not a server-side prerequisite for ingesting a final
plan item. A provider that does not follow it can still produce an unlinked plan. 456code reports
that absence explicitly and uses the current-worktree fallback described below; it never attaches a
different or merely latest revision to that exact plan.

Open **Explorer** from the right-panel surface picker or from a linked plan card. Its views are:

- **Narrative** — optional SafeDocument MDX rendered by the closed native component catalog;
- **Code Changes** — the exact normalized source diff for that immutable revision; and
- **Architecture** — a ticket-authenticated Cartographer sub-application loaded from the verified
  proposed graph with the verified base graph as its comparison snapshot.

Opening Explorer without a linked proposal starts a **Current worktree snapshot** session. That
session captures the worktree on demand when Explorer opens; it is not a filesystem watcher. Close
and reopen Explorer to include subsequent edits. The broker passes the immutable captured
repository root to Cartographer with `--scope .`, so monorepos without a root `src/` directory are
analyzed from the exact captured root instead of Cartographer's standalone `src` default. Proposal
architecture sessions instead use their retained, verified generation and display its separate
freshness result.

For repositories above Cartographer's automatic detailed-graph budget, the embedded app first
shows a usable coarse atlas and reports the host lifecycle as ready. Choosing **Load detailed
atlas** changes the lifecycle to indexing until the detailed graph is ready; the coarse/detailed
disclosure remains inside Cartographer.

An active generation is described as “Analyzing revision N against workspace snapshot X.” A ready
or terminal revision is described as “Preview of proposal revision N against workspace snapshot
X.” These are previews of one captured revision, not a promise that later implementation will make
the same changes.

When an implementation turn starts from a linked plan, 456code selects the latest proposal revision
created no later than the projected turn's request timestamp and stores that revision, timestamp,
and exact baseline tree in a durable implementation-attempt record. If the turn-start handoff was
missed, checkpoint completion can create the same record from the persisted projected turn and
preceding checkpoint. After the checkpoint completes, Explorer reports the baseline-to-actual
comparison as **matched**, **partial**, or **divergent**. A desired file state that already existed
before the implementation turn is not counted as work performed by that turn. Persisted
projected-turn identity is the restart/replay fallback when the in-memory request handoff is
unavailable.

## Exactness and freshness

The first release is deliberately Git-only:

- tracked files use current filesystem bytes;
- untracked and unignored files are included;
- ignored files are omitted;
- the staging boundary is not preserved;
- Git clean, smudge, EOL, and text-conversion filters are not run while capturing or
  materializing an exact tree;
- proposal operations may target only regular non-symlink file modes;
- existing symlink entries may be captured and materialized, but Cartographer's static analyzer
  excludes them without following their targets; and
- dirty submodules, non-Git workspaces, and cross-worktree proposals return explicit unsupported
  errors.

Cartographer analysis runs against disposable materializations of the retained base and proposed
trees. Materialization writes Git blob bytes and modes directly rather than using checkout
machinery, so repository filters cannot execute or change the bytes under analysis. The static
analyzer does not execute project code. It produces deterministic base-graph, proposed-graph, and
impact artifacts, and the embedded atlas consumes that retained graph pair instead of rebuilding
the live workspace. Before launch, 456code rechecks the retained Git refs, the graph and impact
source refs, each content-addressed artifact hash, and a no-follow digest of the materialized
proposed source root. Missing, changed, substituted, or oversized inputs fail closed.

Generation status keeps lifecycle and validity separate:

- lifecycle: `queued`, `preparing`, `analyzing`, `ready`, `failed`, `cancelled`, or `abandoned`;
- authority: `authoritative` for the exact static pipeline; and
- freshness: `fresh`, `base-changed`, `worktree-changed`, or `analyzer-changed`.

Changing `HEAD`, workspace bytes, or the built Cartographer analyzer marks an existing generation
stale. 456code never silently rebases a proposal revision.

Freshness applies differently to the two Explorer targets:

- a proposal target is a verified generation and can report `fresh`, `base-changed`,
  `worktree-changed`, or `analyzer-changed`; and
- a current-worktree target is a capture-only session and is explicitly labeled as an on-demand
  snapshot rather than continuously “fresh.”

## Bounds and cleanup

Proposal input is limited to 200 operations, 2 MiB per file, 10 MiB of submitted content, 10 MiB
of unified-diff input, 20 MiB of normalized diff output, and 1 MiB of narrative MDX. The MCP HTTP
request envelope is capped at 64 MiB before schema decoding. Exact proposal, current-worktree, and
Cartographer-generation snapshots accept up to 25,000 entries or 256 MiB. Those limits are
preflighted before snapshot objects or materialized files are written. Cartographer pre-serializes
the base graph, proposed graph, and impact result and enforces a combined 128 MiB artifact limit
before publishing any final artifact.

Only one generation and one embedded sidecar are active per thread; global analysis concurrency is
two. A newer generation cancels its superseded predecessor. Analyzer staging directories live under
the caller-owned generation output root. Failed, cancelled, abandoned, expired, replaced,
deleted-thread, and graceful server-shutdown paths terminate their child process and remove partial
session artifacts. Closing Explorer releases that exact embedded session; it cannot close a newer
replacement. Thread deletion installs an in-process tombstone before cleanup so a racing request
cannot recreate a generation or sidecar. Ready proposal-generation artifacts remain available for
their immutable revision. Retained proposal refs, proposal blobs/rows, and ready generation
artifacts do not yet have an automatic retention or garbage-collection policy; deleting a thread
cleans active runtime work but does not currently prune that immutable history.

An uncatchable process kill or host crash can leave a sidecar process or embed artifact directory
behind because v1 does not persist sidecar PIDs or perform an embed-session startup sweep.
Generation startup does abandon persisted in-progress generation rows and removes their partial
roots. Operators should remove a confirmed orphan under the configured 456code state directory
before restarting; do not delete retained proposal refs or ready generation artifacts.

Exact Git preflight intentionally buffers at most the configured 25,000-entry / 256 MiB corpus so
it can reject a limit or malformed tree before publishing a snapshot or materialization. If an
interrupted `fast-import` has already admitted objects, unreachable objects may remain for normal
Git garbage collection; no partial proposal or checkpoint ref is published, and the temporary
index and lock are still removed. Exact checkpoint restore reads and validates the full target
before mutation, but leaf deletion and direct writes are not transactional once they begin. An
external filesystem race or interruption during that mutation can leave a partial worktree; rerun
the same checkpoint restore after removing the external interference. Changed or dirty gitlinks
fail closed instead of being recursively replaced.

The embed URL carries a short-lived, one-use exchange ticket. Exchange creates a path-scoped
HttpOnly session; subsequent requests are confined to that session, exact parent origin, fixed
worktree, loopback sidecar, response-size bound, and wall-time bound. Cross-origin hosted clients
must serve both the parent and environment endpoint over HTTPS so the browser can deliver the
secure embedded session cookie. The proxy removes upstream `content-encoding` and `content-length`
after Node fetch processing so a future compressed sidecar response cannot forward decoded bytes
with stale wire-representation metadata.

## Trust boundary

The embedded iframe is a containment and lifecycle boundary for the installed Cartographer UI, not
a hostile-code sandbox. It uses scripts and same-origin access through the authenticated 456code
proxy, while the Cartographer child process already receives a verified source root and runs with
the server operator's process privileges. Configure only a Cartographer build you trust.

This boundary is not used for agent-authored JavaScript or trusted-mode MDX. Repository and proposal
MDX remain on the closed SafeDocument renderer. Supporting executable authored content would
require a genuinely isolated origin and a separate consent/capability design; that is intentionally
deferred.

## Troubleshooting

- **Cartographer is not configured** — confirm `T3CODE_CARTOGRAPHER_CLI` is set in the server
  process, points to `dist/cli/index.js`, and restart the server.
- **The configured CLI could not be loaded** — rebuild Cartographer and use an absolute path.
- **Cartographer failed to start safely** — run the configured Node binary with `--version`
  (expect 24 or newer), then run the Cartographer build again.
- **Proposal analysis is stale** — inspect the freshness reason; create a new proposal revision if
  the workspace moved, or regenerate after rebuilding Cartographer if the analyzer changed.
- **Proposal is unsupported** — confirm the thread uses one Git worktree, has a valid `HEAD`, and
  has no dirty submodules or symlink/type-changing proposal operations.
- **Current worktree changes are missing** — close and reopen Explorer; current-worktree sessions
  are capture-only and do not watch for edits.
- **A previous hard crash left an embed sidecar or directory behind** — confirm that no running
  456code server owns it, stop the orphan process, then remove only its exact session directory
  under the configured state directory.
- **The iframe is unauthorized in a hosted client** — confirm the parent and environment URLs use
  HTTPS and that the browser permits the path-scoped embedded session for that site.
