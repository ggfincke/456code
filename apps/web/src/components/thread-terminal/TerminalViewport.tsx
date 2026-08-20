// apps/web/src/components/thread-terminal/TerminalViewport.tsx
// mount and drive a single xterm session for a thread terminal

import { useAtomValue } from '@effect/atom-react'
import { FitAddon } from '@xterm/addon-fit'
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from '@t3tools/client-runtime/state/runtime'
import {
  type ResolvedKeybindingsConfig,
  type ScopedThreadRef,
  type ThreadId,
} from '@t3tools/contracts'
import { Terminal, type ITheme } from '@xterm/xterm'
import { useEffect, useEffectEvent, useMemo, useRef } from 'react'
import { writeTextToClipboard } from '~/hooks/useCopyToClipboard'
import { type TerminalContextSelection } from '~/lib/terminalContext'
import { useOpenInPreferredEditor } from '../../lib/editorPreferences'
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
  resolveWrappedTerminalLinkRange,
  wrappedTerminalLinkRangeIntersectsBufferLine,
} from '../../terminal-links'
import {
  isDiffToggleShortcut,
  isTerminalClearShortcut,
  isTerminalCloseShortcut,
  isTerminalNewShortcut,
  isTerminalSplitShortcut,
  isTerminalSplitVerticalShortcut,
  isTerminalToggleShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
} from '../../keybindings'
import { readLocalApi } from '~/localApi'
import { useAttachedTerminalSession } from '../../state/terminalSessions'
import { serverEnvironment } from '../../state/server'
import { previewEnvironment } from '../../state/preview'
import { terminalEnvironment } from '../../state/terminal'
import { openTerminalLinkInPreview } from '../preview/openTerminalLinkInPreview'
import { useAtomCommand } from '../../state/use-atom-command'

import {
  getTerminalSelectionRect,
  readTerminalClipboardText,
  resolveTerminalClipboardShortcut,
  resolveTerminalSelectionActionPosition,
  shouldClearTerminalSelectionAction,
  shouldHandleTerminalSelectionMouseUp,
  shouldSuppressTerminalContextMenu,
  terminalContextMenuItems,
  type TerminalContextMenuAction,
  terminalSelectionMenuItems,
  terminalSelectionActionDelayForClickCount,
} from './selectionHelpers'

function writeSystemMessage(terminal: Terminal, message: string): void
{
  terminal.write(`\r\n[terminal] ${message}\r\n`)
}

function writeTerminalBuffer(terminal: Terminal, buffer: string): void
{
  terminal.write('\u001bc')
  if (buffer.length > 0)
  {
    terminal.write(buffer)
  }
}

function fitTerminalSafely(fitAddon: FitAddon): boolean
{
  try
  {
    fitAddon.fit()
    return true
  }
  catch
  {
    return false
  }
}

function runtimeEnvSignature(runtimeEnv: Record<string, string> | undefined): string
{
  if (!runtimeEnv) return ''
  return JSON.stringify(
    Object.entries(runtimeEnv)
      .filter(([key, value]) => key.length > 0 && typeof value === 'string')
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey)),
  )
}

function normalizeComputedColor(value: string | null | undefined, fallback: string): string
{
  const normalizedValue = value?.trim().toLowerCase()
  if (
    !normalizedValue ||
    normalizedValue === 'transparent' ||
    normalizedValue === 'rgba(0, 0, 0, 0)' ||
    normalizedValue === 'rgba(0 0 0 / 0)'
  )
  {
    return fallback
  }
  return value ?? fallback
}

