// packages/client-runtime/src/state/projectCommands.ts
// creates environment-scoped project query & command atoms

import { type EnvironmentId, type ProjectReadFileResult, WS_METHODS } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";
import {
  type CreateProjectInput,
  type DeleteProjectInput,
  type UpdateProjectInput,
  createProject,
  deleteProject,
  updateProject,
} from "../operations/commands.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

export type {
  CreateProjectInput,
  DeleteProjectInput,
  UpdateProjectInput,
} from "../operations/commands.ts";

export interface OptimisticProjectFile {
  readonly data: ProjectReadFileResult;
  readonly confirmedAgainst: object | null | undefined;
}

export interface OptimisticProjectFileTarget {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly relativePath: string;
}

function optimisticProjectFileKey(target: OptimisticProjectFileTarget): string {
  return JSON.stringify([target.environmentId, target.cwd, target.relativePath]);
}

export function createProjectEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Crypto.Crypto | R, E>,
) {
  const projectScheduler = createAtomCommandScheduler();
  const fileScheduler = createAtomCommandScheduler();
  const proposalScheduler = createAtomCommandScheduler();
  const optimisticFileFamily = Atom.family((key: string) =>
    Atom.make<OptimisticProjectFile | null>(null).pipe(
      Atom.withLabel(`environment-data:projects:optimistic-file:${key}`),
    ),
  );
  const projectConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { projectId: string } }) =>
      JSON.stringify([environmentId, input.projectId]),
  };
  return {
    searchEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:search-entries",
      tag: WS_METHODS.projectsSearchEntries,
      staleTimeMs: 15_000,
    }),
    listEntries: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:list-entries",
      tag: WS_METHODS.projectsListEntries,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    readFile: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:read-file",
      tag: WS_METHODS.projectsReadFile,
      staleTimeMs: 30_000,
      idleTtlMs: 5 * 60_000,
    }),
    readMdxDocument: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:projects:read-mdx-document",
      tag: WS_METHODS.projectsReadMdxDocument,
      staleTimeMs: 0,
      idleTtlMs: 5 * 60_000,
    }),
    listProposals: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:proposals:list",
      tag: WS_METHODS.proposalsList,
      staleTimeMs: 0,
      idleTtlMs: 5 * 60_000,
    }),
    getProposal: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:proposals:get",
      tag: WS_METHODS.proposalsGet,
      staleTimeMs: 0,
      idleTtlMs: 5 * 60_000,
    }),
    getProposalDiff: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:proposals:diff",
      tag: WS_METHODS.proposalsDiff,
      staleTimeMs: 0,
      idleTtlMs: 5 * 60_000,
    }),
    getProposalNarrative: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:proposals:narrative",
      tag: WS_METHODS.proposalsNarrative,
      staleTimeMs: 0,
      idleTtlMs: 5 * 60_000,
    }),
    findProposalByPlan: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:proposals:find-by-plan",
      tag: WS_METHODS.proposalsFindByPlan,
      staleTimeMs: 0,
      idleTtlMs: 5 * 60_000,
    }),
    getProposalGeneration: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:proposals:generation",
      tag: WS_METHODS.proposalsGetGeneration,
      staleTimeMs: 0,
      idleTtlMs: 5 * 60_000,
    }),
    latestProposalGeneration: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:proposals:latest-generation",
      tag: WS_METHODS.proposalsLatestGeneration,
      staleTimeMs: 0,
      idleTtlMs: 5 * 60_000,
    }),
    latestProposalImplementationAttempt: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:proposals:latest-implementation-attempt",
      tag: WS_METHODS.proposalsLatestImplementationAttempt,
      staleTimeMs: 0,
      idleTtlMs: 5 * 60_000,
    }),
    optimisticFile: (target: OptimisticProjectFileTarget) =>
      optimisticFileFamily(optimisticProjectFileKey(target)),
    create: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:create",
      execute: (input: CreateProjectInput) => createProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    update: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:update",
      execute: (input: UpdateProjectInput) => updateProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    delete: createEnvironmentCommand(runtime, {
      label: "environment-data:commands:project:delete",
      execute: (input: DeleteProjectInput) => deleteProject(input),
      scheduler: projectScheduler,
      concurrency: projectConcurrency,
    }),
    writeFile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:projects:write-file",
      tag: WS_METHODS.projectsWriteFile,
      scheduler: fileScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.cwd, input.relativePath]),
      },
    }),
    startProposalGeneration: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:proposals:start-generation",
      tag: WS_METHODS.proposalsStartGeneration,
      scheduler: proposalScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.proposalId]),
      },
    }),
    issueCartographerEmbed: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cartographer:issue-embed",
      tag: WS_METHODS.cartographerIssueEmbed,
      scheduler: proposalScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.generationId ?? null]),
      },
    }),
    closeCartographerEmbed: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:cartographer:close-embed",
      tag: WS_METHODS.cartographerCloseEmbed,
      scheduler: proposalScheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.sessionId]),
      },
    }),
  };
}
