<!-- .plans/t3-client-publication-20260909.md -->
<!-- record the selected client reconciliation scope and acceptance boundaries -->

# Client and media reconciliation publication

This is publication group 2 of the approved four-PR finish plan. It starts from merged Core
`cae2cb796cda461f1e28212d9659b62c463cd7ce`, whose exact merged-main CI passed. The upstream
audit remains frozen at `6c583620ff7ad3235b135af7107c0543467eecfa`; this publication does not
add a newer comparison range.

Verified code tree before this publication record: `242e1147852d5d2916762a49f3499185bb760c40`.
Changed paths: 240 code/config/test paths, plus this publication record. The PR records its exact final head and CI;
hosted publication is pending at the time this local record is written.

## Included behavior

- Authenticated assistant/workspace images, authored paths and dimensions, stable loading/failure
  slots, keyboard expansion and composer-focus restoration. Viewed-image activity keeps ordinary
  lifecycle grouping and loads its resource only when the existing detail is expanded.
- Strict Codex citation/artifact directives, bounded provenance and UTF-16 selections, source
  ownership validation, quoted-data provider expansion, citation chips/comments/actions and
  draft/stash serialization. Malformed directives stay literal. Artifact actions append once.
- Native image-upload queues, durable outbox retry and pending-message visibility, immediate
  navigation with failure recovery, explicit project/host-switch draft safety, stable native
  Markdown/review rows, file copy/open and preview retry states, bounded/lazy highlighting,
  scroll-reveal and font-slider fences, notification permission checks and bundle-scoped Keychain.
- Web file/disclosure/comment focus, worktree-origin preference, picker/palette shortcut ownership,
  mention fidelity, sticky Fast-mode choices, terminal/panel retention, tree refresh identity and
  all-edge floating-preview resizing in the fork's current components.
- Focus-owned Electron editing shortcuts, guest/popup context menus, drag-region hit targets,
  bounded preview metadata, recording delivery to the requesting environment, and recording
  capture-track cleanup before save. Desktop bundling omits unnecessary declaration generation.

The mobile composer remains image-only; the upload prerequisite does not introduce a generic
native file picker or cloud upload flow. Android remains absent. Existing iOS support is checked
automatically; no manual iPhone/iPad walkthrough is required or claimed.

## Source attribution and prerequisite corrections

Nonempty adaptation commits preserve original upstream author, author date, subject/body and
existing trailers, with exact source SHA and fork adaptation notes appended. Fork-only repairs
and publication records use the repository identity. Merge publication preserves those commits.
Equivalent or superseded behavior does not receive invented empty or add-then-revert commits.

In particular:

- `652515a349741d234111b85f27597be3265d1ffc` introduced image-grouping exceptions subsequently
  reversed by `61a91b6ef1bd45424169c6650362b358d49bbe34`. The existing normal grouping is retained;
  `8bd544cdfd22aa38ab82bc1adc0b851755a299ef` supplies lazy expanded-detail mounting. The old
  exceptions are not temporarily reintroduced just to manufacture attribution.
- `9bc7a56848eb7c7546605e54ff02c6abea176f96` contributes only the image-upload prerequisite
  needed by the approved queued-message continuation from
  `66a24d6c1a008430eebd855cd5640607d5aef38c`. Its generic-file/cloud workflow remains excluded.
- Four `COMPACT_SLASH_COMMAND` catalog import/list pairs were omitted from the preceding Core
  extraction. They are included here as an explicit continuation of
  `c5ba51d629b3813182cf3e161cc3f23b1e541dc3`, not a new product feature. Core already owns the
  shared command and dispatch; this completes advertisement in Codex, Cursor, Grok and OpenCode.
- The real Electron campaign exposed restart-local annotation ID reuse. A separate fork repair
  assigns UUIDs in the main-process pick owner and removes only matching attachment state when
  the same annotation is replaced without a crop. Unrelated attachments and notes are preserved.

Product usage/pricing, sparse defaults, custom model metadata, onboarding, active ordering and
balancing remain group 3. Official Antigravity runtime, OAuth, setup, legacy transition and model
catalog changes remain group 4. No managed-runtime ZIP dependency leaks into this group, and its
human personal-Google acceptance gate does not block the first three publications.

## Focused automated verification

The selected snapshot has worktree-local workspace links and caches. No shared application index
was used to assemble it, and the original clean checkout and unrelated worktrees were preserved.
Checks use Node 24.20.0, repository Vite+ fixtures and the mirrored root `tests/` layout.

