// apps/web/src/hooks/useHandleNewThread.ts
// starts draft threads with project and machine defaults

import { useAtomValue } from '@effect/atom-react'
import {
  scopedProjectKey,
  scopeProjectRef,
  scopeThreadRef,
} from '@t3tools/client-runtime/environment'
import {
  DEFAULT_RUNTIME_MODE,
  normalizeCollaborationMode,
  type ScopedProjectRef,
} from '@t3tools/contracts'
import { useParams, useRouter } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'
import {
  markPromotedDraftThreadByRef,
  type ComposerThreadDraftState,
  DraftId,
  type DraftThreadEnvMode,
  type DraftThreadState,
  useComposerDraftStore,
} from '../composerDraftStore'
import { newDraftId, newThreadId } from '../lib/utils'
import { orderItemsByPreferredIds } from '../components/Sidebar.logic'
import {
  deriveLogicalProjectKeyFromSettings,
  getProjectOrderKey,
  selectProjectGroupingSettings,
} from '../logicalProject'
import { readThreadShell, useProjects, useThread } from '../state/entities'
import { resolveNewDraftStartFromOrigin } from '../lib/chatThreadActions'
import { primaryServerSettingsAtom } from '../state/server'
import { resolveThreadRouteTarget } from '../threadRoutes'
import { legacyProjectCwdPreferenceKey, useUiStateStore } from '../uiStateStore'
import { useClientSettings } from './useSettings'

function composerDraftHasUserContent(draft: ComposerThreadDraftState | null | undefined): boolean
{
  if (!draft)
  {
    return false
  }
  return (
    draft.prompt.trim().length > 0 ||
    draft.images.length > 0 ||
    draft.persistedAttachments.length > 0 ||
    draft.terminalContexts.length > 0 ||
    draft.elementContexts.length > 0 ||
    draft.previewAnnotations.length > 0 ||
    draft.reviewComments.length > 0
  )
}

