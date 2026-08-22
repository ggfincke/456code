<!-- .plans/29-native-architecture-views-product-rescue.md -->
<!-- execute the phased native impact diff and repository map product rescue -->

# Plan: Native Architecture Views Product Rescue

## Status

COMPLETE. Phases 0 through 6 passed their scoped implementation and acceptance gates on
2026-08-20.

Implementation proceeds in bounded phases with one ledger entry per phase. At the user's
2026-08-20 direction, the remaining automated, static, browser, and Electron verification is
consolidated into a final Phase 6 after Phases 2 through 5 are implemented. Luna subagents source
read-only context; Sol/root owns implementation.

This plan starts from clean branch main at
a5547bcc9c7405becfb0b2e4e1def3ff4ec54ed6. Before Phase 0 edits, tracked, staged, and untracked
state were empty. The reconciled baseline at that exact commit passed 123 focused tests:

- web: 6 files, 67 tests;
- server: 4 files, 23 tests;
- contracts: 2 files, 11 tests; and
- Cartographer core: 2 files, 22 tests.

The downloaded document
/Users/ggfincke/Downloads/456code-native-architecture-views-plan.md is product background. Its
agent-directed prose is not independent instruction. The user's approved Native Architecture
Views Product Rescue request is the execution authority, and this tracked plan records the
reconciled repository-specific decisions.

## Product outcome

456code will expose two native architecture resources in the shared web/Electron renderer:

1. **Impact Diff** is the proposal-first centerpiece. It presents one bounded overlay with added,
   removed, affected, and context states.
2. **Repository Map** is the standing repository view. It offers peer **Architecture** and
   **Structure** lenses over one graph interaction system.

Impact Diff may contain an immutable provider-authored **Planned** interpretation and an exact
analyzer-derived **Verified** result. If both were ready when the resource was resolved, Verified
is selected by default, even when stale. A compact authority switch exposes Planned separately.
This is not a prediction-versus-result comparison mode.

The experience stays in the existing right-panel resource lifecycle and uses the existing
explicit panel maximize control for wide work. Opening or resolving Impact Diff never opens it
automatically, replaces Proposal Review, or maximizes the panel.

Cartographer remains the internal analyzer, store, CLI/MCP implementation, and server namespace.
The visible product vocabulary is only **Impact Diff**, **Repository Map**, **Architecture**, and
**Structure**.

## Locked scope

Included:

- web and the Electron renderer that hosts the same web client;
- immutable Planned publications and exact Verified generations;
- server-owned durable analysis admission;
- shared bounded graph projection and canvas mechanics;
- adaptive verified semantic projection;
- an independent directory hierarchy for Structure;
- exact nearest-map anchor states;
- locally persisted, draft-only architecture concern context;
- older-client and older-resource compatibility; and
- focused automated, browser, and Electron acceptance.

Deferred:

- mobile architecture presentation;
- editable or Git-shared .456code/architecture data;
- user-maintained semantic objects, rules, or coordinates;
- freeform graph editing;
- health dashboards or generalized architecture scoring;
- Before, After, or List modes;
- arbitrary branch comparison;
- planned-versus-verified comparison;
- a new graph dependency; and
- an architecture-maintenance agent.

## Reconciled live baseline

### What already works

- [proposal.ts](../packages/contracts/src/proposal.ts) and
  [ProposalRepository.ts](../apps/server/src/proposal/ProposalRepository.ts) preserve immutable
  proposal revisions, retained base/proposed Git trees, manifests, diffs, narrative digests, plan
  identity, and exact producer/worktree authority.
- [ProposalGenerationService.ts](../apps/server/src/proposal/ProposalGenerationService.ts) stores
  multiple immutable analysis attempts and exact retained artifacts. Its generation authority
  value, authoritative or estimated, is independent from the product authority Planned or
  Verified.
- [analyzeTrees.ts](../packages/cartographer-core/src/cli/commands/analyzeTrees.ts) already emits
  deterministic base, proposed, and raw impact artifacts through a sealed write path.
- [ArchitectureQueryService.ts](../apps/server/src/cartographer/ArchitectureQueryService.ts)
  resolves authorized proposal and diff identities and fails closed on invalid generation
  evidence.
- [ArchitectureProjectionService.ts](../apps/server/src/cartographer/ArchitectureProjectionService.ts)
  provides bounded standing map, scope, neighborhood, path-scope, and exact source projections.
- [ArchitectureCanvas.tsx](../apps/web/src/components/architecture/ArchitectureCanvas.tsx) already
  owns camera transforms, pan, wheel/button zoom, fit/reset, deterministic curves, weighted edges,
  minimap, node/edge hit targets, and keyboard focus.
- [ArchitectureDetailsDrawer.tsx](../apps/web/src/components/architecture/ArchitectureDetailsDrawer.tsx)
  already provides one nonmodal wide drawer and one focus-managed narrow sheet.
- [rightPanelStore.ts](../apps/web/src/stores/rightPanelStore.ts) already persists immutable
  architecture resource identities at storage version 12, and the generic panel layout already
  supplies explicit maximize/restore behavior.
- Electron uses the shared web renderer. No duplicate desktop architecture UI is required.

### What does not meet the product contract

- Impact uses a private fixed three-column SVG renderer and path identities such as
  impact-node:<path>, while Map uses semantic projection IDs and the reusable camera canvas.
- The raw ArchitectureImpactResultV2 is exact evidence, but it is not a semantic graph projection.
- Planned Impact has no provider transport, immutable store, proposal link, or UI authority.
- Verified proposal generation is started from duplicate client effects instead of durable
  server admission.
- The standing index has systems, blocks, and flat directory membership, but not an independent
  nested directory tree.
- Repository Map exposes fixed Systems, Blocks, and Files controls rather than Architecture and
  Structure lenses with response-driven breadcrumbs.
- Map anchors do not distinguish matched, ambiguous, unmatched, and stale outcomes.
- The composer has terminal, element, preview-annotation, and review-comment contexts but no
  architecture concern context.
- Current maintained docs and multiple visible controls still say Cartographer, Repository Atlas,
  or Open graph diff and describe retired graph modes.

## Keep, adapt, and retire matrix

| Current surface or mechanism | Decision | Reconciled responsibility |
| --- | --- | --- |
| Proposal and revision identities | Keep | Exact immutable proposal authority and proposal-to-plan lookup. |
| ProposalGenerationService | Adapt | Retain attempts, single-flight behavior, artifacts, and source authority; admit starts durably on the server and add the semantic artifact. |
| analyze-trees raw artifacts | Adapt | Retain base.graph.json, proposed.graph.json, and impact.json; add a sealed impact-projection.json and manifest version. |
| Atlas index systems/blocks | Adapt | Retain semantic membership and IDs; add independent nested directories and crosswalks. |
| ArchitectureQueryService | Adapt | Retain exact resolution and legacy reads; add exact projection reads, candidates, anchors, and closed failure behavior. |
| ArchitectureProjectionService | Adapt | Retain bounded standing and source mechanics; serve versioned shared Map projections. |
| Architecture MCP toolkit | Adapt | Retain query/patch tools; add the authenticated architecture_plan_impact_upsert mutation. |
| ArchitectureCanvas camera geometry | Extract | Become a mechanism-only ArchitectureGraphCanvas with generic scene inputs. |
| ArchitectureBoundedView | Keep narrow | Remain Map/Scope presentation framing; do not become a mode-heavy cross-product shell. |
| ArchitectureDetailsDrawer | Keep | One node/edge details mechanism for Map, Impact, and Scope. |
| Impact GraphView and fixed layout | Retire | Replace after the shared canvas path passes focused and browser acceptance. |
| architectureImpactModel | Adapt | Become the Verified legacy/file adapter and semantic Impact presenter, not a shared canvas owner. |
| RepositoryAtlasSurface | Adapt | Preserve pinning, recovery, journey, and exact source; rename visible product and add lenses. |
| RepositoryAtlasBootstrap | Keep | Continue preparing or reusing an exact standing generation outside rendering. |
| ArchitectureScopeSurface | Adapt | Preserve paging, neighborhood, and source actions; participate in Architecture/Structure breadcrumbs. |
| ArchitectureZoomControl | Retire after replacement | Replace fixed Systems/Blocks/Files product controls with lens and breadcrumb navigation. |
| ArchitectureHealthRow and health toggle | Retire from product UI | Keep health fields available to engine and diagnostics only. |
| repository-atlas resource kinds and IDs | Keep internal | Preserve persisted compatibility while all visible labels become Repository Map. |
| right-panel storage version 12 | Keep unless proved otherwise | Extend exact target decoding additively; bump only if migration tests prove a structural rewrite. |
| Client generation start effects | Retire after server proof | Clients poll, display progress, and request explicit retry only. |
| Composer draft persistence | Adapt | Bump 10 to 11 for bounded ArchitectureConcernContext values. |
| Visible Atlas and Cartographer language | Retire | Historical plans and internal identifiers are the only intentional exceptions. |
| Legacy Impact V1/V2 and Map adapters | Keep invisible | Only older-server and persisted-resource compatibility may use them. |

## Public contract freeze

### Capability and version policy

