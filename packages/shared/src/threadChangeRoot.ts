// packages/shared/src/threadChangeRoot.ts
// resolve the tree a thread's changes live in

// one precedence rule, one implementation, shared by the web client's sidebar
// row, chat header and diff panel and by mobile's selected-thread hook. the
// total order is: the active orchestrate run's integration worktree, then the
// thread's own worktree, then the project workspace root. duplicating this
// across those four call sites is how the sidebar ended up gating differently
// from the diff panel and both ended up reading a tree the run never wrote to.
//
// * pure by design, and that puts the whole duty on the writer. the checkpoint
// reactor owns both halves: it adopts a tree only after proving the two share a
// git common dir, and on every capture it releases the target again once the
// path stops resolving as a worktree of its own or the thread's own tree starts
// recording the work. with the field cleared this degrades to
// `worktreePath ?? workspaceRoot`; left stale it would point every surface at a
// pruned directory, where a git status reports "not a git repository" rather
// than failing, which is worse than the wrong-tree bug.
// ! the release runs at turn boundaries, so a tree pruned while the thread is
// idle stays recorded until its next turn. `orchestrateRunWorktreeIsNotRepository`
// closes that window from the read side: a caller holding a git status for the
// adopted path itself reports `isRepo === false` here and gets the thread's own
// tree back, instead of gating its evidence off behind a directory that no
// longer exists. it stays an input rather than a probe so this function keeps
// being pure
export function resolveThreadChangeRoot(input: {
  readonly orchestrateRunWorktreePath: string | null | undefined
  readonly worktreePath: string | null | undefined
  readonly workspaceRoot: string | null | undefined
  readonly orchestrateRunWorktreeIsNotRepository?: boolean | undefined
}): string | null
{
  // a caller that has proven the adopted tree is gone drops it out of the chain
  // rather than resolving every surface onto a pruned directory
  const orchestrateRunWorktreePath =
    input.orchestrateRunWorktreeIsNotRepository === true ? null : input.orchestrateRunWorktreePath
  return orchestrateRunWorktreePath ?? input.worktreePath ?? input.workspaceRoot ?? null
}
