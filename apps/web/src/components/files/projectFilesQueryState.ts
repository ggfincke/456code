// apps/web/src/components/files/projectFilesQueryState.ts
// coordinates project file source, optimistic edits & MDX document queries

import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { OptimisticProjectFile } from "@t3tools/client-runtime/state/projects";
import type {
  EnvironmentId,
  ProjectListEntriesResult,
  ProjectReadMdxDocumentResult,
  ProjectReadFileResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { projectEnvironment } from "~/state/projects";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";

const EMPTY_PROJECT_FILE_PATH = "";
const EMPTY_PROJECT_FILE_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectReadFileResult, never>(false),
).pipe(Atom.withLabel("project-file-query:empty"));
const EMPTY_PROJECT_MDX_DOCUMENT_QUERY_ATOM = Atom.make(
  AsyncResult.initial<ProjectReadMdxDocumentResult, never>(false),
).pipe(Atom.withLabel("project-mdx-document-query:empty"));
function optimisticFileAtom(environmentId: EnvironmentId, cwd: string, relativePath: string) {
  return projectEnvironment.optimisticFile({ environmentId, cwd, relativePath });
}

interface ProjectQueryState<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly refresh: () => void;
}

export function getProjectEntriesQueryAtom(environmentId: EnvironmentId, cwd: string) {
  return projectEnvironment.listEntries({ environmentId, input: { cwd } });
}

export function getProjectFileQueryAtom(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
) {
  return projectEnvironment.readFile({
    environmentId,
    input: { cwd, relativePath: relativePath ?? EMPTY_PROJECT_FILE_PATH },
  });
}

export function getProjectMdxDocumentQueryAtom(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  relativePath: string,
) {
  return projectEnvironment.readMdxDocument({
    environmentId,
    input: { threadId, relativePath },
  });
}

export function setProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): void {
  appAtomRegistry.set(optimisticFileAtom(environmentId, cwd, relativePath), {
    confirmedAgainst: undefined,
    data: {
      relativePath,
      contents,
      byteLength: new TextEncoder().encode(contents).byteLength,
      truncated: false,
    },
  });
}

export function getOptimisticProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): ProjectReadFileResult | null {
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? null;
}

export function confirmProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  contents: string,
): boolean {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  const optimisticFile = appAtomRegistry.get(atom);
  if (optimisticFile?.data.contents !== contents) return false;

  const queryAtom = getProjectFileQueryAtom(environmentId, cwd, relativePath);
  const confirmed = {
    ...optimisticFile,
    confirmedAgainst: appAtomRegistry.get(queryAtom),
  };
  appAtomRegistry.set(atom, confirmed);
  appAtomRegistry.refresh(queryAtom);
  void executeAtomQuery(appAtomRegistry, queryAtom, {
    reportDefect: false,
    reportFailure: false,
  }).then((result) => {
    if (result._tag === "Success" && appAtomRegistry.get(atom) === confirmed) {
      appAtomRegistry.set(atom, null);
    }
  });
  return true;
}

export function confirmProjectMdxFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  threadId: ThreadId,
  relativePath: string,
  contents: string,
): boolean {
  const confirmed = confirmProjectFileQueryData(environmentId, cwd, relativePath, contents);
  if (!confirmed) return false;

  appAtomRegistry.refresh(getProjectMdxDocumentQueryAtom(environmentId, threadId, relativePath));
  return true;
}

export function resolveProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  data: ProjectReadFileResult | null,
): ProjectReadFileResult | null {
  if (relativePath === null) return data;
  return appAtomRegistry.get(optimisticFileAtom(environmentId, cwd, relativePath))?.data ?? data;
}

export function clearProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
): void {
  appAtomRegistry.set(optimisticFileAtom(environmentId, cwd, relativePath), null);
}

export function isConfirmedProjectFileQuerySuperseded(
  optimisticFile: OptimisticProjectFile | null,
  queryResult: AsyncResult.AsyncResult<ProjectReadFileResult, unknown>,
): boolean {
  return (
    optimisticFile?.confirmedAgainst !== undefined &&
    optimisticFile.confirmedAgainst !== queryResult &&
    queryResult._tag === "Success" &&
    !queryResult.waiting
  );
}

export function clearConfirmedProjectFileQueryData(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string,
  confirmedFile: OptimisticProjectFile,
): boolean {
  const atom = optimisticFileAtom(environmentId, cwd, relativePath);
  if (appAtomRegistry.get(atom) !== confirmedFile) return false;
  appAtomRegistry.set(atom, null);
  return true;
}

function errorMessage<A>(result: AsyncResult.AsyncResult<A, unknown>): string | null {
  if (result._tag !== "Failure") return null;
  const cause = Cause.squash(result.cause);
  return cause instanceof Error ? cause.message : "Workspace query failed.";
}

export function useProjectEntriesQuery(
  environmentId: EnvironmentId,
  cwd: string,
): ProjectQueryState<ProjectListEntriesResult> {
  const atom = getProjectEntriesQueryAtom(environmentId, cwd);
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  };
}

export function useProjectFileQuery(
  environmentId: EnvironmentId,
  cwd: string,
  relativePath: string | null,
  enabled = true,
): ProjectQueryState<ProjectReadFileResult> {
  const atom = enabled
    ? getProjectFileQueryAtom(environmentId, cwd, relativePath)
    : EMPTY_PROJECT_FILE_QUERY_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);
  const data = Option.getOrNull(AsyncResult.value(result));
  const optimisticAtom = optimisticFileAtom(
    environmentId,
    cwd,
    relativePath ?? EMPTY_PROJECT_FILE_PATH,
  );
  const optimisticResult = useAtomValue(optimisticAtom);
  const optimisticFile = relativePath === null ? null : optimisticResult;
  const confirmedFileSuperseded = isConfirmedProjectFileQuerySuperseded(optimisticFile, result);

  useEffect(() => {
    if (!confirmedFileSuperseded || optimisticFile === null || relativePath === null) return;
    clearConfirmedProjectFileQueryData(environmentId, cwd, relativePath, optimisticFile);
  }, [confirmedFileSuperseded, cwd, environmentId, optimisticFile, relativePath]);

  return {
    data: confirmedFileSuperseded ? data : (optimisticFile?.data ?? data),
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  };
}

export function useProjectMdxDocumentQuery(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  relativePath: string,
  enabled = true,
): ProjectQueryState<ProjectReadMdxDocumentResult> {
  const atom = enabled
    ? getProjectMdxDocumentQueryAtom(environmentId, threadId, relativePath)
    : EMPTY_PROJECT_MDX_DOCUMENT_QUERY_ATOM;
  const result = useAtomValue(atom);
  const refreshAtom = useAtomRefresh(atom);
  const refresh = useCallback(() => refreshAtom(), [refreshAtom]);

  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: errorMessage(result),
    isPending: result.waiting,
    refresh,
  };
}