- Add optional ExecutionEnvironmentCapabilities.architectureGraphViewsV2.
- Absence or false means the client uses the current invisible compatibility adapters.
- True means the client exposes only the rescued Impact Diff and Repository Map product.
- ArchitectureGraphProjection is introduced at transport version 1.
- PlannedImpactPublication input/result is version 1.
- ArchitectureConcernContext is version 1.
- The additive impact method is cartographer.getArchitectureImpactProjection.
- Existing cartographer.getArchitectureImpact remains the raw/legacy evidence method.
- Existing cartographer.getRepositoryMap and cartographer.getArchitectureScope names remain. A
  projectionVersion: 2 request arm returns the shared projection transport; legacy request arms
  retain the existing version-1 results.
- Existing internal repository-atlas, architecture-impact, and architecture-scope resource kinds
  remain decodable.

The projection object's version is independent from the environment capability name and from
legacy result versions. A projection schema change requires a new projection version; a product
rollout change requires a new capability.

### Authority layers

The implementation must never collapse these distinct authorities:

| Layer | Values | Meaning |
| --- | --- | --- |
| Product impact authority | planned, verified | Provider interpretation versus analyzer evidence. |
| Generation authority | authoritative, estimated | Existing exact-tree versus estimated analyzer provenance. |
| Standing authority | exact standing source | Project, standing generation, analyzed side, and graph digest. |
| Resource authority | exact descriptor | The candidate revisions captured when an immutable resource is opened. |

Provider input never supplies environment ID, project ID, thread ID, turn ID, provider session,
provider instance, filesystem root, graph path, graph ID, standing generation, graph digest, or a
trusted semantic ID. Those values are derived or resolved server-side from the authenticated MCP
scope and persisted projections.

### architecture_plan_impact_upsert version 1

The tool belongs to the architecture MCP toolkit and is a planning-metadata mutation. It requires
both architecture and proposal capabilities, an authenticated active provider turn, and either:

- Plan mode, where the server derives plan:<thread>:turn:<turn>; or
- Orchestrate mode, where the input may name only a runId and revision lookup selector and the
  server verifies an exact tool-sourced revision from the same active turn.

The payload uses exact-key decoding and contains:

| Field | Bound and rule |
| --- | --- |
| version | Literal 1. |
| summary | Non-empty trimmed text, at most 4,000 UTF-8 bytes. |
| outcome | changed or no-impact. |
| changedObjects | At most 60 publication-local objects. Empty for no-impact. |
| relationships | At most 120 publication-local relationships. Empty for no-impact. |
| pathHints | At most 100 unique repository-relative POSIX paths. |
| rationale | Optional trimmed text, at most 16,000 UTF-8 bytes. |
| omissions | Exact provider-claimed totals/omitted counts plus an optional bounded note. |
| orchestratePlan | Optional exact run/revision selector; legal only in Orchestrate mode. |
| canonical payload | At most 256 KiB after normalization and canonical JSON encoding. |

Each changed object has a unique localId, label, semantic level text, change state, optional description,
and zero or more references into the top-level pathHints list. Local IDs and labels are each at
most 200 characters; descriptions are at most 2,000 UTF-8 bytes. The state is added, removed, or
affected. Context is materialized by the server, not claimed as changed by the provider.

Each relationship has a unique localId, fromLocalId, toLocalId, relationship kind, change state,
optional positive weight, optional rationale, and optional path-hint references. Both endpoints
must resolve to changedObjects in the same publication. The state is added, removed, or affected.

For changed, at least one object or relationship is required. For no-impact, both arrays are
empty; path hints and rationale may explain implementation-only work. Totals must equal returned
plus omitted. Duplicate local IDs, dangling endpoints, traversal, absolute paths, backslashes,
control characters, spoofed extra keys, and oversized canonical payloads fail before admission.

The response returns only server-owned identities: publication ID, publication revision, content
digest, exact plan identity, provisional projection reference, and whether anchoring was queued,
reused, or already materialized.

### Immutable publication identity

- The server canonicalizes the normalized interpretation and computes a SHA-256 content digest.
- A unique key on thread, plan identity, and digest makes an identical retry idempotent.
- The first distinct digest is publication revision 1. A later distinct digest allocates the next
  revision and supersedes active lookup of the prior publication without overwriting it.
- A publication is immutable. Provider claims remain stored separately from projections.
- Proposal Preview does not accept a provider-supplied publication reference. During the same
  transaction that appends a proposal revision, the server resolves the latest publication for
  that exact plan identity and writes an immutable proposal-revision link.
- The public ProposalRevision contract gains optional plannedImpactRef containing publicationId,
  publicationRevision, and contentDigest. All three fields are server-produced and must agree
  with the exact link row.
- Missing Planned data is normal compatibility state and does not block proposal persistence.
- Reverted plans disappear from active plan lookup. Exact publication and proposal-linked
  resources remain readable with a Reverted label.

### Exact impact resource descriptor

A plan lookup is a resolver, not the long-lived resource identity. Opening Impact Diff resolves a
version-1 descriptor containing:

- exact plan identity and active/reverted state;
- at most one exact Planned projection reference;
- at most one exact proposal-linked Verified generation/projection reference;
- default authority, Verified when present and otherwise Planned;
- resolution time and exact freshness values; and
- optional newer descriptor availability.

The right-panel resource ID encodes the exact descriptor. Authority switching only switches
between candidates captured in that descriptor. Polling may advertise a newer descriptor, an
anchored Planned projection, a retry, or a newer proposal revision, but never rewrites the open
descriptor.

Comparison-scoped descriptors are Verified-only and continue to support exact proposal-generation
and diff-analysis selectors. A plan-scoped lookup never falls across plan/proposal revisions.

The strict version-1 cartographer.getArchitectureImpactProjection request has one of three arms:

- resolve-plan with authenticated thread ID and exact plan ID;
- resolve-comparison with authenticated thread ID and one existing proposal-generation or
  diff-analysis selector; or
- read-exact with the immutable descriptor previously returned by either resolver.

The result returns the immutable descriptor, candidate summaries, selected authority, projection,
freshness, and optional newer-descriptor availability. The client canonicalizes a resolved
resource to read-exact before persistence. A requested authority missing from the descriptor is
unavailable; the server does not substitute another authority.

### ArchitectureGraphProjection version 1

Map and Impact use one bounded transport and separate presenters. The common projection contains:

- projectionId and immutable revision reference;
- kind: repository-map or impact-diff;
- authority: standing, planned, or verified;
- resultState: graph or no-impact;
- freshness state, generated/published time, exact source identity, and optional reverted state;
- lens: architecture or structure;
- chosen semantic level and response-driven breadcrumbs;
- stable layoutVersion;
- exact node, edge, evidence, and changed-file totals;
- returned counts and omission metadata;
- nodes, edges, and bounded evidence references;
- optional standing anchors; and
- optional newer exact descriptor/projection availability.

A projection node contains:

- stable id, label, semantic level, optional parent ID, and optional repository-relative path;
- deterministic position and stable tintKey, never an untrusted raw CSS color;
- state: added, removed, affected, or context;
- a required textual state label plus a non-color badge/icon/stroke treatment;
- file, inbound, outbound, and affected-consumer counts where applicable;
- bounded evidence references; and
- an optional ArchitectureStandingAnchor.

A projection edge contains:

- stable edge ID;
- exact source and target node IDs;
- relationship kind and positive weight;
- state and required textual state label;
- bounded changed-first evidence; and
- an optional relationship anchor.

Repository Map uses context state for unchanged standing nodes and edges. Impact Diff uses all four
states. State colors remain green, red, amber, and muted respectively, but color alone is never
the state signal.

The hero graph limit is 60 nodes and 120 edges. Exact totals are calculated before truncation.
Evidence uses the existing bounded path/source limits and remains smaller than the outer 2 MiB
exact source response. No UI presenter may infer safety or completeness from a returned witness
list.

### Planned projection materialization

Publication admission writes projection revision 1 immediately:

- changed publications become a provisional graph with disjoint IDs
  planned:<content-digest>:object:<local-id> for nodes and
  planned:<content-digest>:relationship:<local-id> for edges;
- no-impact publications become a direct no-impact projection with no graph action;
- node order, positions, tint keys, and edge IDs are deterministic from canonical provider-local
  identity; and
- provisional wording states that objects are interpreted proposal intent and are not verified as
  present in the repository.

If a standing generation already exists, the same admission may append an anchored projection
revision immediately. Otherwise it creates or reuses the ordinary single-flight standing-map
build and waits in durable admission. A ready standing map produces a new immutable anchored
projection revision; it never updates revision 1.

Anchoring may replace an existing/provably removed object's provisional ID with the exact standing
semantic ID. New or unmatched objects retain the namespaced Planned ID and carry the nearest
standing anchor. An open provisional resource remains pinned and may show **Anchored version
available**.

### Verified semantic projection

Raw impact.json remains the exact engine/MCP evidence artifact. New proposal and diff analyses
also write impact-projection.json before the ready manifest is emitted.

The algorithm is fixed:

1. Build base and head memberships for systems, blocks, directories, and files while the two exact
   graphs are already in memory.
2. Map raw node/import/API/violation/move evidence through both memberships.
3. Choose systems for cross-system change, blocks for cross-block change, directories for
   cross-directory change, and files for a contained local change.
4. Mark a unit added or removed only when that unit exists on exactly one side. A surviving unit
   with relationship, API, violation, move, or affected-consumer evidence is affected.
