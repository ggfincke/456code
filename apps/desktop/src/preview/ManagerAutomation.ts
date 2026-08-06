// apps/desktop/src/preview/ManagerAutomation.ts
// owns desktop preview CDP automation commands and snapshots

import type {
  DesktopPreviewPointerEvent,
  PreviewAutomationActionEvent,
  PreviewAutomationClickInput,
  PreviewAutomationEvaluateInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshot,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
} from '@t3tools/contracts'
import { webContents } from 'electron'
import * as Effect from 'effect/Effect'
import * as Ref from 'effect/Ref'
import * as SynchronizedRef from 'effect/SynchronizedRef'

import {
  PreviewAutomationCoordinatesOutsideViewportError,
  PreviewAutomationInvalidSelectorError,
  PreviewAutomationResultTooLargeError,
  PreviewAutomationTargetNotEditableError,
  PreviewAutomationTargetNotFoundError,
  PreviewAutomationTimeoutError,
  PreviewOperationError,
  type PreviewAutomationSelectorKind,
  type PreviewManagerError,
} from './ManagerErrors.ts'
import {
  AGENT_CURSOR_CLICK_LEAD_MS,
  AGENT_CURSOR_MOVE_MS,
  MAX_EVALUATION_BYTES,
  MAX_INTERACTIVE_ELEMENTS,
  MAX_SCREENSHOT_WIDTH,
  MAX_VISIBLE_TEXT_LENGTH,
  type BrowserDiagnostics,
  type PointerEventListener,
  type PreviewInputSignal,
  type PreviewOperationContext,
  type PreviewTabRecord,
} from './ManagerTypes.ts'
import { makePreviewAutomationKeySequence } from './PreviewKeyboard.ts'

type SendCommand = (
  method: string,
  commandParams?: Record<string, unknown>,
) => Effect.Effect<unknown, PreviewManagerError>

interface AutomationTargetInput
{
  readonly selector?: string | undefined
  readonly locator?: string | undefined
}

export interface ManagerAutomationDeps
{
  readonly tabsRef: SynchronizedRef.SynchronizedRef<ReadonlyMap<string, PreviewTabRecord>>
  readonly diagnosticsRef: Ref.Ref<ReadonlyMap<number, BrowserDiagnostics>>
  readonly actionTimelineRef: Ref.Ref<
    ReadonlyMap<string, ReadonlyArray<PreviewAutomationActionEvent>>
  >
  readonly pointerEventListenersRef: Ref.Ref<ReadonlySet<PointerEventListener>>
  readonly pointerSequenceRef: Ref.Ref<number>
  readonly attempt: <A>(
    errorContext: PreviewOperationContext,
    evaluate: () => A,
  ) => Effect.Effect<A, PreviewOperationError>
  readonly attemptPromise: <A>(
    errorContext: PreviewOperationContext,
    evaluate: () => PromiseLike<A>,
  ) => Effect.Effect<A, PreviewOperationError>
  readonly currentIso: Effect.Effect<string>
  readonly currentMillis: Effect.Effect<number>
  readonly deliverEvent: (
    eventKind: 'state-change' | 'recording-frame' | 'pointer-event',
    tabId: string,
    delivery: () => Effect.Effect<void>,
  ) => Effect.Effect<void>
  readonly encodeJson: (
    errorContext: PreviewOperationContext,
    value: unknown,
  ) => Effect.Effect<string, PreviewOperationError>
  readonly ensurePlaywrightInjected: (
    tabId: string,
    send: SendCommand,
  ) => Effect.Effect<void, PreviewManagerError>
  readonly evaluateWithDebugger: <A = unknown>(
    tabId: string,
    send: SendCommand,
    expression: string,
    returnByValue: boolean,
    awaitPromise?: boolean,
  ) => Effect.Effect<A, PreviewManagerError>
  readonly expectAgentInput: (tabId: string, signal: PreviewInputSignal) => Effect.Effect<void>
  readonly nextCounter: (ref: Ref.Ref<number>) => Effect.Effect<number>
  readonly prepareAutomationInput: (
    send: SendCommand,
    enableRuntime: boolean,
  ) => Effect.Effect<void, PreviewManagerError>
  readonly requireWebContents: (
    tabId: string,
  ) => Effect.Effect<Electron.WebContents, PreviewManagerError>
  readonly withControlSession: <A>(
    tabId: string,
    wc: Electron.WebContents,
    action: string,
    use: (send: SendCommand, sendCleanup: SendCommand) => Effect.Effect<A, PreviewManagerError>,
  ) => Effect.Effect<A, PreviewManagerError>
  readonly automationLocator: (input: AutomationTargetInput) => string | null
  readonly automationSelectorDiagnostics: (input: AutomationTargetInput) => {
    readonly selectorKind: PreviewAutomationSelectorKind
    readonly selectorLength?: number
  }
  readonly hostPlatform: NodeJS.Platform
}