function terminalThemeFromApp(mountElement?: HTMLElement | null): ITheme
{
  const isOcean = document.documentElement.classList.contains('ocean')
  const isDark = document.documentElement.classList.contains('dark')
  const fallbackBackground = isDark ? 'rgb(14, 18, 24)' : 'rgb(255, 255, 255)'
  const fallbackForeground = isDark ? 'rgb(237, 241, 247)' : 'rgb(28, 33, 41)'
  const drawerSurface =
    mountElement?.closest('.thread-terminal-drawer') ??
    document.querySelector('.thread-terminal-drawer') ??
    document.body
  const drawerStyles = getComputedStyle(drawerSurface)
  const bodyStyles = getComputedStyle(document.body)
  const background = normalizeComputedColor(
    drawerStyles.backgroundColor,
    normalizeComputedColor(bodyStyles.backgroundColor, fallbackBackground),
  )
  const foreground = normalizeComputedColor(
    drawerStyles.color,
    normalizeComputedColor(bodyStyles.color, fallbackForeground),
  )

  if (isOcean)
  {
    const rootStyles = getComputedStyle(document.documentElement)
    const oceanColor = (property: string, fallback: string): string =>
      normalizeComputedColor(rootStyles.getPropertyValue(property), fallback)

    // mirrors terminal.ansi* / terminalCursor.* from Material Theme Ocean High Contrast.
    // * bright variants intentionally repeat their base hue — xterm draws bold text in
    //   bright colors, and upstream keeps the pairs equal so bold prompts stay on palette
    return {
      background,
      foreground,
      cursor: oceanColor('--ocean-yellow', foreground),
      cursorAccent: oceanColor('--ocean-black', background),
      selectionBackground: oceanColor('--ocean-selection', foreground),
      scrollbarSliderBackground: oceanColor('--ocean-scrollbar', foreground),
      scrollbarSliderHoverBackground: oceanColor('--ocean-scrollbar-hover', foreground),
      scrollbarSliderActiveBackground: oceanColor('--ocean-scrollbar-active', foreground),
      black: oceanColor('--ocean-black', background),
      red: oceanColor('--ocean-red', foreground),
      green: oceanColor('--ocean-green', foreground),
      yellow: oceanColor('--ocean-yellow', foreground),
      blue: oceanColor('--ocean-blue', foreground),
      magenta: oceanColor('--ocean-purple', foreground),
      cyan: oceanColor('--ocean-cyan', foreground),
      white: oceanColor('--ocean-white', foreground),
      brightBlack: oceanColor('--ocean-comments', foreground),
      brightRed: oceanColor('--ocean-red', foreground),
      brightGreen: oceanColor('--ocean-green', foreground),
      brightYellow: oceanColor('--ocean-yellow', foreground),
      brightBlue: oceanColor('--ocean-blue', foreground),
      brightMagenta: oceanColor('--ocean-purple', foreground),
      brightCyan: oceanColor('--ocean-cyan', foreground),
      brightWhite: oceanColor('--ocean-white', foreground),
    }
  }

  if (isDark)
  {
    return {
      background,
      foreground,
      cursor: 'rgb(180, 203, 255)',
      selectionBackground: 'rgba(180, 203, 255, 0.25)',
      scrollbarSliderBackground: 'rgba(255, 255, 255, 0.1)',
      scrollbarSliderHoverBackground: 'rgba(255, 255, 255, 0.18)',
      scrollbarSliderActiveBackground: 'rgba(255, 255, 255, 0.22)',
      black: 'rgb(24, 30, 38)',
      red: 'rgb(255, 122, 142)',
      green: 'rgb(134, 231, 149)',
      yellow: 'rgb(244, 205, 114)',
      blue: 'rgb(137, 190, 255)',
      magenta: 'rgb(208, 176, 255)',
      cyan: 'rgb(124, 232, 237)',
      white: 'rgb(210, 218, 230)',
      brightBlack: 'rgb(110, 120, 136)',
      brightRed: 'rgb(255, 168, 180)',
      brightGreen: 'rgb(176, 245, 186)',
      brightYellow: 'rgb(255, 224, 149)',
      brightBlue: 'rgb(174, 210, 255)',
      brightMagenta: 'rgb(229, 203, 255)',
      brightCyan: 'rgb(167, 244, 247)',
      brightWhite: 'rgb(244, 247, 252)',
    }
  }

  return {
    background,
    foreground,
    cursor: 'rgb(38, 56, 78)',
    selectionBackground: 'rgba(37, 63, 99, 0.2)',
    scrollbarSliderBackground: 'rgba(0, 0, 0, 0.15)',
    scrollbarSliderHoverBackground: 'rgba(0, 0, 0, 0.25)',
    scrollbarSliderActiveBackground: 'rgba(0, 0, 0, 0.3)',
    black: 'rgb(44, 53, 66)',
    red: 'rgb(191, 70, 87)',
    green: 'rgb(60, 126, 86)',
    yellow: 'rgb(146, 112, 35)',
    blue: 'rgb(72, 102, 163)',
    magenta: 'rgb(132, 86, 149)',
    cyan: 'rgb(53, 127, 141)',
    white: 'rgb(210, 215, 223)',
    brightBlack: 'rgb(112, 123, 140)',
    brightRed: 'rgb(212, 95, 112)',
    brightGreen: 'rgb(85, 148, 111)',
    brightYellow: 'rgb(173, 133, 45)',
    brightBlue: 'rgb(91, 124, 194)',
    brightMagenta: 'rgb(153, 107, 172)',
    brightCyan: 'rgb(70, 149, 164)',
    brightWhite: 'rgb(236, 240, 246)',
  }
}