5. Include changed endpoints, affected consumers, and one bounded context hop.
6. Preserve exact totals, then rank changed before affected before context and enforce the
   60-node/120-edge hero bounds.
7. Reuse base positions for surviving and removed units and head positions for added units.
8. If the exact comparison changes implementation bytes but produces no semantic relationship or
   public-API effect, emit no-impact rather than a fabricated graph.

For proposal generations, implementationChangedFileCount comes from the immutable proposal
manifest. Diff analysis records the exact changed-path count at admission/write time. The semantic
artifact never derives that count from a bounded witness array.

The analyze-trees ready manifest advances from version 1 to version 2 and names all four artifacts:
base graph, proposed/head graph, raw impact, and semantic impact projection. Legacy manifest
version 1 remains readable.

Ready publication validates:

- exact base/head Git tree identities;
- analyzer fingerprint;
- base/head graph digests and projection digest;
- manifest and artifact schema versions;
- canonical containment under the authorized generation root;
- regular-file/no-follow and post-read identity checks;
- strict codecs and cross-reference integrity;
- exact totals and omission equations; and
- byte, node, edge, evidence, and path bounds.

A failed or corrupt Verified artifact fails closed. It never falls through to current workspace
bytes or Planned data.

### Legacy Verified behavior

Rows without impact-projection.json remain readable through the existing file-level
ArchitectureImpactResult/architectureImpactModel adapter. Their exact raw evidence is not
reinterpreted as Planned, and they are not silently reanalyzed.

Legacy rows may resolve nearest standing anchors on demand from exact path evidence. That adapter
must retain the source generation and graph digests, all omission disclosures, and the same
source-security checks as current reads.

### Structure and architecture crosswalk

The standing atlas-index schema advances additively and contains an independent directory tree:

- repository root;
- root directories;
- nested parent/child directories;
- direct files for each directory;
- exact descendant file counts;
- directory-level aggregated dependency edges;
- file-to-directory membership;
- file-to-block and file-to-system membership; and
- block/system-to-directory dominant-membership crosswalks with explicit ties.

Architecture drills systems to blocks to files. Structure drills root directories to nested
directories to files. Response breadcrumbs, not a fixed UI taxonomy, describe the current path.

Cross-lens selection continuity uses:

1. exact file identity;
2. exact server-provided dominant membership;
3. all tied candidates with an explicit ambiguous state; or
4. nearest parent/root with an unmatched disclosure.

The client never matches labels or invents a semantic component spanning directories. The current
systems/blocks model remains an authored-or-inferred bounded architecture, not the deferred
editable semantic platform.

### ArchitectureStandingAnchor version 1

Each anchor pins an exact ArchitectureStandingSource and has one of four states:

| Status | Required behavior |
| --- | --- |
| matched | Open the pinned Map in the prescribed lens and focus the exact candidate. |
| ambiguous | Open the pinned Map with every exact candidate highlighted and state that no unique match exists. |
| unmatched | Open the pinned Map at the nearest existing parent/root and show **Not present in this repository generation**. |
| stale | Keep the original generation when it is available; otherwise require the user to open an explicit newer projection. Never silently rebind. |

Resolution order is exact file membership, longest directory prefix, exact system/block
membership, then unmatched. Labels are never identity. Semantic nodes prefer Architecture;
file/directory/provisional-path nodes prefer Structure. Relationship anchors use the broadest
common exact semantic candidate; ties are ambiguous.

Planned path hints open the normal workspace Files surface with Planned wording because no
immutable source bytes exist. Verified source evidence continues through retained immutable
proposal/diff selectors.

### ArchitectureConcernContext version 1

The locally persisted draft value contains only bounded structured data:

- exact architecture resource identity;
- product authority and exact publication/projection or generation reference;
- selected node or edge ID, label, level, relationship kind, and state;
- anchor status and pinned standing source/candidates;
- bounded changed-first evidence references;
- freshness and reverted state;
- exact totals plus omission metadata; and
- a stable deduplication key.

Draft bounds are independent of the graph transport bounds: at most 12 architecture contexts per
draft, 32 KiB of canonical JSON per context, 128 KiB total canonical architecture-context data per
draft, and 24 changed-first evidence entries per context. Persisted labels and disclosures are
clamped to 1,000 characters before the byte cap is applied. Exact source identities, anchor ties,
totals, and omission counts are never truncated to make a context fit; a context that still exceeds
the cap after evidence reduction is rejected.

The deduplication key is resource identity plus authority reference plus selection ID. Context is
scoped by environment and draft/thread identity. Adding it from the details drawer only creates a
composer chip; it never sends, mutates a proposal, publishes architecture, or dispatches a turn.

Composer draft storage advances from version 10 to 11. Migration is additive:

- valid existing fields are preserved;
- valid architecture contexts are normalized and retained;
- malformed individual architecture contexts are dropped;
- one malformed context never discards the draft; and
- older storage with no context becomes an empty list.

The context participates in content/sendability checks, removal, draft promotion, slash-command
handling, send snapshots, failure restoration, and retry. A bare provider slash command remains
bare only when every attachment/context collection, including architecture contexts, is empty.

Send serialization order is:

1. terminal contexts;
2. element contexts;
3. preview annotations;
4. architecture contexts; and
5. review comments.

Each context is emitted exactly once as escaped, quoted data inside an
<architecture_context> block. Timeline parsing peels the blocks in exact reverse order. Provider
or evidence text is never interpreted as markup, an instruction, or a trusted path.

## Persistence and durable admission

### Migration 070

Migration 070 is additive and does not edit historical migrations. It creates:

| Table or column | Purpose |
| --- | --- |
| architecture_planned_impact_publications | Immutable provider claims, server authority, plan identity, revision, digest, canonical payload, and timestamps. |
| architecture_planned_impact_projections | Immutable provisional/anchored projection revisions and exact standing source. |
| proposal_revision_planned_impacts | One exact optional proposal-revision-to-publication link. |
| architecture_analysis_admissions | Durable unique work admission, lease, retry, and terminal outcome. |
| proposal_generations.impact_projection_path | Nullable sealed semantic artifact path for new/legacy coexistence. |
| proposal_generations.architecture_admission_key | Exact durable admission identity for server-owned Verified attempts. |
| diff_analysis_generations.impact_projection_path | Nullable sealed semantic artifact path for new/legacy coexistence. |

Required uniqueness:

- publication ID primary key;
- thread + plan identity + publication revision;
- thread + plan identity + content digest;
- publication + projection revision;
- proposal revision ID in the link table; and
- admission key.

Every JSON column is decoded through a strict contract before use. Digests have lowercase SHA-256
checks, revisions are positive, counts are nonnegative, timestamps are ISO values, and foreign
keys cascade only with their owning proposal/publication. Historical exact resources remain
readable until their existing retention policy removes the owning data.

### Transaction boundaries

Planned publication admission is one transaction:

1. validate current MCP authority and plan/orchestrate revision;
2. normalize and digest the bounded payload;
3. return an existing publication for an identical retry or allocate a new immutable revision;
4. insert provisional/no-impact projection revision 1; and
5. create or reuse the unique standing-anchor admission.

Proposal revision admission is one transaction:

1. append blobs, proposal revision, and existing plan/orchestrate link;
2. resolve and link the exact current Planned publication when present; and
3. create or reuse the unique Verified-generation admission.

If any write fails, none of the publication/projection/link/admission rows become visible.
Background fibers start only after transaction commit.

### Admission state machine

Architecture analysis admission uses:

    queued -> leased -> complete
                    -> retry-wait -> leased
                    -> terminal-failed
                    -> cancelled

Each row records kind, unique key, exact target JSON, state, attempt count, lease owner/expiry,
next-attempt time, last low-cardinality error class/code, and timestamps.

- Verified unique key: proposal revision ID plus analyzer fingerprint.
- Planned-anchor unique key: publication ID plus publication revision.
- A live lease may be renewed but never stolen.
- Startup recovery requeues queued, retry-wait-due, and expired-lease rows.
- Transient process, lock, standing-build, and bounded I/O failures retry with capped backoff.
- Invalid identity, invalid payload/artifact, missing retained authority, and explicit cancellation
  are terminal.
- Explicit retry requeues the same admission only when the exact target remains authorized; a new
  analyzer fingerprint creates a new exact admission/generation.
- Existing proposal-generation and standing-map single-flight/cache rules remain authoritative
  below admission.

After the server path is proven by focused tests and recovery evidence, both client-owned
automatic proposal-generation effects are deleted. Clients continue to observe status, poll
boundedly, preserve last-good pinned results, and expose explicit retry.

### Lifecycle rules

| Event | Active lookup | Already-open exact resource |
| --- | --- | --- |
| Identical Planned retry | Same publication/revision. | Unchanged. |
| Changed Planned payload | New publication revision supersedes prior active lookup. | Remains pinned; newer version offered. |
| Anchoring completes | Latest lookup prefers anchored projection. | Provisional remains pinned; anchored version offered. |
| Proposal preview links Planned | Exact publication ref is fixed on proposal revision. | No later publication can replace it. |
| Verified retry | New exact generation attempt. | Earlier generation remains pinned; retry offered as newer result. |
| Proposal revision changes | New descriptor resolves only the new revision. | Older resource remains pinned. |
| Plan reverts | Removed from active lookup. | Planned and Verified remain read-only with Reverted label. |
| Standing generation advances | New Map resource is available. | Existing Map/anchor stays pinned and may advertise an explicit update. |
| Standing source unavailable | No silent rebind. | Anchor is stale; explicit newer projection required. |