export const createAutomationOperations = (deps: ManagerAutomationDeps) =>
{
  const {
    tabsRef,
    diagnosticsRef,
    actionTimelineRef,
    pointerEventListenersRef,
    pointerSequenceRef,
    attempt,
    attemptPromise,
    currentIso,
    currentMillis,
    deliverEvent,
    encodeJson,
    ensurePlaywrightInjected,
    evaluateWithDebugger,
    expectAgentInput,
    nextCounter,
    prepareAutomationInput,
    requireWebContents,
    withControlSession,
    automationLocator,
    automationSelectorDiagnostics,
    hostPlatform,
  } = deps

  const automationStatus = Effect.fn('PreviewManager.automationStatus')(function* (tabId: string)
  {
    const tab = (yield* SynchronizedRef.get(tabsRef)).get(tabId)
    if (!tab || tab.webContentsId == null)
    {
      const navStatus = tab?.navStatus
      return {
        available: false,
        visible: true,
        tabId,
        url: !navStatus || navStatus.kind === 'Idle' ? null : navStatus.url,
        title: !navStatus || navStatus.kind === 'Idle' ? null : navStatus.title,
        loading: navStatus?.kind === 'Loading',
      }
    }
    const wc = webContents.fromId(tab.webContentsId)
    return !wc || wc.isDestroyed()
      ? {
          available: false,
          visible: true,
          tabId,
          url: null,
          title: null,
          loading: false,
        }
      : {
          available: true,
          visible: true,
          tabId,
          url: wc.getURL() || null,
          title: wc.getTitle() || null,
          loading: wc.isLoading(),
        }
  })

  const captureAutomationSnapshot = Effect.fn('PreviewManager.captureAutomationSnapshot')(
    function* (tabId: string, wc: Electron.WebContents, send: SendCommand)
    {
      yield* Effect.all([send('Runtime.enable'), send('Accessibility.enable')], {
        concurrency: 2,
        discard: true,
      })
      const page = yield* evaluateWithDebugger<{
        url: string
        title: string
        loading: boolean
        visibleText: string
        interactiveElements: PreviewAutomationSnapshot['interactiveElements']
      }>(
        tabId,
        send,
        `(() => {
          const selectorFor = (element) => {
            if (element.id) return "#" + CSS.escape(element.id);
            for (const attribute of ["data-testid", "name"]) {
              const value = element.getAttribute(attribute);
              if (value) return element.tagName.toLowerCase() + "[" + attribute + "=" + JSON.stringify(value) + "]";
            }
            const buildParts = (current, parts = []) => {
              if (!current || current.nodeType !== Node.ELEMENT_NODE || parts.length >= 8) {
                return parts;
              }
              const parent = current.parentElement;
              const siblings = parent
                ? Array.from(parent.children).filter((child) => child.tagName === current.tagName)
                : [];
              const base = current.tagName.toLowerCase();
              const part = siblings.length > 1
                ? base + ":nth-of-type(" + (siblings.indexOf(current) + 1) + ")"
                : base;
              return buildParts(parent, [part, ...parts]);
            };
            return buildParts(element).join(" > ");
          };
          const visible = (element) => {
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
          };
          const elements = Array.from(document.querySelectorAll(
            "a[href],button,input,textarea,select,[role],[tabindex]"
          )).filter(visible).slice(0, ${MAX_INTERACTIVE_ELEMENTS}).map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              tag: element.tagName.toLowerCase(),
              role: element.getAttribute("role"),
              name: element.getAttribute("aria-label") || element.innerText || element.getAttribute("name") || "",
              selector: selectorFor(element),
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            };
          });
          return {
            url: location.href,
            title: document.title,
            loading: document.readyState !== "complete",
            visibleText: (document.body?.innerText || "").slice(0, ${MAX_VISIBLE_TEXT_LENGTH}),
            interactiveElements: elements
          };
        })()`,
        true,
      )
      const [accessibility, sourceImage, diagnostics, timelines] = yield* Effect.all([
        send('Accessibility.getFullAXTree'),
        attemptPromise(
          {
            operation: 'automationSnapshot.capturePage',
            tabId,
            webContentsId: wc.id,
          },
          () => wc.capturePage(),
        ),
        Ref.get(diagnosticsRef),
        Ref.get(actionTimelineRef),
      ])
      const sourceSize = sourceImage.getSize()
      const image =
        sourceSize.width > MAX_SCREENSHOT_WIDTH
          ? sourceImage.resize({ width: MAX_SCREENSHOT_WIDTH })
          : sourceImage
      const size = image.getSize()
      const browserDiagnostics = diagnostics.get(wc.id)
      return {
        ...page,
        accessibilityTree: accessibility,
        consoleEntries: [...(browserDiagnostics?.consoleEntries ?? [])],
        networkEntries: [...(browserDiagnostics?.networkEntries ?? [])],
        actionTimeline: [...(timelines.get(tabId) ?? [])],
        screenshot: {
          mimeType: 'image/png' as const,
          data: image.toPNG().toString('base64'),
          width: size.width,
          height: size.height,
        },
      }
    },
  )

  const automationSnapshot = Effect.fn('PreviewManager.automationSnapshot')(function* (
    tabId: string,
  )
  {
    const wc = yield* requireWebContents(tabId)
    return yield* withControlSession(tabId, wc, 'snapshot', (send) =>
      captureAutomationSnapshot(tabId, wc, send),
    )
  })

  const resolveClickPoint = Effect.fn('PreviewManager.resolveClickPoint')(function* (
    tabId: string,
    send: SendCommand,
    input: PreviewAutomationClickInput,
  )
  {
    if (!('selector' in input) && !('locator' in input))
    {
      return { x: input.x!, y: input.y! }
    }
    const locator = automationLocator(input)!
    yield* ensurePlaywrightInjected(tabId, send)
    const locatorJson = yield* encodeJson(
      { operation: 'automationClick.encodeLocator', tabId },
      locator,
    )
    const point = yield* evaluateWithDebugger<
      { x: number; y: number } | { invalidSelector: true; message: string } | { notFound: true }
    >(
      tabId,
      send,
      `(() => {
          try {
            const injected = globalThis.__t3PlaywrightInjected;
            const parsed = injected.parseSelector(${locatorJson});
            const element = injected.querySelector(parsed, document, true);
            if (!element) return { notFound: true };
            const visible = injected.elementState(element, "visible");
            const enabled = injected.elementState(element, "enabled");
            if (!visible.matches || !enabled.matches) return { notFound: true };
            element.scrollIntoView({ block: "center", inline: "center" });
            const rect = element.getBoundingClientRect();
            return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
          } catch (error) {
            return { invalidSelector: true, message: String(error) };
          }
        })()`,
      true,
    )
    if ('invalidSelector' in point)
    {
      return yield* new PreviewAutomationInvalidSelectorError({
        operation: 'click',
        tabId,
        ...automationSelectorDiagnostics(input),
        reasonLength: point.message.length,
        cause: point,
      })
    }
    if ('notFound' in point)
    {
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: 'click',
        tabId,
        ...automationSelectorDiagnostics(input),
      })
    }
    return point
  })

  const emitPointerEvent = Effect.fn('PreviewManager.emitPointerEvent')(function* (
    event: DesktopPreviewPointerEvent,
  )
  {
    const listeners = yield* Ref.get(pointerEventListenersRef)
    yield* Effect.forEach(
      listeners,
      (listener) => deliverEvent('pointer-event', event.tabId, () => listener(event)),
      { discard: true },
    )
  })

  const performAutomationClick = Effect.fn('PreviewManager.performAutomationClick')(function* (
    tabId: string,
    input: PreviewAutomationClickInput,
    send: SendCommand,
  )
  {
    yield* prepareAutomationInput(send, true)
    const point = yield* resolveClickPoint(tabId, send, input)
    const viewport = yield* evaluateWithDebugger<{ width: number; height: number }>(
      tabId,
      send,
      '({ width: window.innerWidth, height: window.innerHeight })',
      true,
    )
    if (point.x < 0 || point.y < 0 || point.x > viewport.width || point.y > viewport.height)
    {
      return yield* new PreviewAutomationCoordinatesOutsideViewportError({
        tabId,
        x: point.x,
        y: point.y,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      })
    }
    const moveSequence = yield* nextCounter(pointerSequenceRef)
    const moveCreatedAt = yield* currentIso
    yield* emitPointerEvent({
      tabId,
      phase: 'move',
      ...point,
      sequence: moveSequence,
      createdAt: moveCreatedAt,
    })
    yield* Effect.sleep(AGENT_CURSOR_MOVE_MS)
    const clickSequence = yield* nextCounter(pointerSequenceRef)
    const clickCreatedAt = yield* currentIso
    yield* emitPointerEvent({
      tabId,
      phase: 'click',
      ...point,
      sequence: clickSequence,
      createdAt: clickCreatedAt,
    })
    yield* Effect.sleep(AGENT_CURSOR_CLICK_LEAD_MS)
    yield* expectAgentInput(tabId, { kind: 'pointer', ...point, button: 0 })
    yield* send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...point,
      button: 'left',
      clickCount: 1,
    })
    yield* send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...point,
      button: 'left',
      clickCount: 1,
    })
  })

  const automationClick = Effect.fn('PreviewManager.automationClick')(function* (
    tabId: string,
    input: PreviewAutomationClickInput,
  )
  {
    const wc = yield* requireWebContents(tabId)
    yield* withControlSession(tabId, wc, 'click', (send) =>
      performAutomationClick(tabId, input, send),
    )
  })

  const typeIntoAutomationTarget = Effect.fn('PreviewManager.typeIntoAutomationTarget')(function* (
    tabId: string,
    send: SendCommand,
    input: PreviewAutomationTypeInput,
  )
  {
    const locator = automationLocator(input)
    if (locator) yield* ensurePlaywrightInjected(tabId, send)
    const locatorJson = locator
      ? yield* encodeJson({ operation: 'automationType.encodeLocator', tabId }, locator)
      : null
    const textJson = yield* encodeJson(
      { operation: 'automationType.encodeText', tabId },
      input.text,
    )
    const result = yield* evaluateWithDebugger<
      | { ok: true }
      | { invalidSelector: true; message: string }
      | { notEditable: true }
      | { notFound: true }
    >(
      tabId,
      send,
      `(() => {
          try {
            const element = ${locatorJson ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, true); })()` : 'document.activeElement'};
            if (!element) return { notFound: true };
            const textControl =
              element instanceof HTMLTextAreaElement ||
              (element instanceof HTMLInputElement &&
                !new Set(["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"]).has(element.type));
            const editable = textControl || element.isContentEditable;
            if (!editable || element.disabled || element.readOnly) return { notEditable: true };
            element.focus();
            if (document.activeElement !== element) return { notEditable: true };
            const clear = ${input.clear ?? false};
            if (clear) {
              if (textControl) {
                element.select();
              } else {
                const range = document.createRange();
                range.selectNodeContents(element);
                const selection = document.getSelection();
                selection?.removeAllRanges();
                selection?.addRange(range);
              }
            }
            const text = ${textJson};
            let inserted = true;
            if (text.length > 0) {
              inserted = document.execCommand("insertText", false, text);
            } else if (clear) {
              document.execCommand("delete", false);
              const cleared = textControl
                ? element.value.length === 0
                : (element.textContent ?? "").length === 0;
              if (!cleared) {
                if (textControl) {
                  const prototype = element instanceof HTMLTextAreaElement
                    ? HTMLTextAreaElement.prototype
                    : HTMLInputElement.prototype;
                  const valueSetter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
                  if (valueSetter) valueSetter.call(element, "");
                  else element.value = "";
                } else {
                  element.replaceChildren();
                }
                element.dispatchEvent(new InputEvent("input", {
                  bubbles: true,
                  inputType: "deleteContentBackward",
                }));
              }
            }
            if (!inserted) return { notEditable: true };
            element.dispatchEvent(new Event("change", { bubbles: true }));
            return { ok: true };
          } catch (error) {
            return { invalidSelector: true, message: String(error) };
          }
        })()`,
      true,
    )
    if ('invalidSelector' in result)
    {
      return yield* new PreviewAutomationInvalidSelectorError({
        operation: 'type',
        tabId,
        ...automationSelectorDiagnostics(input),
        reasonLength: result.message.length,
        cause: result,
      })
    }
    if ('notFound' in result)
    {
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: 'type',
        tabId,
        ...automationSelectorDiagnostics(input),
      })
    }
    if ('notEditable' in result)
    {
      return yield* new PreviewAutomationTargetNotEditableError({
        tabId,
        ...automationSelectorDiagnostics(input),
      })
    }
  })

  const performAutomationType = Effect.fn('PreviewManager.performAutomationType')(function* (
    tabId: string,
    input: PreviewAutomationTypeInput,
    send: SendCommand,
  )
  {
    // CDP Input.insertText silently drops text until Electron has activated a hidden
    // guest WebContents with a pointer event. Editing in the page runtime keeps
    // background automation deterministic without stealing foreground app focus.
    yield* typeIntoAutomationTarget(tabId, send, input)
  })

  const automationType = Effect.fn('PreviewManager.automationType')(function* (
    tabId: string,
    input: PreviewAutomationTypeInput,
  )
  {
    const wc = yield* requireWebContents(tabId)
    yield* withControlSession(tabId, wc, 'type', (send) =>
      performAutomationType(tabId, input, send),
    )
  })

  const performAutomationPress = Effect.fn('PreviewManager.performAutomationPress')(function* (
    tabId: string,
    wc: Electron.WebContents,
    input: PreviewAutomationPressInput,
    send: SendCommand,
    sendCleanup: SendCommand,
  )
  {
    yield* prepareAutomationInput(send, false)
    const keySequence = makePreviewAutomationKeySequence(input, {
      isMac: hostPlatform === 'darwin',
    })
    const previouslyFocused = yield* attempt(
      { operation: 'automationPress.getFocusedWebContents', tabId, webContentsId: wc.id },
      () => webContents.getFocusedWebContents(),
    )
    let keyDownAttempted = false
    const releaseInput = Effect.gen(function* ()
    {
      if (keyDownAttempted)
      {
        yield* sendCleanup('Input.dispatchKeyEvent', keySequence.keyUp).pipe(Effect.ignore)
      }
      yield* sendCleanup('Emulation.setFocusEmulationEnabled', { enabled: false }).pipe(
        Effect.ignore,
      )
      if (previouslyFocused && previouslyFocused.id !== wc.id && !previouslyFocused.isDestroyed())
      {
        yield* attempt(
          {
            operation: 'automationPress.restoreFocusedWebContents',
            tabId,
            webContentsId: previouslyFocused.id,
          },
          () => previouslyFocused.focus(),
        ).pipe(Effect.ignore)
      }
    })

    // focus the guest WebContents itself, not its containing BrowserWindow. This
    // activates native keyboard behavior for hidden/background previews without
    // changing which thread is mounted in the UI. Restore the previous renderer
    // after dispatch so automation never leaves the app's input focus behind.
    yield* Effect.gen(function* ()
    {
      yield* attempt(
        { operation: 'automationPress.focusWebContents', tabId, webContentsId: wc.id },
        () => wc.focus(),
      )
      yield* send('Page.bringToFront')
      yield* send('Emulation.setFocusEmulationEnabled', { enabled: true })
      yield* expectAgentInput(tabId, keySequence.signal)
      keyDownAttempted = true
      yield* send('Input.dispatchKeyEvent', keySequence.keyDown)
    }).pipe(Effect.ensuring(releaseInput))
  })

  const automationPress = Effect.fn('PreviewManager.automationPress')(function* (
    tabId: string,
    input: PreviewAutomationPressInput,
  )
  {
    const wc = yield* requireWebContents(tabId)
    yield* withControlSession(tabId, wc, 'press', (send, sendCleanup) =>
      performAutomationPress(tabId, wc, input, send, sendCleanup),
    )
  })

  const performAutomationScroll = Effect.fn('PreviewManager.performAutomationScroll')(function* (
    tabId: string,
    input: PreviewAutomationScrollInput,
    send: SendCommand,
  )
  {
    yield* send('Runtime.enable')
    const locator = automationLocator(input)
    if (locator) yield* ensurePlaywrightInjected(tabId, send)
    const locatorJson = locator
      ? yield* encodeJson({ operation: 'automationScroll.encodeLocator', tabId }, locator)
      : null
    const result = yield* evaluateWithDebugger<
      { ok: true } | { invalidSelector: true; message: string } | { notFound: true }
    >(
      tabId,
      send,
      `(() => {
        try {
          const target = ${locatorJson ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, true); })()` : 'window'};
          if (!target) return { notFound: true };
          target.scrollBy({ left: ${input.deltaX ?? 0}, top: ${input.deltaY ?? 0}, behavior: "instant" });
          return { ok: true };
        } catch (error) {
          return { invalidSelector: true, message: String(error) };
        }
      })()`,
      true,
    )
    if ('invalidSelector' in result)
    {
      return yield* new PreviewAutomationInvalidSelectorError({
        operation: 'scroll',
        tabId,
        ...automationSelectorDiagnostics(input),
        reasonLength: result.message.length,
        cause: result,
      })
    }
    if ('notFound' in result)
    {
      return yield* new PreviewAutomationTargetNotFoundError({
        operation: 'scroll',
        tabId,
        ...automationSelectorDiagnostics(input),
      })
    }
  })

  const automationScroll = Effect.fn('PreviewManager.automationScroll')(function* (
    tabId: string,
    input: PreviewAutomationScrollInput,
  )
  {
    const wc = yield* requireWebContents(tabId)
    yield* withControlSession(tabId, wc, 'scroll', (send) =>
      performAutomationScroll(tabId, input, send),
    )
  })

  const performAutomationEvaluate = Effect.fn('PreviewManager.performAutomationEvaluate')(
    function* (tabId: string, input: PreviewAutomationEvaluateInput, send: SendCommand)
    {
      yield* send('Runtime.enable')
      const value = yield* evaluateWithDebugger(
        tabId,
        send,
        input.expression,
        input.returnByValue ?? true,
        input.awaitPromise ?? true,
      )
      const serialized = yield* encodeJson(
        { operation: 'automationEvaluate.encodeResult', tabId },
        value,
      )
      const actualBytes = Buffer.byteLength(serialized, 'utf8')
      if (actualBytes > MAX_EVALUATION_BYTES)
      {
        return yield* new PreviewAutomationResultTooLargeError({
          tabId,
          actualBytes,
          maximumBytes: MAX_EVALUATION_BYTES,
        })
      }
      return value
    },
  )

  const automationEvaluate = Effect.fn('PreviewManager.automationEvaluate')(function* (
    tabId: string,
    input: PreviewAutomationEvaluateInput,
  )
  {
    const wc = yield* requireWebContents(tabId)
    return yield* withControlSession(tabId, wc, 'evaluate', (send) =>
      performAutomationEvaluate(tabId, input, send),
    )
  })

  const performAutomationWaitFor = Effect.fn('PreviewManager.performAutomationWaitFor')(function* (
    tabId: string,
    input: PreviewAutomationWaitForInput,
    send: SendCommand,
  )
  {
    const timeoutMs = input.timeoutMs ?? 15_000
    yield* send('Runtime.enable')
    const locator = automationLocator(input)
    if (locator) yield* ensurePlaywrightInjected(tabId, send)
    const [locatorJson, textJson, urlIncludesJson] = yield* Effect.all([
      locator
        ? encodeJson({ operation: 'automationWaitFor.encodeLocator', tabId }, locator)
        : Effect.succeed(null),
      input.text
        ? encodeJson({ operation: 'automationWaitFor.encodeText', tabId }, input.text)
        : Effect.succeed(null),
      input.urlIncludes
        ? encodeJson({ operation: 'automationWaitFor.encodeUrl', tabId }, input.urlIncludes)
        : Effect.succeed(null),
    ])
    const deadline = (yield* currentMillis) + timeoutMs
    while ((yield* currentMillis) <= deadline)
    {
      const result = yield* evaluateWithDebugger<
        { matched: boolean } | { invalidSelector: true; message: string }
      >(
        tabId,
        send,
        `(() => {
              try {
                const selectorMatched = ${locatorJson ? `(() => { const injected = globalThis.__t3PlaywrightInjected; return injected.querySelector(injected.parseSelector(${locatorJson}), document, false) !== null; })()` : 'true'};
                const textMatched = ${
                  textJson ? `(document.body?.innerText || "").includes(${textJson})` : 'true'
                };
                const urlMatched = ${
                  urlIncludesJson ? `location.href.includes(${urlIncludesJson})` : 'true'
                };
                return { matched: selectorMatched && textMatched && urlMatched };
              } catch (error) {
                return { invalidSelector: true, message: String(error) };
              }
            })()`,
        true,
      )
      if ('invalidSelector' in result)
      {
        return yield* new PreviewAutomationInvalidSelectorError({
          operation: 'waitFor',
          tabId,
          ...automationSelectorDiagnostics(input),
          reasonLength: result.message.length,
          cause: result,
        })
      }
      if (result.matched) return
      yield* Effect.sleep(100)
    }
    return yield* new PreviewAutomationTimeoutError({
      tabId,
      timeoutMs,
    })
  })

  const automationWaitFor = Effect.fn('PreviewManager.automationWaitFor')(function* (
    tabId: string,
    input: PreviewAutomationWaitForInput,
  )
  {
    const wc = yield* requireWebContents(tabId)
    yield* withControlSession(tabId, wc, 'waitFor', (send) =>
      performAutomationWaitFor(tabId, input, send),
    )
  })

  return {
    automationStatus,
    automationSnapshot,
    automationClick,
    automationType,
    automationPress,
    automationScroll,
    automationEvaluate,
    automationWaitFor,
  }
}
