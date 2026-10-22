# 456code guiding principles

456code is my personal agent orchestration platform, derived from T3 Code. I'm building it to direct and supervise agents across my projects, primarily on furnace, from my Mac desktop app or native iPhone app. Browser access remains useful; iPad support follows useful upstream work.

I confirmed these principles on October 22, 2026. They govern product scope and upstream integration. **Must** and **must not** are requirements for future work. This is intended behavior, not a claim that the current application meets every requirement. Changing the principles requires my explicit approval; an upstream update cannot change them implicitly.

## 1. Build for personal orchestration

Help me direct multiple agents and projects. Autonomous teams coordinating their own work are not the primary product goal. Existing automation can remain useful without expanding the product around it.

Design for my setup. Other people may use the code, but general-purpose configuration, distribution, and support promises are not requirements. Performance, reliable state, clear permissions, and simple operation take priority over broad feature coverage.

## 2. Furnace first; the host owns the work

The environment running an agent must own its execution, workspace, credentials, and durable state. Clients control and observe that work through the server.

- The Mac app must connect to furnace by default. Running a local Mac environment must be an explicit option, not an automatic consequence of opening the app.
- Work on furnace must use furnace's files and provider setup. Switching clients must not silently move execution to another machine.
- Closing a client, losing connectivity, or switching devices must not cancel a running turn or require a client to stay open to advance it.
- Approvals must remain pending when no client is available. Reconnecting must recover authoritative state, including approvals and results, without starting duplicate work.
- After a host crash or reboot, show the actual recovered state and require explicit resume where needed. Do not blindly restart interrupted work.
- Supporting other hosts is compatible with this model, but a multi-host fleet is not a prerequisite for the primary deployment.

## 3. Prioritize my devices

The Mac desktop app and native iPhone app are primary clients. Browser access must remain available. Starting work, reading progress, answering approvals, interrupting work, and returning to results must work across the primary clients.

- Preserve useful upstream iPad support when practical. A separate iPad feature program or full parity commitment is not required.
- Android does not drive product decisions or require equal verification effort. This is not a reason to delete working shared mobile code or Android support.
- Core behavior must live in server services and shared contracts so clients and authorized agent tools can reach the same operations.
- A change must account for reconnects, simultaneous clients, and the destination environment's permissions.
- Private-network or tailnet access is the primary remote connection path, including away from home through that network. Public self-hosting may remain available but is not a core requirement.

Interfaces need not be identical. State which clients and connection paths a change affects and which were actually verified.

## 4. Remove upstream collection and hosted product dependencies

456code must not collect or send product usage analytics to T3 or another upstream vendor. Remove analytics collection and delivery machinery; an opt-out setting or dormant analytics code does not complete this requirement.

- Do not derive analytics identities from provider logins, device identifiers, or account identifiers.
- Keep useful local logs, resource monitoring, and diagnostics. Exporting diagnostics to a destination I choose must be explicitly configured.
- T3-hosted product services are outside my intended workflow. Remove their unwanted user flows and dedicated integration machinery while preserving networking and authentication needed by my own hosts and clients.
- Core operation must not require a T3 account, T3-hosted web app, or T3 relay. Do not restore these dependencies through upstream updates.
- External requests must serve an identified feature I use. Authentication and inference for chosen providers remain valid external interactions. Fetching source improvements from T3's repository remains part of maintaining the fork.
- New or changed outbound integrations must identify their destination, purpose, and data sent. Do not introduce cost-bearing services without my approval.

This policy covers 456code's own behavior. Provider subprocesses and services have their own behavior, which must be assessed separately before claiming that an entire deployment sends no telemetry.

## 5. Prioritize my providers

Prioritize Codex, Claude, Coral, GitHub Copilot, and Google Antigravity. I have student plans for Copilot and Antigravity. Local models and subscription-backed providers both fit the product.

- Coral is a first-class provider. Setup and provider selection must make it discoverable; onboarding limited to Codex and Claude does not meet this requirement.
- Provider-specific limits must be explicit and enforced consistently. First-class support does not mean advertising unsupported capabilities.
- Preserve working provider authentication, approvals, cancellation, queues, and session resumption when changing shared code.
- Other working upstream providers may remain available when they do not create unnecessary maintenance work. They do not require equal product priority.
- Prefer existing provider integration paths where they meet the need. Do not create a dedicated driver solely to give a provider a more prominent product position.

## 6. Remove unwanted features deliberately

Remove unwanted product flows and their dedicated machinery. Keep useful shared code and harmless functionality when deleting them would add maintenance work without helping me. T3's commercial product scope and distribution goals do not automatically become 456code requirements.

- Onboarding must serve my hosts and providers. Account promotion and marketing that do not support that workflow have no product role.
- Architecture review, repository maps, and diff analysis may remain useful supporting capabilities. They do not define the product's scope.
- Do not remove useful networking, authentication, shared runtime code, or provider support merely because it originated in T3.
- Use **456code** throughout onboarding and the everyday user experience. Preserve T3 attribution and required license notices.
- Internal package names, commands, and technical identifiers may retain upstream names when renaming them provides little benefit and increases integration work.

## 7. Continue integrating T3 improvements

Regular upstream merges remain the maintenance strategy. Most functionality should continue to come from T3 Code, with deliberate fork changes where its product choices do not fit my setup.

- Keep upstream history and record the exact upstream commit used for each integration in its Git or PR record.
- Prefer existing service, adapter, contract, and client boundaries. Make direct changes where needed; do not build an extension framework solely to avoid touching upstream files.
- No subsystem is permanently exempt from necessary fork changes, including onboarding, mobile, shared client runtime, and orchestration.
- A small divergence is valuable when it lowers maintenance cost, but preserving my workflow and these principles takes priority. Defer an incompatible upstream feature or update when adapting it becomes too costly; do not silently compromise my working setup to stay current.
- Review upstream additions and conflict resolutions against this document. Textual merge success is not evidence that fork behavior survived.
- An update must not silently restore removed analytics, T3 product integrations, upstream update or publication paths, or onboarding that hides priority providers.
- Preserve fork identity, existing data, and the host/client workflow. Report deferred changes, compatibility gaps, and unverified clients rather than claiming complete acceptance.

Use [the fork operations record](operations/thin-fork.md) for existing integration details. Historical ownership limits there do not override these principles.

## 8. Apply the principles explicitly

Agents must read this document before product, architecture, provider, connectivity, or upstream integration work. It takes precedence over conflicting retained T3 guidance and historical fork restrictions. Agents must not weaken it to resolve a merge or avoid implementation work. A proposed policy change needs my explicit approval.

Before implementing a feature or removal, identify its personal use, affected host/client/provider paths, external dependencies, and state that must survive. Make any conflict with these principles visible in the change description.

For an upstream update, record a short explicit review in the PR or work report covering:

- Furnace as the default destination, explicit Mac hosting, task continuity, approvals, and reconnects.
- Mac desktop and native iPhone behavior, browser access, and any affected upstream iPad support.
- Availability and discovery of the priority providers, including Coral.
- Analytics removal, T3 service removal, and new or changed outbound requests.
- 456code identity, existing data, update destinations, deferred upstream changes, and actual verification.

Mark unaffected items as such. Tests and runtime evidence must match the behavior changed; a checklist alone is not proof.

When reporting a removal, identify what was removed and what remains. When reporting compliance, distinguish a documented requirement, a source change, a built artifact, and verified runtime behavior.

This document establishes direction. It does not authorize immediate runtime removals, data migration, publication, paid services, or changes to the installed application. Those remain scoped implementation tasks.