## Schema and compatibility version ledger

| Surface | Live baseline | Rescue decision |
| --- | --- | --- |
| Cartographer graph | version 4 | Keep version 4; semantic projection is separate. |
| Atlas index | version 5 | Advance to version 6 for nested directories and crosswalks; strict v5 legacy reads remain. |
| analyze-trees ready manifest | version 1 | Emit version 2 with impact-projection.json; read version 1 as legacy. |
| ArchitectureImpactResult | raw v1 or exact v2 | Preserve decoding and method; never add Planned to this union. |
| Repository Map/Scope result | version 1 | Preserve legacy arm; projectionVersion 2 returns ArchitectureGraphProjection v1. |
| Planned publication | absent | Introduce strict version 1. |
| ArchitectureGraphProjection | absent | Introduce strict version 1. |
| Impact resource descriptor | comparison target only | Add exact version-1 descriptor while preserving legacy comparison targets. |
| Project Atlas metadata | version 2 | Preserve; only index schema/digest changes. |
| Right-panel local storage | version 12 | Preserve unless exact migration evidence requires a bump. |
| Composer draft local storage | version 10 | Advance to version 11 with additive per-context recovery. |

## Visual contract

The existing interface and the approved preservation rules are the visual reference. No generated
new aesthetic may replace them. Presentation work starts from:

- the architecture token family in [index.css](../apps/web/src/index.css);
- dot-grid canvas and stable tinted card geometry;
- curved weighted edges with generous hit targets;
- compact header/status hierarchy;
- minimap and camera controls;
- the shared compact drawer/narrow sheet; and
- the normal right-panel tabs and explicit maximize control.

The architecture-surface breakpoint is measured width 640 px, not browser width.
[useArchitectureSurfaceNarrow.ts](../apps/web/src/components/architecture/useArchitectureSurfaceNarrow.ts)
remains the authority. Browser widths at or below 980 px use the right-panel sheet. At a 760 px
browser viewport that sheet is approximately 384 px wide.

### Wide target fixture

Viewport and resource:

- browser viewport 1440 x 900;
- user has explicitly maximized the inline right panel;
- architecture content area is at least 1024 x 700;
- active resource is exact Impact Diff for a cross-area proposal;
- exact Planned and Verified candidates are both captured;
- Verified is selected and labeled Verified Impact;
- the Verified candidate is stale, so a compact warning is visible without changing authority;
- graph contains at least six nodes so the minimap branch is visible; and
- one added relationship is selected.

Composition:

    +--------------------------------------------------------------------------+
    | Impact Diff   [Verified | Planned]   stale evidence   base -> proposed    |
    | Architecture / System > Runtime        2 relationships + 1 consumer      |
    |--------------------------------------------------------------------------|
    | changed/returned/omitted disclosure                                      |
    |                                                                          |
    |   [context] ----added----> [added] ----affected----> [affected consumer]  |
    |       \                         curved weighted relationships             |
    |        \----removed----> [removed]                                       |
    |                                                                          |
    | [zoom -] [100% reset] [zoom +] [fit]             [minimap]               |
    |                                            +---------------------------+ |
    |                                            | Added relationship        | |
    |                                            | evidence, counts, state   | |
    |                                            | Open source               | |
    |                                            | View in Repository Map    | |
    |                                            | Add concern to composer   | |
    |                                            +---------------------------+ |
    +--------------------------------------------------------------------------+

Required visual behavior:

- one overlaid graph only;
- green added, red removed, amber affected, muted context;
- text state plus badge/icon/stroke/dash independently conveys every state;
- exact stats and omissions remain above the graph;
- breadcrumbs and the Architecture lens are response-driven;
- controls use the shared canvas placement and labels;
- minimap is present only when size and node count justify it;
- no Before, After, List, comparison split, or health dashboard control; and
- the drawer does not replace or resize the graph.

Focus sequence:

1. Right-panel tab semantics identify the active Impact Diff resource.
2. One node and one edge participate in the roving focus model.
3. Arrow, Home, and End navigation move and center the focused item.
4. Enter/Space or click selects without navigating.
5. The wide drawer is a nonmodal region.
6. Escape or Close returns focus to the exact graph trigger.
7. **Add concern to composer** adds a chip and leaves focus in the resource; it does not send.

### Narrow target fixture

Viewport and resource:

- browser viewport 760 x 900;
- right panel is the normal sheet at approximately 384 px;
- architecture surface measures below 640 px;
- same exact descriptor, authority, graph, and selected relationship as the wide fixture; and
- the panel was neither auto-opened nor maximized.

Composition:

    +--------------------------------------+
    | Impact Diff                          |
    | [Verified | Planned]   stale         |
    | Architecture > Runtime               |
    |--------------------------------------|
    | exact totals in a 2 x 2 compact grid |
    | omission disclosure                  |
    |                                      |
    |   pannable fixed-card graph           |
    |                                      |
    | [ - ] [reset] [ + ] [fit]            |
    +--------------------------------------+
       selection opens the standard focus-trapped details sheet

Required narrow behavior:

- header and authority controls wrap without document-level horizontal overflow;
- stats use two columns for Impact and compact rows for Map;
- graph pan, wheel/gesture zoom, fit, keyboard selection, and fixed cards remain available;
- minimap is hidden;
- the details Sheet traps focus, stacks actions, and returns focus to the exact trigger;
- closing details preserves graph selection; and
- omissions and banners never cover camera controls.

### Repository Map fixture state

The same wide/narrow viewports also exercise an exact standing generation:

- visible tab/title is Repository Map;
- header retains repository name, scope, Git ref, exact generation/freshness, Reload, and explicit
  newer-map action when applicable;
- the product health toggle/dashboard is absent;
- peer Architecture and Structure lens controls are present;
- Architecture starts at systems and drills through response breadcrumbs to blocks/files;
- Structure starts at root directories and drills through nested directories/files;
- selection opens details first; drill/navigation is an explicit action;
- switching lenses retains an exact file or dominant membership, or states ambiguity;
- Map node/edge grammar, camera, minimap rules, and drawer match Impact;
- matched handoff focuses one node, ambiguous handoff highlights all exact candidates, unmatched
  handoff focuses the nearest parent/root with the absence banner, and stale handoff stays pinned.

### Non-hero fixtures

Each is a separate state rather than stacked chrome:

| State | Contract |
| --- | --- |
| Planned provisional | Opens immediately without Map, says Planned, and may advertise Anchored version available. |
| Planned no-impact | Direct confirmed no-impact text and no graph action. |
| Verified pending | Exact revision progress plus Retry; no stale unrelated graph. |
| Verified corrupt/missing | Fail-closed error and Retry; never Planned fallback. |
| Both authorities | Verified default; Planned separately inspectable. |
| Reverted | Exact read-only resource with Reverted label and no active lookup. |
| Map stale | Pinned map visible with one explicit update action. |
| Anchor unmatched | Nearest parent/root plus not-present banner. |
| Narrow details | Focus-trapped sheet with all three actions reachable. |
| Legacy server | Rescued controls hidden; invisible current adapter renders supported resource. |

## Implementation phases

### Phase 0 — Reconciliation and visual contract

Scope:

- add this tracked plan and register it in .plans/README.md;
- freeze keep/adapt/retire ownership, authority rules, versions, bounds, state machines, visual
  fixtures, compatibility, and acceptance;
- record live branch/SHA and focused baseline evidence;
- read the vendored Effect guidance before later Effect services/reactors; and
- make no product-code or test changes.

Done means:

- the plan is self-contained and does not depend on ignored screenshots;
- every product question identified during repository reconciliation has an explicit decision;
- historical plans remain unchanged;
- Markdown formatting and git diff checks pass; and
- the checkout diff contains only this plan and its README registration.

### Phase 1 — Persistence, tools, and durable admission

Primary implementation:

- add strict Planned contracts, digests, projection/publication/reference DTOs, MCP tool, toolkit
  registration, and provider guidance;
- add Migration 070 and repository services for publications, projections, proposal links, and
  admission leases;
- make publication + provisional projection + anchor admission transactional;
- make proposal revision + Planned link + Verified admission transactional;
- add startup recovery and background worker composition;
- reuse existing generation/standing single-flight behavior;
- expose server-owned explicit retry;
- prove server admission before deleting both client auto-start effects; and
- keep the new capability absent/false until the V2 path is usable.

Likely owned files:

- packages/contracts/src/architectureTools.ts;
- packages/contracts/src/architectureProjections.ts;
- packages/contracts/src/proposal.ts;
- packages/contracts/src/environment.ts and rpc.ts;
- apps/server/src/mcp/toolkits/architecture;
- apps/server/src/provider/CollaborationModeInstructions.ts;
- apps/server/src/proposal/ProposalRepository.ts and ProposalService.ts;
- apps/server/src/persistence/Migrations.ts and Migration 070;
- new focused planned-publication/admission services under apps/server/src; and
- server layer/startup composition.

Major focused tests:

- strict Planned payload bounds, exact keys, canonical byte cap, path traversal, duplicate IDs,
  dangling endpoints, outcome invariants, and old-provider decoding;