export function useNewThreadHandler()
{
  const projects = useProjects()
  // new-thread defaults are a user preference, and the settings UI only ever
  // edits the primary environment's settings.json. Reading the target
  // environment's own settings here would silently reset remote projects to
  // the decoded defaults ("local" mode, current branch), since nothing can
  // set those values on a remote server.
  const primaryServerSettings = useAtomValue(primaryServerSettingsAtom)
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings)
  const router = useRouter()
  const getCurrentRouteTarget = useCallback(() =>
  {
    const currentRouteParams = router.state.matches[router.state.matches.length - 1]?.params ?? {}
    return resolveThreadRouteTarget(currentRouteParams)
  }, [router])

  return useCallback(
    (
      projectRef: ScopedProjectRef,
      options?: {
        branch?: string | null
        worktreePath?: string | null
        envMode?: DraftThreadEnvMode
        startFromOrigin?: boolean
        replace?: boolean
        // carries only typed text and images when the draft repo picker changes projects.
        carryComposerContent?: boolean
      },
    ): Promise<void> =>
    {
      const {
        getComposerDraft,
        getDraftSessionByLogicalProjectKey,
        getDraftSession,
        getDraftThread,
        applyStickyState,
        moveComposerPromptAndImages,
        setDraftThreadContext,
        setLogicalProjectDraftThreadId,
        setModelSelection,
      } = useComposerDraftStore.getState()
      const currentRouteTarget = getCurrentRouteTarget()
      // a new thread carries the user's *working mode* from the thread being
      // viewed: model (including options like reasoning effort and context
      // window), permission mode, and collaboration mode. Branch, worktree, and
      // env mode never carry implicitly — those come from the configured
      // defaults unless the caller passes them explicitly.
      const carrySourceShell =
        currentRouteTarget?.kind === 'server' ? readThreadShell(currentRouteTarget.threadRef) : null
      const carrySourceDraft =
        currentRouteTarget?.kind === 'draft' ? getDraftSession(currentRouteTarget.draftId) : null
      // composer overrides win over the persisted thread state — they are
      // what the user currently sees in the composer controls.
      const carrySourceComposer = currentRouteTarget
        ? getComposerDraft(
            currentRouteTarget.kind === 'server'
              ? currentRouteTarget.threadRef
              : currentRouteTarget.draftId,
          )
        : null
      const composerActiveProvider = carrySourceComposer?.activeProvider ?? null
      const composerModelSelection = composerActiveProvider
        ? (carrySourceComposer?.modelSelectionByProvider[composerActiveProvider] ?? null)
        : null
      const carryModelSelection = composerModelSelection ?? carrySourceShell?.modelSelection ?? null
      const carryRuntimeMode =
        carrySourceComposer?.runtimeMode ??
        carrySourceShell?.runtimeMode ??
        carrySourceDraft?.runtimeMode ??
        null
      const carryCollaborationMode =
        carrySourceComposer?.collaborationMode ??
        (carrySourceShell
          ? normalizeCollaborationMode(
              carrySourceShell.interactionMode,
              carrySourceShell.orchestrate,
            )
          : null) ??
        carrySourceDraft?.collaborationMode ??
        null
      const carryContentSourceDraftId =
        options?.carryComposerContent === true && currentRouteTarget?.kind === 'draft'
          ? currentRouteTarget.draftId
          : null
      const carryComposerContentTo = (destinationDraftId: DraftId): void =>
      {
        if (
          carryContentSourceDraftId &&
          carryContentSourceDraftId !== destinationDraftId &&
          !composerDraftHasUserContent(getComposerDraft(destinationDraftId)) &&
          composerDraftHasUserContent(getComposerDraft(carryContentSourceDraftId))
        )
        {
          moveComposerPromptAndImages(carryContentSourceDraftId, destinationDraftId)
        }
      }
      const project = projects.find(
        (candidate) =>
          candidate.id === projectRef.projectId &&
          candidate.environmentId === projectRef.environmentId,
      )
      const logicalProjectKey = project
        ? deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings)
        : scopedProjectKey(projectRef)
      const hasBranchOption = options?.branch !== undefined
      const hasWorktreePathOption = options?.worktreePath !== undefined
      const hasEnvModeOption = options?.envMode !== undefined
      const hasStartFromOriginOption = options?.startFromOrigin !== undefined
      const storedDraftThread = getDraftSessionByLogicalProjectKey(logicalProjectKey)
      const storedDraftThreadRef = storedDraftThread
        ? scopeThreadRef(storedDraftThread.environmentId, storedDraftThread.threadId)
        : null
      const reusableStoredDraftThread =
        storedDraftThreadRef && readThreadShell(storedDraftThreadRef) !== null
          ? null
          : storedDraftThread
      if (storedDraftThreadRef && reusableStoredDraftThread === null)
      {
        markPromotedDraftThreadByRef(storedDraftThreadRef)
      }
      const latestActiveDraftThread: DraftThreadState | null = currentRouteTarget
        ? currentRouteTarget.kind === 'server'
          ? getDraftThread(currentRouteTarget.threadRef)
          : getDraftSession(currentRouteTarget.draftId)
        : null
      if (reusableStoredDraftThread)
      {
        return (async () =>
        {
          const isDraftAlreadyOpen =
            currentRouteTarget?.kind === 'draft' &&
            currentRouteTarget.draftId === reusableStoredDraftThread.draftId
          const hasExplicitWorkspaceOption =
            hasBranchOption || hasWorktreePathOption || hasEnvModeOption || hasStartFromOriginOption
          // resurrecting a stored draft must not resurrect its stale context:
          // explicit workspace options win outright; otherwise the env context
          // resets to the configured defaults so drafts seeded before a
          // defaults change (or by the old carry-over behavior) stop landing
          // on "current checkout" branches forever. Composer text is
          // preserved. When the draft is already open and no options were
          // passed, leave it alone entirely — the user may have just picked a
          // branch in the composer.
          const defaultEnvMode = primaryServerSettings.defaultThreadEnvMode
          const workspaceContext = hasExplicitWorkspaceOption
            ? {
                ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
                ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
                ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
                ...(hasStartFromOriginOption ? { startFromOrigin: options?.startFromOrigin } : {}),
              }
            : isDraftAlreadyOpen
              ? null
              : {
                  branch: null,
                  worktreePath: null,
                  envMode: defaultEnvMode,
                  startFromOrigin: resolveNewDraftStartFromOrigin({
                    envMode: defaultEnvMode,
                    newWorktreesStartFromOrigin: primaryServerSettings.newWorktreesStartFromOrigin,
                  }),
                }
          if (workspaceContext)
          {
            setDraftThreadContext(reusableStoredDraftThread.draftId, {
              ...workspaceContext,
              ...(carryRuntimeMode ? { runtimeMode: carryRuntimeMode } : {}),
              ...(carryCollaborationMode ? { collaborationMode: carryCollaborationMode } : {}),
            })
            if (carryModelSelection)
            {
              // the carried selection is a complete snapshot of the viewed
              // thread's model state: absent options mean "no options", not
              // "keep the stale draft's options".
              setModelSelection(reusableStoredDraftThread.draftId, carryModelSelection, {
                replaceOptions: true,
              })
            }
          }
          // carry workspace context across physical members of a logical project
          setLogicalProjectDraftThreadId(
            logicalProjectKey,
            projectRef,
            reusableStoredDraftThread.draftId,
            {
              threadId: reusableStoredDraftThread.threadId,
              ...workspaceContext,
              ...(carryRuntimeMode ? { runtimeMode: carryRuntimeMode } : {}),
              ...(carryCollaborationMode ? { collaborationMode: carryCollaborationMode } : {}),
            },
          )
          carryComposerContentTo(reusableStoredDraftThread.draftId)
          if (
            currentRouteTarget?.kind === 'draft' &&
            currentRouteTarget.draftId === reusableStoredDraftThread.draftId
          )
          {
            return
          }
          await router.navigate({
            to: '/draft/$draftId',
            params: { draftId: reusableStoredDraftThread.draftId },
            replace: options?.replace ?? false,
          })
        })()
      }

      if (
        latestActiveDraftThread &&
        currentRouteTarget?.kind === 'draft' &&
        latestActiveDraftThread.logicalProjectKey === logicalProjectKey &&
        latestActiveDraftThread.promotedTo == null
      )
      {
        if (
          hasBranchOption ||
          hasWorktreePathOption ||
          hasEnvModeOption ||
          hasStartFromOriginOption
        )
        {
          setDraftThreadContext(currentRouteTarget.draftId, {
            ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
            ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
            ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
            ...(hasStartFromOriginOption ? { startFromOrigin: options?.startFromOrigin } : {}),
          })
        }
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, currentRouteTarget.draftId, {
          threadId: latestActiveDraftThread.threadId,
          createdAt: latestActiveDraftThread.createdAt,
          runtimeMode: latestActiveDraftThread.runtimeMode,
          collaborationMode: latestActiveDraftThread.collaborationMode,
          ...(hasBranchOption ? { branch: options?.branch ?? null } : {}),
          ...(hasWorktreePathOption ? { worktreePath: options?.worktreePath ?? null } : {}),
          ...(hasEnvModeOption ? { envMode: options?.envMode } : {}),
          ...(hasStartFromOriginOption ? { startFromOrigin: options?.startFromOrigin } : {}),
        })
        return Promise.resolve()
      }

      const draftId = newDraftId()
      const threadId = newThreadId()
      const createdAt = new Date().toISOString()
      const initialEnvMode = options?.envMode ?? primaryServerSettings.defaultThreadEnvMode
      return (async () =>
      {
        setLogicalProjectDraftThreadId(logicalProjectKey, projectRef, draftId, {
          threadId,
          createdAt,
          branch: options?.branch ?? null,
          worktreePath: options?.worktreePath ?? null,
          envMode: initialEnvMode,
          startFromOrigin:
            options?.startFromOrigin ??
            resolveNewDraftStartFromOrigin({
              envMode: initialEnvMode,
              newWorktreesStartFromOrigin: primaryServerSettings.newWorktreesStartFromOrigin,
            }),
          runtimeMode: carryRuntimeMode ?? DEFAULT_RUNTIME_MODE,
          ...(carryCollaborationMode ? { collaborationMode: carryCollaborationMode } : {}),
        })
        applyStickyState(draftId)
        if (carryModelSelection)
        {
          // after sticky state so the viewed thread's exact selection
          // (model + options like effort and context window) wins over the
          // globally sticky one. replaceOptions: the carried selection is a
          // complete snapshot — absent options mean "no options", not "keep
          // whatever sticky state just wrote".
          setModelSelection(draftId, carryModelSelection, { replaceOptions: true })
        }
        carryComposerContentTo(draftId)

        await router.navigate({
          to: '/draft/$draftId',
          params: { draftId },
          replace: options?.replace ?? false,
        })
      })()
    },
    [getCurrentRouteTarget, primaryServerSettings, projectGroupingSettings, projects, router],
  )
}