interface TerminalViewportProps
{
  threadRef: ScopedThreadRef
  threadId: ThreadId
  terminalId: string
  terminalLabel: string
  cwd: string
  worktreePath?: string | null
  runtimeEnv?: Record<string, string>
  onSessionExited: () => void
  onAddTerminalContext: (selection: TerminalContextSelection) => void
  focusRequestId: number
  autoFocus: boolean
  resizeEpoch: number
  drawerHeight: number
  keybindings: ResolvedKeybindingsConfig
}

export interface TerminalLaunchLocation
{
  readonly cwd: string
  readonly worktreePath?: string | null
  readonly runtimeEnv?: Record<string, string>
}

export function TerminalViewport({
  threadRef,
  threadId,
  terminalId,
  terminalLabel,
  cwd,
  worktreePath,
  runtimeEnv,
  onSessionExited,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  resizeEpoch,
  drawerHeight,
  keybindings,
}: TerminalViewportProps)
{
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const environmentId = threadRef.environmentId
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId))
  const openInPreferredEditor = useOpenInPreferredEditor(
    environmentId,
    serverConfig?.availableEditors ?? [],
  )
  const openTerminalPath = useEffectEvent((target: string) => openInPreferredEditor(target))
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  })
  const runTerminalWrite = useAtomCommand(terminalEnvironment.write, {
    reportFailure: false,
  })
  const runTerminalResize = useAtomCommand(terminalEnvironment.resize, {
    reportFailure: false,
  })
  const hasHandledExitRef = useRef(false)
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null)
  const selectionGestureActiveRef = useRef(false)
  const selectionActionRequestIdRef = useRef(0)
  const openSelectionMenuRequestIdRef = useRef<number | null>(null)
  const selectionActionTimerRef = useRef<number | null>(null)
  const keybindingsRef = useRef(keybindings)
  const runtimeEnvKey = useMemo(() => runtimeEnvSignature(runtimeEnv), [runtimeEnv])
  const handleSessionExited = useEffectEvent(() =>
  {
    onSessionExited()
  })
  const handleAddTerminalContext = useEffectEvent((selection: TerminalContextSelection) =>
  {
    onAddTerminalContext(selection)
  })
  const readTerminalLabel = useEffectEvent(() => terminalLabel)
  const terminalSession = useAttachedTerminalSession({
    environmentId,
    terminal: {
      threadId,
      terminalId,
      cwd,
      ...(worktreePath !== undefined ? { worktreePath } : {}),
      ...(runtimeEnv ? { env: runtimeEnv } : {}),
    },
  })
  const writeTerminal = useEffectEvent((data: string) =>
    runTerminalWrite({
      environmentId,
      input: { threadId, terminalId, data },
    }),
  )
  const resizeTerminal = useEffectEvent((cols: number, rows: number) =>
    runTerminalResize({
      environmentId,
      input: { threadId, terminalId, cols, rows },
    }),
  )
  const terminalBuffer = terminalSession.buffer
  const terminalError = terminalSession.error
  const terminalStatus = terminalSession.status
  const terminalVersion = terminalSession.version
  const previousSessionRef = useRef({
    buffer: terminalBuffer,
    error: terminalError,
    status: terminalStatus,
    version: terminalVersion,
  })

  useEffect(() =>
  {
    keybindingsRef.current = keybindings
  }, [keybindings])

  useEffect(() =>
  {
    const mount = containerRef.current
    if (!mount) return

    const localApi = readLocalApi()

    const fitAddon = new FitAddon()
    const terminal = new Terminal({
      cursorBlink: true,
      lineHeight: 1,
      fontSize: 12,
      scrollback: 5_000,
      fontFamily:
        '"SF Mono", "SFMono-Regular", "JetBrains Mono", Consolas, "Liberation Mono", Menlo, monospace',
      theme: terminalThemeFromApp(mount),
    })
    terminal.loadAddon(fitAddon)
    terminal.open(mount)
    fitTerminalSafely(fitAddon)

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon
    previousSessionRef.current = {
      buffer: '',
      status: 'closed',
      error: null,
      version: 0,
    }
    let clipboardRequestId = 0
    let clearSelectionAfterNativeCopyRequestId: number | null = null

    const clearSelectionAction = () =>
    {
      const openMenuRequestId = openSelectionMenuRequestIdRef.current
      openSelectionMenuRequestIdRef.current = null
      selectionActionRequestIdRef.current += 1
      if (selectionActionTimerRef.current !== null)
      {
        window.clearTimeout(selectionActionTimerRef.current)
        selectionActionTimerRef.current = null
      }
      if (openMenuRequestId !== null)
      {
        void localApi?.contextMenu.close()
      }
    }

    const readSelectionAction = (): {
      position: { x: number; y: number }
      clipboardText: string
      selection: TerminalContextSelection
    } | null =>
    {
      const activeTerminal = terminalRef.current
      const mountElement = containerRef.current
      if (!activeTerminal || !mountElement || !activeTerminal.hasSelection())
      {
        return null
      }
      const selectionText = activeTerminal.getSelection()
      const selectionPosition = activeTerminal.getSelectionPosition()
      const normalizedText = selectionText.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '')
      if (!selectionPosition || normalizedText.length === 0)
      {
        return null
      }
      const lineStart = selectionPosition.start.y + 1
      const lineCount = normalizedText.split('\n').length
      const lineEnd = Math.max(lineStart, lineStart + lineCount - 1)
      const bounds = mountElement.getBoundingClientRect()
      const selectionRect = getTerminalSelectionRect(mountElement)
      const position = resolveTerminalSelectionActionPosition({
        bounds,
        selectionRect:
          selectionRect === null
            ? null
            : { right: selectionRect.right, bottom: selectionRect.bottom },
        pointer: selectionPointerRef.current,
      })
      return {
        position,
        clipboardText: selectionText,
        selection: {
          terminalId,
          terminalLabel: readTerminalLabel(),
          lineStart,
          lineEnd,
          text: normalizedText,
        },
      }
    }

    const addSelectionToChat = (selection: TerminalContextSelection) =>
    {
      handleAddTerminalContext(selection)
      terminalRef.current?.clearSelection()
      terminalRef.current?.focus()
    }

    const reportIfCurrent = (requestId: number, error: unknown, fallback: string) =>
    {
      if (requestId !== selectionActionRequestIdRef.current) return
      const activeTerminal = terminalRef.current
      if (activeTerminal)
      {
        writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallback)
      }
    }

    const focusIfCurrent = (requestId: number) =>
    {
      if (requestId === selectionActionRequestIdRef.current)
      {
        terminalRef.current?.focus()
      }
    }

    const copySelection = async (text: string, requestId: number, clearOnSuccess = false) =>
    {
      const activeTerminal = terminalRef.current
      if (!activeTerminal) return
      const requestClipboardId = ++clipboardRequestId
      clearSelectionAfterNativeCopyRequestId = clearOnSuccess ? requestClipboardId : null
      // let xterm's native copy event claim the gesture before the async fallback writes
      await Promise.resolve()
      if (
        requestClipboardId !== clipboardRequestId ||
        requestId !== selectionActionRequestIdRef.current ||
        terminalRef.current !== activeTerminal
      )
      {
        return
      }
      let didCopy = false
      try
      {
        didCopy = await writeTextToClipboard(text, 'terminal selection')
      }
      catch (error)
      {
        if (requestClipboardId === clipboardRequestId)
        {
          clearSelectionAfterNativeCopyRequestId = null
          reportIfCurrent(requestId, error, 'Unable to copy terminal selection')
          focusIfCurrent(requestId)
        }
        return
      }
      if (
        !didCopy ||
        requestClipboardId !== clipboardRequestId ||
        requestId !== selectionActionRequestIdRef.current ||
        terminalRef.current !== activeTerminal
      )
      {
        return
      }
      clearSelectionAfterNativeCopyRequestId = null
      if (
        clearOnSuccess &&
        activeTerminal.hasSelection() &&
        activeTerminal.getSelection() === text
      )
      {
        activeTerminal.clearSelection()
      }
      activeTerminal.focus()
    }

    const pasteFromClipboard = async (requestId: number) =>
    {
      const activeTerminal = terminalRef.current
      if (!activeTerminal) return
      const requestClipboardId = ++clipboardRequestId
      let text: string
      try
      {
        text = await readTerminalClipboardText()
      }
      catch (error)
      {
        if (requestClipboardId === clipboardRequestId)
        {
          reportIfCurrent(requestId, error, 'Unable to read the clipboard')
          focusIfCurrent(requestId)
        }
        return
      }
      if (
        requestClipboardId !== clipboardRequestId ||
        requestId !== selectionActionRequestIdRef.current ||
        terminalRef.current !== activeTerminal
      )
      {
        return
      }
      if (text.length > 0)
      {
        // xterm owns line-ending normalization and bracketed-paste encoding
        activeTerminal.paste(text)
      }
      activeTerminal.focus()
    }

    const showTerminalContextMenu = async (event: MouseEvent) =>
    {
      if (!localApi || !terminalRef.current) return
      event.preventDefault()
      clearSelectionAction()
      const selectionAction = readSelectionAction()
      const requestId = selectionActionRequestIdRef.current
      let clicked: TerminalContextMenuAction | null
      try
      {
        clicked = await localApi.contextMenu.show(
          terminalContextMenuItems({ hasSelection: selectionAction !== null }),
          { x: event.clientX, y: event.clientY },
        )
      }
      catch (error)
      {
        reportIfCurrent(requestId, error, 'Unable to open the terminal context menu')
        focusIfCurrent(requestId)
        return
      }
      if (requestId !== selectionActionRequestIdRef.current || clicked === null)
      {
        return
      }
      switch (clicked)
      {
        case 'add-to-chat':
          if (selectionAction)
          {
            addSelectionToChat(selectionAction.selection)
          }
          return
        case 'copy':
          if (selectionAction)
          {
            await copySelection(selectionAction.clipboardText, requestId)
          }
          return
        case 'paste':
          await pasteFromClipboard(requestId)
          return
      }
    }

    const showSelectionAction = async () =>
    {
      if (!localApi)
      {
        clearSelectionAction()
        return
      }
      if (openSelectionMenuRequestIdRef.current !== null)
      {
        return
      }
      const nextAction = readSelectionAction()
      if (!nextAction)
      {
        clearSelectionAction()
        return
      }
      const requestId = ++selectionActionRequestIdRef.current
      openSelectionMenuRequestIdRef.current = requestId
      const clicked = await localApi.contextMenu
        .show(terminalSelectionMenuItems(), nextAction.position)
        .finally(() =>
        {
          if (openSelectionMenuRequestIdRef.current === requestId)
          {
            openSelectionMenuRequestIdRef.current = null
          }
        })
      if (requestId !== selectionActionRequestIdRef.current || clicked === null)
      {
        return
      }
      switch (clicked)
      {
        case 'add-to-chat':
          addSelectionToChat(nextAction.selection)
          return
        case 'copy':
          await copySelection(nextAction.clipboardText, requestId)
          return
      }
    }

    const sendTerminalInput = async (data: string, fallbackError: string) =>
    {
      const activeTerminal = terminalRef.current
      if (!activeTerminal) return
      const result = await writeTerminal(data)
      if (result._tag === 'Failure' && !isAtomCommandInterrupted(result))
      {
        const error = squashAtomCommandFailure(result)
        writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallbackError)
      }
    }

    terminal.attachCustomKeyEventHandler((event) =>
    {
      const currentKeybindings = keybindingsRef.current
      const options = { context: { terminalFocus: true, terminalOpen: true } }
      if (
        isTerminalToggleShortcut(event, currentKeybindings, options) ||
        isTerminalSplitShortcut(event, currentKeybindings, options) ||
        isTerminalSplitVerticalShortcut(event, currentKeybindings, options) ||
        isTerminalNewShortcut(event, currentKeybindings, options) ||
        isTerminalCloseShortcut(event, currentKeybindings, options) ||
        isDiffToggleShortcut(event, currentKeybindings, options)
      )
      {
        return false
      }

      const navigationData = terminalNavigationShortcutData(event)
      if (navigationData !== null)
      {
        event.preventDefault()
        event.stopPropagation()
        void sendTerminalInput(navigationData, 'Failed to move cursor')
        return false
      }

      const deleteData = terminalDeleteShortcutData(event)
      if (deleteData !== null)
      {
        event.preventDefault()
        event.stopPropagation()
        void sendTerminalInput(deleteData, 'Failed to delete terminal input')
        return false
      }

      const clipboardAction = resolveTerminalClipboardShortcut(
        event,
        terminalRef.current?.hasSelection() ?? false,
      )
      if (clipboardAction !== null)
      {
        // keep the native clipboard event alive as the permission-free fallback
        event.stopPropagation()
        clearSelectionAction()
        const requestId = selectionActionRequestIdRef.current
        if (clipboardAction === 'copy')
        {
          const selection = terminalRef.current?.getSelection() ?? ''
          const copyPromise = copySelection(selection, requestId, event.ctrlKey && !event.shiftKey)
          if (event.shiftKey)
          {
            event.preventDefault()
            try
            {
              document.execCommand('copy')
            }
            catch
            {
              // the async Clipboard API remains the fallback
            }
          }
          void copyPromise
        }
        else
        {
          void pasteFromClipboard(requestId)
        }
        return false
      }

      if (!isTerminalClearShortcut(event)) return true
      event.preventDefault()
      event.stopPropagation()
      void sendTerminalInput('\u000c', 'Failed to clear terminal')
      return false
    })

    const terminalLinksDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) =>
      {
        const activeTerminal = terminalRef.current
        if (!activeTerminal)
        {
          callback(undefined)
          return
        }

        const wrappedLine = collectWrappedTerminalLinkLine(bufferLineNumber, (bufferLineIndex) =>
          activeTerminal.buffer.active.getLine(bufferLineIndex),
        )
        if (!wrappedLine)
        {
          callback(undefined)
          return
        }

        const links = extractTerminalLinks(wrappedLine.text)
          .map((match) => ({
            match,
            range: resolveWrappedTerminalLinkRange(wrappedLine, match),
          }))
          .filter(({ range }) =>
            wrappedTerminalLinkRangeIntersectsBufferLine(range, bufferLineNumber),
          )
        if (links.length === 0)
        {
          callback(undefined)
          return
        }

        callback(
          links.map(({ match, range }) => ({
            text: match.text,
            range,
            activate: (event: MouseEvent) =>
            {
              if (!isTerminalLinkActivation(event)) return

              const latestTerminal = terminalRef.current
              if (!latestTerminal) return

              if (match.kind === 'url')
              {
                if (!localApi)
                {
                  writeSystemMessage(
                    latestTerminal,
                    'Opening links is unavailable in this browser.',
                  )
                  return
                }
                const fallbackToBrowser = () =>
                {
                  void localApi.shell.openExternal(match.text).catch((error: unknown) =>
                  {
                    writeSystemMessage(
                      latestTerminal,
                      error instanceof Error ? error.message : 'Unable to open link',
                    )
                  })
                }
                void openTerminalLinkInPreview({
                  url: match.text,
                  position: { x: event.clientX, y: event.clientY },
                  threadRef,
                  openPreview,
                  localApi,
                  fallbackToBrowser,
                })
                return
              }

              const target = resolvePathLinkTarget(match.text, cwd)
              void (async () =>
              {
                const result = await openTerminalPath(target)
                if (result._tag === 'Success' || isAtomCommandInterrupted(result))
                {
                  return
                }
                const error = squashAtomCommandFailure(result)
                writeSystemMessage(
                  latestTerminal,
                  error instanceof Error ? error.message : 'Unable to open path',
                )
              })()
            },
          })),
        )
      },
    })

    const inputDisposable = terminal.onData((data) =>
    {
      clipboardRequestId += 1
      void (async () =>
      {
        const result = await writeTerminal(data)
        if (result._tag === 'Success' || isAtomCommandInterrupted(result))
        {
          return
        }
        const error = squashAtomCommandFailure(result)
        writeSystemMessage(
          terminal,
          error instanceof Error ? error.message : 'Terminal write failed',
        )
      })()
    })

    const selectionDisposable = terminal.onSelectionChange(() =>
    {
      clipboardRequestId += 1
      if (terminalRef.current?.hasSelection())
      {
        return
      }
      if (
        shouldClearTerminalSelectionAction({
          timerPending: selectionActionTimerRef.current !== null,
          openMenuRequestId: openSelectionMenuRequestIdRef.current,
          currentRequestId: selectionActionRequestIdRef.current,
        })
      )
      {
        clearSelectionAction()
      }
    })

    const handleMouseUp = (event: MouseEvent) =>
    {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      )
      selectionGestureActiveRef.current = false
      if (!shouldHandle)
      {
        return
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY }
      const delay = terminalSelectionActionDelayForClickCount(event.detail)
      selectionActionTimerRef.current = window.setTimeout(() =>
      {
        selectionActionTimerRef.current = null
        window.requestAnimationFrame(() =>
        {
          void showSelectionAction()
        })
      }, delay)
    }
    const handlePointerDown = (event: PointerEvent) =>
    {
      clipboardRequestId += 1
      clearSelectionAction()
      selectionGestureActiveRef.current = event.button === 0
    }
    const handleContextMenu = (event: MouseEvent) =>
    {
      if (shouldSuppressTerminalContextMenu(terminal.modes.mouseTrackingMode !== 'none', event))
      {
        event.preventDefault()
        return
      }
      void showTerminalContextMenu(event)
    }
    const handleNativeCopy = () =>
    {
      const shouldClearSelection = clearSelectionAfterNativeCopyRequestId === clipboardRequestId
      clearSelectionAfterNativeCopyRequestId = null
      clipboardRequestId += 1
      if (shouldClearSelection)
      {
        terminalRef.current?.clearSelection()
      }
    }
    window.addEventListener('mouseup', handleMouseUp)
    mount.addEventListener('pointerdown', handlePointerDown)
    mount.addEventListener('contextmenu', handleContextMenu)
    mount.addEventListener('copy', handleNativeCopy)

    const themeObserver = new MutationObserver(() =>
    {
      const activeTerminal = terminalRef.current
      if (!activeTerminal) return
      activeTerminal.options.theme = terminalThemeFromApp(containerRef.current)
      activeTerminal.refresh(0, activeTerminal.rows - 1)
    })
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class', 'style'],
    })

    const fitTimer = window.setTimeout(() =>
    {
      const activeTerminal = terminalRef.current
      const activeFitAddon = fitAddonRef.current
      if (!activeTerminal || !activeFitAddon) return
      const wasAtBottom =
        activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY
      fitTerminalSafely(activeFitAddon)
      if (wasAtBottom)
      {
        activeTerminal.scrollToBottom()
      }
      void resizeTerminal(activeTerminal.cols, activeTerminal.rows)
    }, 30)

    return () =>
    {
      clipboardRequestId += 1
      clearSelectionAction()
      openSelectionMenuRequestIdRef.current = null
      window.clearTimeout(fitTimer)
      inputDisposable.dispose()
      selectionDisposable.dispose()
      terminalLinksDisposable.dispose()
      if (selectionActionTimerRef.current !== null)
      {
        window.clearTimeout(selectionActionTimerRef.current)
      }
      window.removeEventListener('mouseup', handleMouseUp)
      mount.removeEventListener('pointerdown', handlePointerDown)
      mount.removeEventListener('contextmenu', handleContextMenu)
      mount.removeEventListener('copy', handleNativeCopy)
      themeObserver.disconnect()
      terminalRef.current = null
      fitAddonRef.current = null
      terminal.dispose()
    }
    // autoFocus is intentionally omitted;
    // it is only read at mount time and must not trigger terminal teardown/recreation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, environmentId, runtimeEnvKey, terminalId, threadId, worktreePath])

  useEffect(() =>
  {
    const terminal = terminalRef.current
    const current = {
      buffer: terminalBuffer,
      error: terminalError,
      status: terminalStatus,
      version: terminalVersion,
    }
    if (!terminal)
    {
      previousSessionRef.current = current
      return
    }

    const previous = previousSessionRef.current
    if (current.version === previous.version)
    {
      return
    }

    if (
      current.buffer.length >= previous.buffer.length &&
      current.buffer.startsWith(previous.buffer)
    )
    {
      terminal.write(current.buffer.slice(previous.buffer.length))
    }
    else
    {
      writeTerminalBuffer(terminal, current.buffer)
    }
    terminal.clearSelection()

    if (current.error !== null && current.error !== previous.error)
    {
      writeSystemMessage(terminal, current.error)
    }

    if (current.status === 'running')
    {
      hasHandledExitRef.current = false
    }
    else if (
      (current.status === 'closed' || current.status === 'exited') &&
      current.status !== previous.status &&
      !hasHandledExitRef.current
    )
    {
      hasHandledExitRef.current = true
      writeSystemMessage(
        terminal,
        current.status === 'closed' ? 'Terminal closed' : 'Process exited',
      )
      window.setTimeout(() =>
      {
        if (hasHandledExitRef.current)
        {
          handleSessionExited()
        }
      }, 0)
    }

    if (previous.version === 0 && autoFocus)
    {
      window.requestAnimationFrame(() =>
      {
        terminal.focus()
      })
    }
    previousSessionRef.current = current
  }, [autoFocus, terminalBuffer, terminalError, terminalStatus, terminalVersion])

  useEffect(() =>
  {
    if (!autoFocus) return
    const terminal = terminalRef.current
    if (!terminal) return
    const frame = window.requestAnimationFrame(() =>
    {
      terminal.focus()
    })
    return () =>
    {
      window.cancelAnimationFrame(frame)
    }
  }, [autoFocus, focusRequestId])

  useEffect(() =>
  {
    const terminal = terminalRef.current
    const fitAddon = fitAddonRef.current
    if (!terminal || !fitAddon) return
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY
    const frame = window.requestAnimationFrame(() =>
    {
      fitTerminalSafely(fitAddon)
      if (wasAtBottom)
      {
        terminal.scrollToBottom()
      }
      void resizeTerminal(terminal.cols, terminal.rows)
    })
    return () =>
    {
      window.cancelAnimationFrame(frame)
    }
  }, [drawerHeight, environmentId, resizeEpoch, terminalId, threadId])
  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-[var(--terminal-background)]"
    />
  )
}