- identical retry versus changed revision under concurrency;
- proposal revision exact link and missing-Planned compatibility;
- publication/projection/admission transaction rollback;
- lease recovery, transient retry, terminal classification, and startup recovery;
- active Plan/Orchestrate authority and spoofed identity rejection;
- reverted active lookup versus exact historical read; and
- provider guidance order: Planned publication, Proposal Preview when concrete, final plan.

Gate:

- Migration 070 and lineage tests;
- focused contracts/MCP/proposal/admission tests;
- Cartographer core build before any server typecheck/tests;
- affected contracts/server typechecks and lint/format/comments;
- git diff --check; and
- no client auto-start removal until server recovery proof passes.

### Phase 2 — Analyzer and projection authority

Primary implementation:

- define shared ArchitectureGraphProjection codecs and exact descriptor/read contracts;
- advance analyze-trees manifest to version 2 and emit sealed impact-projection.json;
- implement the fixed adaptive semantic algorithm and no-impact result;
- persist and validate semantic artifacts for proposal and diff generations;
- advance atlas-index schema to version 6 with nested directories, aggregated directory edges,
  direct files, and crosswalks;
- serve V2 Map/Scope projections while retaining current legacy arms;
- implement exact standing anchor resolution and legacy on-demand path anchoring; and
- leave legacy rows readable without reanalysis or Planned reinterpretation.

Likely owned files:

- packages/cartographer-core/src/cli/commands/analyzeTrees.ts;
- new focused projection builder/codec modules under packages/cartographer-core/src;
- packages/cartographer-core/src/store/atlasIndex and contracts/types.ts;
- packages/contracts/src/architectureProjections.ts and rpc.ts;
- apps/server/src/proposal/ProposalGenerationService.ts;
- apps/server/src/cartographer/DiffAnalysisService.ts;
- apps/server/src/cartographer/ArchitectureProjectionService.ts;
- apps/server/src/cartographer/ArchitectureQueryService.ts; and
- client-runtime query atoms for the additive methods.

Major focused tests:

- six canonical projection cases;
- adaptive level selection and one-hop context bounds;
- semantic added/removed versus surviving affected classification;
- exact totals before hero truncation;
- base/head position reuse and deterministic layout;
- no-impact with exact changed-file count;
- manifest/artifact containment, digest, tree, codec, reference, and bound rejection;
- nested directory hierarchy, aggregation, crosswalk ties, and v5 legacy read;
- matched, ambiguous, unmatched, and stale anchors; and
- legacy raw Impact fallback with no current-byte access.

Gate:

- build Cartographer core;
- focused core contract/index/analyze tests;
- focused server projection/query/generation tests;
- affected core/contracts/client-runtime/server typechecks;
- targeted lint/format/comments and git diff --check; and
- fixture artifacts demonstrate deterministic bytes across two identical runs.

### Phase 3 — Shared canvas and Impact centerpiece

Primary implementation:

- extract mechanism-only ArchitectureGraphCanvas from ArchitectureCanvas;
- define generic scene node/edge/selection types without resource, query, authority, lens, drawer,
  source-action, or isImpact props;
- keep separate Map, Impact, and Scope adapters/presenters;
- move Impact to the shared canvas and retire its private GraphView;
- preserve deterministic change layout, exact stats, omissions, evidence, and source routing;
- add one shared node/edge detail presenter with Planned/Verified-specific actions;
- add compact proposal/plan summaries and explicit Open Impact Diff;
- hide graph action for confirmed no-impact;
- resolve exact immutable descriptors and implement Verified-default authority switching; and
- never auto-open, auto-maximize, replace Proposal Review, or compare authorities.

Likely owned files:

- apps/web/src/components/architecture/ArchitectureCanvas.tsx;
- a new ArchitectureGraphCanvas.tsx and focused scene model;
- ArchitectureBoundedView.tsx;
- ArchitectureImpactSurface.tsx and architectureImpactModel.ts;
- ArchitectureDetailsDrawer.tsx only if its generic action slots require a small additive change;
- ConnectedArchitectureImpactSurface.tsx;
- proposal review, ProposedPlanCard, OrchestratePlanCard, and ChangedFilesTree launch surfaces;
- architecture resource identity and right-panel tabs; and
- corresponding client-runtime query use.

Major focused tests:

- canvas node/edge selection, camera reset/fit, minimap bounds, hit targets, roving keyboard focus,
  and stable scene identity;
- text/badge/stroke state semantics independent of color;
- wide drawer and narrow sheet focus return;
- omission and hero bounds;
- Planned-only, Verified-only, both-ready default/switch, stale Verified, no-impact, pending, and
  exact revision/newer-version behavior;
- no automatic panel open/maximize and Proposal Review remains mounted; and
- old comparison resources on V2 and old servers.

Gate:

- focused shared-canvas/Impact/proposal/right-panel tests;
- web typecheck;
- targeted lint/format/comments and git diff --check;
- rendered wide and narrow comparison against the Phase 0 fixtures; and
- no removal of the old renderer until shared-canvas acceptance passes.

### Phase 4 — Repository Map, Structure, anchors, and concern context

Primary implementation:

- rename every visible Atlas/Cartographer/Open graph diff entry to the locked product vocabulary;
- replace fixed level product controls with Architecture/Structure lens plus breadcrumbs;
- implement independent Structure traversal and cross-lens continuity;
- route source, exact anchor handoff, ambiguity highlighting, unmatched banners, and stale behavior;
- remove product health-dashboard chrome while retaining backend diagnostic data;
- add Add concern to composer from the shared details surface;
- implement ArchitectureConcernContext persistence v11, chips, dedupe, removal, promotion,
  sendability, retry restoration, slash handling, exact-once serialization, and reverse peeling;
- keep camera state local and unpersisted; and
- preserve right-panel storage version 12 unless migration tests prove a bump is required.

Likely owned files:

- RepositoryAtlasSurface.tsx, RepositoryAtlasBootstrap.tsx, ArchitectureScopeSurface.tsx;
- ArchitectureZoomControl.tsx replacement and lens/breadcrumb components;
- ChatView.tsx and RightPanelTabs.tsx;
- SidebarV2, command palette, proposal/orchestrate cards, and architecture availability copy;
- composer-drafts/persistence.ts and runtime.ts;
- ChatComposer.tsx and useChatDispatchController.ts;
- a focused architectureContext helper/parser/presenter; and
- rightPanelStore.ts and architectureResourceIdentity.ts additive decoding.

Major focused tests:

- Architecture and Structure traversal, breadcrumbs, continuity, ties, camera locality, and
  generation pinning;
- all anchor states and source routes for semantic, file/directory, provisional, and relationships;
- visible terminology and no main health dashboard;
- concern add/remove/dedupe and environment/thread isolation;
- draft v10 to v11 migration with per-item corruption recovery;
- exact-once send order, timeline peeling, failure restore, retry, promotion, and slash commands;
- graph action adds a chip without dispatch; and
- old right-panel version-12 resources decode.

Gate:

- focused Map/Scope/anchor/composer/right-panel tests;
- web typecheck;
- targeted lint/format/comments and git diff --check;
- rendered wide/narrow Map and concern-flow comparison against Phase 0 fixtures; and
- a classified branding search with only internal/historical exceptions.

### Phase 5 — Compatibility, retirement, documentation, and metrics

Primary implementation:

- set architectureGraphViewsV2 true only after all V2 server handlers are composed;
- keep old-server adapters invisible and delete all now-unused duplicate Impact/Map presenters;
- update architecture, desktop, workspace-layout, and Cartographer integration docs;
- add an amendment/current plan only; never rewrite completed historical plans;
- add low-cardinality authority, result, anchor, lens, freshness, omission, and admission metrics;
- keep metric attribute construction closed to low-cardinality product state; and
- finish the implementation inventory without running the deferred verification gates.

Major focused tests:

- capability absent/false/true behavior;
- existing comparison-bound Impact and repository-atlas resources;
- legacy Impact V1/V2, old proposals, v5 indexes, and manifest-v1 generations;
- metrics cardinality and prohibited label absence;
- Electron protocol/window/lifecycle behavior; and
- docs/branding source-of-truth checks.

Gate:

- the V2 implementation, compatibility adapters, maintained docs, and closed metric attributes are
  present;
- no implementation item remains assigned to Phases 2 through 5; and
- the ledger moves to Phase 6 without claiming any deferred check or acceptance result.

### Phase 6 — Consolidated verification and acceptance

Primary verification:

- add or update only the major focused tests needed for the completed implementation;
- build Cartographer core before server tests or typechecks;
- run the focused contracts, core, server, web, and desktop files listed below;
- run affected package typechecks and targeted lint, formatting, comment-style, and diff checks;
- exercise all six canonical proposal cases and the immutable Planned/Verified lifecycle cases;
- run one isolated `test-t3-app` pass through proposal summary, Impact Diff, Repository Map,
  Structure, source routing, concern persistence, send, narrow sheet, and focus return;
- run focused Electron protocol/window/lifecycle tests plus desktop build and smoke verification;
  and
- stop every temporary server, watcher, and browser environment.

Gate:

- every required focused command and integrated acceptance item has recorded evidence;
- branding results contain only classified internal or historical exceptions;
- no mobile pass is run;
- the exact acceptance ledger and residual risks are closed; and
- this plan moves to completed only if every required gate passes.