Final affected-package typechecks passed for contracts, shared, client-runtime, server, web,
mobile and desktop. Exact changed-file formatting (238 paths), comment checks and lint
(228 source/test files) passed. These gates ran on `5dd59787ed3258b434a484c8e2d008bbf82bb341`;
the only subsequent code subtraction restored the explicitly excluded white browser background
to its Core baseline. No behavior or test was weakened to obtain a pass.

The four focused provider catalog suites passed all 57 tests after the compaction advertisement
correction. They supplement the 949-test selected-tree run below, which ran on
`31226f6febfb892e31a6fe44f957277f78796f03`. No full campaign was repeated for eight catalog lines.
Pinned pnpm 12.3.4 accepted the selected manifests with a frozen, lockfile-only, scripts-disabled
operation: the lock stayed byte-identical and no `node_modules` directory was created.

The preceding selected-tree focused run completed successfully:

| Package | Reported test files | Tests |
| --- | ---: | ---: |
| shared | 2 | 5 |
| client-runtime | 7 | 37 |
| server | 9 | 373 |
| web | 27 | 282 |
| mobile | 17 | 176 |
| desktop | 3 | 76 |
| Total | 65 | 949 |

The server invocation named eight test paths but the runner reported nine loaded files; the
table records actual runner output. The later catalog-only correction is separately validated
in the final publication receipt; it is not silently included in this earlier tree's result.

Each focused invocation has the form `../../node_modules/.bin/vp test run <mirrored-test-paths>`
from its package. It covers citation codecs/provenance, image dimensions/authenticated sources,
preview ownership/transfer, native attachment/outbox behavior, file/review identity, composer
serialization and desktop manager/window behavior. No full local workspace suite was run.

Affected-package typechecks use `../../node_modules/.bin/tsc --noEmit` for contracts, shared,
client-runtime, server, web and desktop, and the installed `tsc6 --noEmit` for mobile. Changed-file format/lint/comment checks,
`git diff --check`, patch/hash consistency and the pinned pnpm frozen-lockfile consistency check
are separate gates. Existing non-error Effect suggestions are not described as compiler failures.

The integrated code campaign also produced a successful production web build, iOS export and
generic iOS Simulator SDK native compilation without launching a simulator. These combined-tree
receipts prove that campaign's build, not a separately selected commit's hosted CI; publication
checks validate the selected branch again.

## Integrated web and Electron results

One disposable backend/profile and deterministic provider/HTTP fixtures were used. No personal
provider account, installed desktop application or unrelated process was modified.

Observed in the authenticated controlled browser:

- An assistant SVG rendered, expanded and dismissed with Escape, restoring composer focus.
  A missing image showed an explicit failure rather than a blank surface.
- Selection-to-citation, comment editing and draft reload worked; modifier-Enter delivered once.
  The deterministic provider received quoted citation data and source provenance.
- Switching from an expanded Markdown disclosure in file A to file B reset file-local state;
  source comments focused the real textarea and left source text unchanged.
- Refreshing the workspace inventory preserved the expanded folder and its entries. Automatic
  agent-triggered refresh has its separate subscription regression; this manual refresh does not
  claim to prove the trigger itself.
- Reload retained manually opened panels and the active thread. Product ordering observed in
  that combined campaign remains Product evidence, not an ordering implementation in this PR.

Observed in the real worktree-built Electron 44.2.0 application:

- Guest and popup editing shortcuts did not overwrite the composer; both context menus worked.
  The real hardened popup completed its opener round-trip and closed.
- Explicit preview navigation, ordinary screenshots and annotation attachment worked.
  The pre-thread terminal Run action correctly explained that a first message must create a task.
- A deliberately hung crop reached the five-second failure path and retained the annotation,
  revealing the ID collision described above. Its two regressions failed before the repair and
  passed afterward (manager 42 tests; composer 86 tests). The desktop bundle rebuilt with
  `vp pack`; the earlier `vp build` command was the wrong package entrypoint, not a source defect.

The repaired native overlay retest is **unavailable**, not passed: the automation surface returned
`windowNotFoundAtPosition` and `noWindowsAvailable` while accessibility inspection still showed
the picker. No automation bypass was used. Normal popup/shortcut evidence remains valid, while
the repaired timeout interaction has automated but not final native-interaction acceptance.
Recording cleanup/MIME/bitrate/transfer gates are automated; no new measured recording-quality
claim is made.

All run-owned Electron, controlled-browser, backend/watch, Vite and fixture-server processes were
stopped. Ports 14010, 5970 and 14111 had no listeners at final inspection. Disposable reproduction
state is not committed or treated as required published documentation. No simulator was launched.