export function useHandleNewThread()
{
  const projectOrder = useUiStateStore((store) => store.projectOrder)
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  })
  const routeThreadRef = routeTarget?.kind === 'server' ? routeTarget.threadRef : null
  const activeThread = useThread(routeThreadRef)
  const getDraftThread = useComposerDraftStore((store) => store.getDraftThread)
  const activeDraftThread = useComposerDraftStore(() =>
    routeTarget
      ? routeTarget.kind === 'server'
        ? getDraftThread(routeTarget.threadRef)
        : useComposerDraftStore.getState().getDraftSession(routeTarget.draftId)
      : null,
  )
  const projects = useProjects()
  const orderedProjects = useMemo(() =>
  {
    return orderItemsByPreferredIds({
      items: projects,
      preferredIds: projectOrder,
      getId: getProjectOrderKey,
      getPreferenceIds: (project) => [
        getProjectOrderKey(project),
        legacyProjectCwdPreferenceKey(project.workspaceRoot),
      ],
    })
  }, [projectOrder, projects])
  const handleNewThread = useNewThreadHandler()

  return {
    activeDraftThread,
    activeThread,
    defaultProjectRef: orderedProjects[0]
      ? scopeProjectRef(orderedProjects[0].environmentId, orderedProjects[0].id)
      : null,
    handleNewThread,
    routeThreadRef,
  }
}
