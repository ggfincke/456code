// infra/relay/alchemy.run.ts
// provisions the relay and publishes its connection address

// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Planetscale from "alchemy/Planetscale";

import { PublishClientConfig } from "./src/clientConfig.ts";
import * as RelayDb from "./src/db.ts";
import { ManagedEndpointZone, RelayApiZone } from "./src/zone.ts";
import * as RelayWorker from "./src/worker.ts";

export default Alchemy.Stack(
  "T3CodeRelay",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Drizzle.providers(), Planetscale.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const db = yield* RelayDb.PlanetscaleDatabase;
    const hyperdrive = yield* RelayDb.RelayHyperdrive;
    const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const api = yield* RelayWorker.Api;
    yield* PublishClientConfig({ url: api.url });

    return {
      databaseName: db.database.name,
      databaseBranchName: db.branch?.name ?? "main",
      hyperdriveName: hyperdrive.name,
      workerName: api.workerName,
      url: api.url,
      relayApiZoneId: relayApiZone.zoneId,
      managedEndpointZoneId: managedEndpointZone.zoneId,
    };
  }).pipe(Effect.provide(RelayWorker.layer)),
);
