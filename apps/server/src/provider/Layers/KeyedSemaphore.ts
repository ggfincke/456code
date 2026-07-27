// apps/server/src/provider/Layers/KeyedSemaphore.ts
// serializes keyed effects without retaining idle key registries

import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";

interface KeyedSemaphoreEntry {
  readonly semaphore: Semaphore.Semaphore;
  readonly leaseCount: number;
}

interface KeyedSemaphoreLease<Key> {
  readonly key: Key;
  readonly semaphore: Semaphore.Semaphore;
}

export interface KeyedSemaphore<Key> {
  readonly withPermit: <A, E, R>(
    key: Key,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly activeKeyCount: Effect.Effect<number>;
  readonly activeLeaseCount: Effect.Effect<number>;
}

export const makeKeyedSemaphore = Effect.fn("makeKeyedSemaphore")(function* <Key>() {
  const entriesRef = yield* SynchronizedRef.make(new Map<Key, KeyedSemaphoreEntry>());

  const acquireLease = (key: Key) =>
    SynchronizedRef.modifyEffect(entriesRef, (current) => {
      const existing = current.get(key);
      if (existing !== undefined) {
        const next = new Map(current);
        next.set(key, {
          semaphore: existing.semaphore,
          leaseCount: existing.leaseCount + 1,
        });
        return Effect.succeed([{ key, semaphore: existing.semaphore }, next] as const);
      }

      return Semaphore.make(1).pipe(
        Effect.map((semaphore) => {
          const next = new Map(current);
          next.set(key, { semaphore, leaseCount: 1 });
          return [{ key, semaphore }, next] as const;
        }),
      );
    });

  const releaseLease = (lease: KeyedSemaphoreLease<Key>) =>
    SynchronizedRef.update(entriesRef, (current) => {
      const existing = current.get(lease.key);
      if (existing === undefined || existing.semaphore !== lease.semaphore) {
        return current;
      }

      const next = new Map(current);
      if (existing.leaseCount === 1) {
        next.delete(lease.key);
      } else {
        next.set(lease.key, {
          semaphore: existing.semaphore,
          leaseCount: existing.leaseCount - 1,
        });
      }
      return next;
    });

  const withPermit: KeyedSemaphore<Key>["withPermit"] = (key, effect) =>
    Effect.acquireUseRelease(
      acquireLease(key),
      (lease) => lease.semaphore.withPermit(effect),
      releaseLease,
    );

  return {
    withPermit,
    activeKeyCount: SynchronizedRef.get(entriesRef).pipe(Effect.map((entries) => entries.size)),
    activeLeaseCount: SynchronizedRef.get(entriesRef).pipe(
      Effect.map((entries) =>
        Array.from(entries.values()).reduce((total, entry) => total + entry.leaseCount, 0),
      ),
    ),
  };
});