## Focused acceptance ledger

Tests remain under the root tests tree and mirror source ownership with src removed. New modules are
covered only where behavior is important and breakable. Trivial accessors, pure display copy,
compiler-guaranteed shapes, every numeric boundary permutation, and pixel snapshots are
deliberately excluded.

### Baseline command set

The 123-test baseline came from the following focused surfaces at the starting SHA:

```text
vp test run \
  tests/apps/web/components/architecture/ArchitectureImpactSurface.test.tsx \
  tests/apps/web/components/architecture/ConnectedArchitectureImpactSurface.test.tsx \
  tests/apps/web/components/architecture/RepositoryAtlasSurface.test.tsx \
  tests/apps/web/components/chat/ProposedPlanCard.test.tsx \
  tests/apps/web/components/chat/proposalGenerationOwnership.test.tsx \
  tests/apps/web/components/chat/proposedPlanGenerationStart.test.ts

vp test run \
  tests/apps/server/cartographer/ArchitectureProjectionService.test.ts \
  tests/apps/server/cartographer/ArchitectureQueryService.test.ts \
  tests/apps/server/cartographer/ProposalGenerationService.test.ts \
  tests/apps/server/mcp/ArchitectureToolkit.test.ts

vp test run \
  tests/packages/contracts/architectureTools.test.ts \
  tests/packages/contracts/orchestrateArchitecturePaths.test.ts

vp test run \
  tests/packages/cartographer-core/analyzeTrees.test.ts \
  tests/packages/cartographer-core/store/atlasIndex/build.test.ts
```

If exact test allocation changes while a phase is implemented, this ledger records the final
commands and counts instead of retaining an inaccurate command.

### Phase 1 focused verification

The final Phase 1 test allocation was broader than the initial estimate because durable retry,
thread deletion, WebSocket compatibility, and shared-renderer ownership each required a focused
regression seam. The final commands were:

```text
./node_modules/.bin/vp test run \
  tests/packages/contracts/plannedArchitectureImpact.test.ts \
  tests/packages/contracts/architectureTools.test.ts \
  tests/packages/contracts/cartographer.test.ts \
  tests/packages/contracts/environmentHttp.test.ts \
  tests/packages/contracts/proposal.test.ts

./node_modules/.bin/vp test run \
  tests/apps/server/architecture/ArchitectureAdmissionRepository.test.ts \
  tests/apps/server/architecture/ArchitectureAdmissionService.test.ts \
  tests/apps/server/architecture/PlannedImpactService.test.ts \
  tests/apps/server/cartographer/ProposalGenerationService.test.ts \
  tests/apps/server/environment/ServerEnvironment.test.ts \
  tests/apps/server/mcp/ArchitectureToolkit.test.ts \
  tests/apps/server/mcp/ProposalToolkit.test.ts \
  tests/apps/server/mcp/toolkits/architecture/tools.test.ts \
  tests/apps/server/orchestration/Layers/ThreadDeletionReactor.test.ts \
  tests/apps/server/persistence/Migrations/070_NativeArchitectureViews.test.ts \
  tests/apps/server/proposal/ProposalRetainedRefReconciliation.test.ts \
  tests/apps/server/proposal/ProposalService.test.ts \
  tests/apps/server/provider/CollaborationModeInstructions.test.ts \
  tests/apps/server/server.test.ts \
  tests/apps/server/ws/handlers/proposalHandlers.test.ts

./node_modules/.bin/vp test run \
  tests/apps/server/persistence/Migrations/MigrationLineage.test.ts

./node_modules/.bin/vp test run \
  tests/apps/web/components/architecture/ArchitectureImpactSurface.test.tsx \
  tests/apps/web/components/architecture/ConnectedArchitectureImpactSurface.test.tsx \
  tests/apps/web/components/chat/ProposedPlanCard.test.tsx \
  tests/apps/web/components/chat/proposalGenerationOwnership.test.tsx \
  tests/apps/web/components/chat/proposedPlanGenerationStart.test.ts \
  tests/apps/web/components/explorer/ConnectedExplorerPanel.resource.test.tsx \
  tests/apps/web/components/explorer/ConnectedExplorerPanel.test.ts
```

Final results were 27 contract tests, 159 server tests, and 28 web tests: 214 focused tests in
total. Cartographer core was rebuilt before the final server typecheck. Contracts, server, web,
and desktop typechecks passed; their existing Effect suggestion diagnostics remained nonfatal.
Targeted lint, formatting, JS/TS comment style, and `git diff --check` passed.

High-value assertions:

- a spoofed, traversal, oversized, malformed, or wrong-turn publication cannot persist;
- same digest is idempotent and distinct digest appends exactly one revision under concurrency;
- publication, provisional projection, and admission are all-or-nothing;
- proposal revision, exact Planned link, and Verified admission are all-or-nothing;
- expired lease startup recovery starts one generation, not two;
- terminal identity/artifact failures do not retry;
- revert removes active lookup without destroying exact history; and
- existing proposal payloads decode and persist unchanged.

### Deferred Phase 2 verification inventory

Run this inventory only in final Phase 6, after the remaining product phases are implemented.

```text
vp test run \
  tests/packages/cartographer-core/analyzeTrees.test.ts \
  tests/packages/cartographer-core/analyze/impactProjection.test.ts \
  tests/packages/cartographer-core/store/atlasIndex/build.test.ts \
  tests/packages/cartographer-core/store/atlasIndexPersistence.test.ts \
  tests/packages/contracts/architectureProjections.test.ts \
  tests/apps/server/cartographer/ArchitectureProjectionService.test.ts \
  tests/apps/server/cartographer/ArchitectureQueryService.test.ts \
  tests/apps/server/cartographer/ProposalGenerationService.test.ts \
  tests/apps/server/cartographer/DiffAnalysisService.test.ts \
  tests/apps/server/cartographer/architecturePathResolver.test.ts
```

High-value assertions:

- adaptive selection is broad for cross-system and narrow for contained changes;
- a surviving semantic unit is affected, not falsely added/removed;
- API consumers become amber affected evidence;
- implementation-only change produces exact no-impact;
- layout and artifact bytes are deterministic;
- exact totals survive truncation;
- corrupt identity/digest/containment/reference/bounds fail closed;
- nested directories and tie crosswalks are exact; and
- manifest-v1/index-v5 legacy rows remain readable without reanalysis.

### Deferred Phase 3 and 4 web verification inventory

Run this inventory only in final Phase 6.

```text
vp test run \
  tests/apps/web/components/architecture/ArchitectureGraphCanvas.test.tsx \
  tests/apps/web/components/architecture/ArchitectureImpactSurface.test.tsx \
  tests/apps/web/components/architecture/ConnectedArchitectureImpactSurface.test.tsx \
  tests/apps/web/components/architecture/RepositoryAtlasSurface.test.tsx \
  tests/apps/web/components/architecture/ArchitectureScopeSurface.test.tsx \
  tests/apps/web/components/architecture/ArchitectureSourceFilePanel.test.tsx \
  tests/apps/web/components/RightPanelTabs.test.tsx \
  tests/apps/web/rightPanelStore.test.ts \
  tests/apps/web/components/chat/ProposedPlanCard.test.tsx \
  tests/apps/web/components/chat/orchestrate-plan/OrchestratePlanCard.test.ts \
  tests/apps/web/composerDraftStore.test.ts \
  tests/apps/web/components/chat/composer/composerSubmission.test.ts \
  tests/apps/web/components/ChatView.logic.test.ts
```

High-value assertions:

- shared camera/selection/focus mechanics do not fork by presenter;
- scene IDs and tint keys remain stable between Map and Impact;
- all four change states are non-color-readable;
- Planned/Verified selection never crosses exact revisions;
- no-impact has no graph action and opening never hijacks/maximizes;
- anchors navigate honestly for all four statuses;
- lens continuity uses exact identity or explicit ambiguity;
- concern chips persist, dedupe, restore, serialize once, and never auto-dispatch; and
- old version-12 right-panel resources survive.

### Deferred package checks

Run only affected packages in final Phase 6:

    vp run --filter @t3tools/cartographer-core build
    vp run --filter @t3tools/contracts typecheck
    vp run --filter @t3tools/cartographer-core typecheck
    vp run --filter @t3tools/client-runtime typecheck
    vp run --filter 456code typecheck
    vp run --filter @t3tools/web typecheck
    vp run --filter @t3tools/desktop typecheck

Server tests/typecheck always follow the Cartographer core build. Do not run root-wide vp check,
vp run typecheck, vp run test, or an equivalent full workspace suite locally.

Run targeted changed-file checks once in final Phase 6:

    pnpm exec prettier --check <changed files>
    vp lint <changed source and test files>
    node scripts/check-js-comments.ts <changed JS/TS files>
    python3 scripts/check_comment_style.py --check --headers <changed owned files>
    git diff --check

### Deferred integrated web acceptance

The primary agent runs one isolated environment with the test-t3-app skill in final Phase 6.
Authenticate through the environment's printed one-time pairing URL, use the controlled browser,
and stop all processes at the end.

One coherent path must prove:

