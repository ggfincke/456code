// tests/apps/server/provider/HiddenTurnRegistry.test.ts
// verifies hidden turn failure cleanup and waiter lifecycle

import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInterruptTurnInput,
  type ProviderRuntimeEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { expect, vi } from "vite-plus/test";

import { ProviderAdapterRequestError } from "../../../../apps/server/src/provider/Errors.ts";
import {
  hasPendingHiddenTurnForThread,
  HiddenTurnAwaitError,
  isHiddenTurnRuntimeEvent,
  observeHiddenTurnRuntimeEvent,
  sendTurnAndAwait,
} from "../../../../apps/server/src/provider/HiddenTurnRegistry.ts";
import type { ProviderServiceShape } from "../../../../apps/server/src/provider/Services/ProviderService.ts";

const provider = ProviderDriverKind.make("codex");
const providerInstanceId = ProviderInstanceId.make("codex");
const threadId = ThreadId.make("thread-hidden-cleanup");
const turnId = TurnId.make("turn-hidden-cleanup");

function turnStartedEvent(eventId: string): ProviderRuntimeEvent {
  return {
    type: "turn.started",
    eventId: EventId.make(eventId),
    provider,
    providerInstanceId,
    threadId,
    turnId,
    createdAt: "2026-07-31T12:00:00.000Z",
    payload: {},
  };
}

function turnAbortedEvent(eventId: string): ProviderRuntimeEvent {
  return {
    type: "turn.aborted",
    eventId: EventId.make(eventId),
    provider,
    providerInstanceId,
    threadId,
    turnId,
    createdAt: "2026-07-31T12:00:01.000Z",
    payload: { reason: "late abort" },
  };
}

const assertWaiterRemoved = Effect.fn("assertHiddenTurnWaiterRemoved")(function* (
  lateEventId: string,
) {
  expect(hasPendingHiddenTurnForThread(threadId)).toBe(false);
  const lateEvent = turnAbortedEvent(lateEventId);
  yield* observeHiddenTurnRuntimeEvent(lateEvent);
  expect(isHiddenTurnRuntimeEvent(lateEvent)).toBe(false);
});

it.effect("times out by interrupting the provider turn and stopping an unconfirmed session", () =>
  Effect.gen(function* () {
    const interruptRequested = yield* Deferred.make<ProviderInterruptTurnInput>();
    const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>((request) =>
      Effect.succeed({ threadId: request.threadId, turnId }),
    );
    const interruptTurn = vi.fn<ProviderServiceShape["interruptTurn"]>((input) =>
      Deferred.succeed(interruptRequested, input).pipe(Effect.asVoid),
    );
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);
    const providerService = {
      sendTurn,
      interruptTurn,
      stopSession,
    } as unknown as ProviderServiceShape;

    const resultFiber = yield* sendTurnAndAwait(providerService, {
      providerInstanceId,
      request: { threadId, input: "compact" },
    }).pipe(Effect.result, Effect.forkChild);

    yield* Effect.yieldNow;
    yield* TestClock.adjust("120 seconds");
    const interruptInput = yield* Deferred.await(interruptRequested);
    yield* TestClock.adjust("10 seconds");
    const result = yield* Fiber.join(resultFiber);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(HiddenTurnAwaitError);
    }
    expect(interruptInput).toEqual({ threadId, turnId });
    expect(stopSession).toHaveBeenCalledExactlyOnceWith({ threadId });
    yield* assertWaiterRemoved("evt-late-timeout-abort");
  }),
);

it.effect("cleans up a started turn after send failure and preserves the original cause", () =>
  Effect.gen(function* () {
    const originalCause = new ProviderAdapterRequestError({
      provider: "codex",
      method: "session/prompt",
      detail: "prompt rejected after turn start",
    });
    const interruptRequested = yield* Deferred.make<ProviderInterruptTurnInput>();
    const sendTurn = vi.fn<ProviderServiceShape["sendTurn"]>(() =>
      observeHiddenTurnRuntimeEvent(turnStartedEvent("evt-start-before-send-failure")).pipe(
        Effect.andThen(Effect.fail(originalCause)),
      ),
    );
    const interruptTurn = vi.fn<ProviderServiceShape["interruptTurn"]>((input) =>
      Deferred.succeed(interruptRequested, input).pipe(Effect.asVoid),
    );
    const stopSession = vi.fn<ProviderServiceShape["stopSession"]>(() => Effect.void);
    const providerService = {
      sendTurn,
      interruptTurn,
      stopSession,
    } as unknown as ProviderServiceShape;

    const resultFiber = yield* sendTurnAndAwait(providerService, {
      providerInstanceId,
      request: { threadId, input: "compact" },
    }).pipe(Effect.result, Effect.forkChild);

    const interruptInput = yield* Deferred.await(interruptRequested);
    yield* TestClock.adjust("10 seconds");
    const result = yield* Fiber.join(resultFiber);

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBe(originalCause);
    }
    expect(interruptInput).toEqual({ threadId, turnId });
    expect(stopSession).toHaveBeenCalledExactlyOnceWith({ threadId });
    yield* assertWaiterRemoved("evt-late-send-failure-abort");
  }),
);
