// apps/mobile/src/state/relay.ts
// manage relay environment discovery state

import { createRelayEnvironmentDiscoveryAtoms } from '@t3tools/client-runtime/state/relay'

import { connectionAtomRuntime } from '../connection/runtime'

export const relayEnvironmentDiscovery = createRelayEnvironmentDiscoveryAtoms(connectionAtomRuntime)