1. proposal summary shows an authority-aware result and does not auto-open;
2. Open Impact Diff creates an exact resource and Verified is default when both exist;
3. keyboard-select the added relationship in the shared canvas;
4. inspect evidence in the drawer and open exact source;
5. return, use View in Repository Map, and verify the anchor banner/focus;
6. switch Architecture to Structure while preserving or honestly disclosing selection;
7. add the selected concern to the composer and verify no turn was dispatched;
8. reload and verify the chip persists;
9. send once and verify one architecture_context block;
10. exercise the 760 x 900 narrow details sheet and focus return.

The pass also checks the wide fixture at 1440 x 900 with explicit maximize, minimap, fit/reset,
omission disclosure, and no Before/After/List/health controls.

### Deferred Electron acceptance

After the web pass:

```text
vp test run \
  tests/apps/desktop/electron/ElectronProtocol.test.ts \
  tests/apps/desktop/electron/ElectronWindow.test.ts \
  tests/apps/desktop/app/DesktopLifecycle.test.ts

pnpm run build:desktop
pnpm run test:desktop-smoke
```

The desktop gate verifies renderer loading, architecture resource persistence across window
lifecycle, protocol/source navigation, maximize/restore, and cleanup. It does not duplicate the
web visual test. Mobile is explicitly excluded.

## Canonical product cases

### Case 1 — Cross-area addition

- Planned identifies a new relationship between two publication-local objects.
- Provisional opens immediately, broad enough to show both areas.
- Verified later selects systems, marks the new edge added, and includes one context hop.
- Surviving endpoints are affected unless the unit itself exists only in head.
- Both share exact standing IDs where anchoring proves identity.

### Case 2 — Contained addition

- All changed endpoints remain within one block and one directory.
- Verified chooses directories or files, not an irrelevant repository-wide system graph.
- Context is limited to the changed endpoints and one useful consumer/provider hop.

### Case 3 — Removed relationship

- Removed edge uses base membership and base position.
- Both endpoints remain present as context/affected unless a unit itself was deleted.
- Red dash/stroke, Removed text, and evidence independently communicate the state.

### Case 4 — Public API change

- Changed API owner is affected.
- Exact current consumers from analyzer evidence are amber affected.
- Removed exports and bounded consumer evidence appear changed-first in the drawer.
- No provider rationale is presented as Verified evidence.

### Case 5 — Internal-only change

- Proposal manifest reports changed files.
- Semantic relationship/API projection reports no-impact.
- Proposal summary says **No architectural relationship changes** and includes changed-file count.
- There is no Open Impact Diff graph action.

### Case 6 — Revision change while open

- Open descriptor remains bound to the old proposal/publication/generation.
- Active plan lookup resolves the newer revision separately.
- The old surface advertises a newer exact version without changing authority or graph.
- Source reads remain from the old retained selector.

## Additional lifecycle acceptance

- Planned-only opens before any standing Map and later offers an anchored revision.
- Verified-only is normal when the provider did not publish Planned data.
- Both-ready defaults to Verified; stale Verified still defaults with warning.
- Planned is never styled, worded, or sourced as analyzer evidence.
- New, removed, and unanchored objects navigate to honest nearest standing context.
- Matched, ambiguous, unmatched, and stale anchor banners/actions match their contracts.
- Concern context survives reload but remains unsent until a user send.
- Reverted resources remain exact, historical, and read-only.
- A corrupt Verified artifact never falls back to Planned or current workspace bytes.
- Old servers and old resources remain usable through invisible adapters.

## Branding and documentation gate

Update maintained:

- docs/integrations/cartographer.md;
- docs/architecture/overview.md;
- docs/architecture/desktop.md; and
- docs/reference/workspace-layout.md.

Historical .plans/26-cartographer-absorption.md and .plans/27-native-architecture-impact.md are not
rewritten. Their obsolete product names remain historical evidence.

Run:

```text
rg -n "Repository Atlas|Open graph diff|Cartographer" \
  apps/web/src \
  apps/desktop/src \
  docs/integrations/cartographer.md \
  docs/architecture/overview.md \
  docs/architecture/desktop.md \
  docs/reference/workspace-layout.md
```

Every remaining hit must be classified as an internal symbol/resource/RPC/core engine name or a
diagnostic/developer statement. No visible label, command, loading state, error, tooltip, action,
or maintained product description may retain unintended branding.

## Metrics contract

Allowed low-cardinality dimensions:

- authority: standing, planned, verified;
- result: graph, no-impact, pending, unavailable, failed;
- anchor: matched, ambiguous, unmatched, stale, none;
- lens: architecture, structure;
- freshness: fresh, dirty, stale, reverted;
- omission: none, nodes, edges, evidence, multiple;
- admission kind: planned-anchor, proposal-verified; and
- admission outcome: queued, reused, complete, retry, terminal-failed, cancelled.

Forbidden labels:

- repository-relative or absolute paths;
- graph, proposal, plan, publication, generation, thread, project, or provider IDs;
- content or graph digests;
- provider rationale/summary;
- source/evidence text; and
- prompt/composer content.

Existing architectureImpactReadDuration remains. New counters/timers follow existing metric
ownership in apps/server/src/observability/Metrics.ts and are tested for label shape.

## Risk register and stop conditions

| Risk | Required control | Stop condition |
| --- | --- | --- |
| Authority collapse | Separate schemas, exact refs, explicit UI labels. | Any read would substitute Planned for Verified or cross revisions. |
| Provider spoofing | Exact-key codecs and server-derived authority. | Input can influence root/project/graph/standing identity. |
| Partial persistence | Transactional publication and proposal admission. | Any orphan link/projection/admission appears after failure. |
| Duplicate work | Unique admission keys, leases, existing single-flight. | Two active workers can analyze one exact key. |
| Corrupt evidence | Sealed artifacts, containment/digest/tree/codec checks. | Ready state can publish before all checks. |
| Semantic overclaim | Fixed current systems/blocks/dirs/files model and honest anchors. | UI claims deferred arbitrary semantic model or label-based identity. |
| Layout drift | Stable IDs/tints/positions and deterministic artifact tests. | Surviving nodes move without source/layout version change. |
| Unbounded UI | Exact totals, 60/120 hero caps, bounded evidence. | Presenter loads full graphs or derives totals from returned arrays. |
| Accessibility regression | Non-color states, roving focus, hit targets, drawer return. | Pointer-only action, color-only meaning, or lost focus. |
| Version skew | Optional capability and strict legacy adapters. | New client calls V2 against absent capability or old resource is dropped. |
| Draft injection | Strict bounded context, escaping, exact-once parser order. | Evidence/provider text can close the block or execute as trusted instruction. |
| Scope drift | Phase ledger and deferred list. | Implementation requires editable semantic model, mobile, or new graph dependency. |

If live code contradicts a locked contract, the phase stops and this plan is amended with the user
before widening scope.

## Execution ledger

| Phase | Status | Evidence |
| --- | --- | --- |
| 0 — Reconciliation and visual contract | complete | Tracked plan and README registration; Prettier, link-target validation, trailing-whitespace scan, scope audit, and git diff check pass. |
| 1 — Persistence, tools, durable admission | complete | Strict Planned tool/publications, Migration 070, exact proposal links, fenced durable admissions, startup recovery, server-owned explicit retry, and client auto-start retirement. 214 focused tests, four affected typechecks, static gates, and two isolated browser/database recovery passes succeeded. |
| 2 — Analyzer and projection authority | complete | Shared projection/artifact authority, Atlas V6, exact anchors, and legacy reads passed the deferred core, server, and artifact gates in Phase 6. |
| 3 — Shared canvas and Impact centerpiece | complete | Shared graph mechanics, authority UX, immutable resource identity, no-impact handling, focus behavior, and compatibility passed the deferred web and integrated gates in Phase 6. |
| 4 — Repository Map, Structure, anchors, concern context | complete | Peer lenses, honest handoffs, visible vocabulary, and draft-only concern context passed focused and integrated acceptance in Phase 6. |
| 5 — Compatibility, retirement, docs, metrics | complete | Capability rollout, invisible compatibility, maintained docs, metrics, branding, Electron, and static gates passed in Phase 6. |
| 6 — Consolidated verification and acceptance | complete | Focused tests, affected typechecks, static checks, isolated web acceptance, Electron tests/build/smoke, and cleanup passed. No mobile or full-workspace suite was run. |

## Phase 0 decision closeout

Repository reconciliation resolved every previously open product choice:

- Planned is a separate provider tool and append-only publication, not a Proposal Preview field or
  provider completion-event delta.
- Proposal revisions link exact publications; they never dynamically read latest thread plan.
- Verified is default when both exist; there is no side-by-side authority comparison.
- Planned context persists locally through reload and remains draft-only.
- Anchor order/status and stale behavior are fixed above.
- Structure is root directories to nested directories to files with exact crosswalks.
- Main product health chrome is removed.
- Missing Planned is normal; Verified-only remains first-class.
- Server admission owns automatic Verified starts; Planned admission triggers/reuses standing
  builds for anchors.
- Existing 200/400/100 projection and 2 MiB source bounds remain for their current endpoints;
  the new hero and provider bounds are independently 60/120/100 and 256 KiB.

Phase 1 was approved after this closeout and has now passed its gate.

## Phase 1 implementation closeout

Phase 1 delivered the server-owned admission foundation without exposing the unfinished V2
product:

- `architecture_plan_impact_upsert` now accepts only bounded publication-local claims under exact
  authenticated Plan or Orchestrate authority. Environment, project, thread, turn, provider,
  workspace, and plan identities remain server-derived.
- Planned claims, provisional/no-impact projections, immutable revisions, proposal links, and
  admissions persist transactionally. Identical normalized retries reuse exact content identity;
  changed claims append and supersede without mutation.
- Proposal revisions capture the current exact Planned publication when present and enqueue an
  exact Verified admission keyed by proposal revision and analyzer fingerprint in the same
  transaction. Missing Planned data remains compatible.
- Durable admissions use unique keys, leases, renewal, capped retry backoff, terminal
  classification, startup recovery, and immutable target identity. Missing or deleted thread
  lifecycle authority fails closed. Cancellation fences admission registration and the SQL
  transaction that inserts a generation or anchored projection.
- Explicit retry is server-owned. It reuses the exact admission for the same analyzer, creates a
  new exact admission when the analyzer fingerprint changes, rejects cancelled/deleted authority,
  and creates a fresh attempt rather than returning an earlier Ready row.
- Proposal generation cancellation now durably terminalizes queued, preparing, and analyzing rows
  for deleted threads. Historical Ready, failed, cancelled, abandoned, Planned, and proposal-linked
  resources remain readable.
- Provider guidance publishes Planned Impact before Proposal Preview and then emits the final plan.
  The optional `architectureGraphViewsV2` capability decodes but remains unadvertised until the
  rescued query/UI path exists.
- Both web mount-owned automatic generation effects were removed only after server recovery proof.
  The shared web/Electron renderer still polls, preserves pinned results, and exposes explicit
  Retry. Old proposal rows with no admission retain the invisible legacy manual-start fallback.

The first isolated `test-t3-app` pass proved that mounting the proposal card and Proposal Review
did not create a generation, while clicking Retry explicitly created one and reached Ready through
the older-proposal fallback. The second pass staged an exact completed admission whose linked
generation was `abandoned/server-restarted`; restarting the server requeued that admission,
created one newer exact generation, reached Ready, completed the admission, and rendered the
recovered result in Proposal Review. Both dev stacks were stopped after verification.

Residual Phase 1 notes:

- the local host used Node 26.7.0 while the workspace declares Node `^24.13.1`; the required build,
  typechecks, focused tests, and integrated passes still succeeded;
- semantic `impact-projection.json`, directory hierarchy, shared projection RPCs, and anchor
  resolution intentionally remain Phase 2 work; and
- full V2 capability rollout, Electron lifecycle/smoke acceptance, documentation/branding cleanup,
  and metrics intentionally remain Phase 5 work.

The user continued into Phase 2 and directed that further verification run only after all remaining
implementation phases, as final Phase 6.

## Phase 2 implementation closeout

Phase 2 implementation is complete, with verification intentionally unclaimed until Phase 6:

- `ArchitectureGraphProjection` now carries exact identities, textual and stroke state, bounded
  evidence, omissions, authority, freshness, lens, breadcrumbs, and pinned standing anchors.
- Analyze Trees emits manifest version 2 with a sealed semantic `impact-projection.json` while
  retaining raw graph and Impact evidence. Proposal and diff reads validate exact tree, graph,
  analyzer, raw-impact, projection, containment, digest, bound, and changed-file identities.
- The fixed adaptive projection algorithm selects systems, blocks, directories, or files from
  base/head memberships, retains one context hop, classifies surviving consumers as affected,
  reuses side-appropriate positions, and returns direct no-impact for implementation-only work.
- Atlas Index V6 adds nested directories, direct files, directory dependencies, and exact
  architecture/structure crosswalks. V5 rows remain readable through the Architecture adapter;
  V5 Structure fails with an explicit bounded compatibility state rather than reinterpretation.
- Authority-aware exact Impact reads, V2 Map/Scope arms, matched/ambiguous/unmatched/stale anchor
  resolution, deterministic ordering, dynamic pinned freshness, reverted active-lookup removal,
  and immutable newer-version signaling are implemented.

## Phase 3 implementation closeout

Phase 3 implementation is complete, with verification intentionally unclaimed until Phase 6:

- `ArchitectureGraphCanvas` owns only reusable camera, geometry, minimap, navigation, hit-target,
  focus, and accessibility mechanics. Map, V2 Impact, and legacy Impact retain independent scene
  adapters and product presenters.
- V2 Impact opens an immutable descriptor, defaults to exact Verified when both authorities exist,
  preserves stale/reverted disclosure, switches authorities without comparing them, exposes newer
  versions explicitly, and renders confirmed no-impact without a graph action.
- Proposal and Orchestrate plan cards show compact authority-aware summaries and explicit **Open
  Impact Diff** actions without auto-opening, maximizing, or replacing Proposal Review.
- Both V2 Map and V2 Impact use one shared node/edge fact presenter with resource-specific source,
  Repository Map, drill, concern, and evidence action slots. The legacy V1/V2 Impact adapter also
  uses the shared canvas; its private fixed SVG renderer is removed.

## Phase 4 implementation closeout

Phase 4 implementation is complete, with verification intentionally unclaimed until Phase 6:

- Visible architecture entry points now use **Repository Map**, **Impact Diff**, **Architecture**,
  and **Structure**. Internal RPC, type, resource, and Cartographer engine names remain compatible.
- Repository Map keeps an exact standing generation while Architecture drills systems to blocks to
  files and Structure drills root directories to nested directories to files. Breadcrumb identity
  fences include both ID and level, and camera state stays local.
- Cross-lens file and dominant-membership continuity preserves exact, ambiguous, unmatched, and
  stale states. Active-lens clicks preserve selection; unresolved cross-lens handoffs retain an
  explicit disclosure instead of silently dropping context.
- The standing health dashboard is removed from the product surface while compact freshness and
  actionable build/retry failures remain. V2 plan actions open the rescued Repository Map rather
  than exposing legacy Scope UI.
- Composer draft storage version 11 persists bounded `ArchitectureConcernContext` values with
  exact resource/authority/selection dedupe, chips, removal, promotion, retry restoration,
  sendability, slash handling, and one quoted serialization position before review comments.

## Phase 5 implementation closeout

Phase 5 implementation is complete, with verification intentionally unclaimed until Phase 6:

- The optional `architectureGraphViewsV2` capability is explicit in analyzer distribution
  capability resolution and is advertised only when the statically composed V2 server can use the
  required analyzer artifact.
- Existing comparison-bound Impact resources, `repository-atlas` identities, legacy Impact
  payloads, V5 indexes, old proposals without Planned metadata, and older servers retain invisible
  compatibility paths. Right-panel storage remains version 12.
- Maintained architecture, desktop, workspace-layout, release, Orchestrate, and Cartographer
  integration documentation describes the rescued product while completed historical plans remain
  unchanged.
- Graph-view metrics use only the locked authority, result, anchor, lens, freshness, and omission
  dimensions. Admission metrics cover queued, reused, complete, retry, terminal-failed, cancelled,
  expired-lease recovery, and restart reconciliation without identity, path, digest, or provider
  text labels.

No Phase 2 through 5 test, build, typecheck, lint, format, browser, Electron, or diff-check result is
claimed by these closeouts. Those gates begin only in Phase 6, per the user's explicit sequencing
direction.

## Phase 6 verification closeout

Consolidated verification ran only after every implementation phase was complete, per the user's
sequencing direction:

- Focused contract, migration, admission, analyzer, projection, query, lifecycle, metrics, RPC,
  compatibility, shared-canvas, Impact, Repository Map, proposal, composer-context, and persisted
  resource tests passed. Recorded batches include 35 backend contract/admission tests, 32 server
  runtime-service tests, 40 backend wiring tests, 57 final web regressions, 18 Electron lifecycle
  tests, and the focused Cartographer artifact/index suites.
- Cartographer core built before the final affected typechecks. Contracts, Cartographer core,
  server, web, client runtime, and desktop typechecks passed. Targeted formatting and comment-style
  checks passed; targeted lint reported no errors, and all newly introduced warnings were removed.
- A full-checkout Atlas V6 build exposed a real canonical-order mismatch: the builder used binary
  text ordering while the strict decoder used locale ordering. Both now share deterministic binary
  comparison, and the resulting 2,943-file, 417-directory artifact decodes successfully. A focused
  mixed-case regression protects the boundary.
- One isolated `test-t3-app` environment proved proposal summary to Planned Impact Diff, bounded
  graph rendering, textual state signals, roving keyboard focus, drawer focus return, Planned file
  routing, locally persisted non-sending concern context, Repository Map Architecture and Structure
  lenses, nested directory drill-down, and exact cross-lens anchor handoff. The pass also found and
  fixed duplicate Root breadcrumbs. The final browser state had no application errors; temporary
  servers and the controlled tab were stopped.
- Focused Electron protocol, window, and lifecycle tests passed, followed by the desktop build and
  desktop smoke verification. User-visible searches found no unintended Repository Atlas or Open
  graph diff copy; remaining Cartographer mentions are classified internal engine or maintained
  developer documentation. The final formatting and `git diff --check` gates passed.

The implementation intentionally did not run a mobile pass or the full workspace test suite. No
scope-deferred semantic-model platform, freeform editing, health dashboard, comparison mode, or
arbitrary branch comparison was introduced.
