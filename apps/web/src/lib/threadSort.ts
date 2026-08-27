// apps/web/src/lib/threadSort.ts
// provide the stable web facade for shared thread sort helpers

export {
  activeThreadAnchorTimestampMs,
  getLatestThreadForProject,
  getThreadSortTimestamp,
  sortThreads,
  toSortableTimestamp,
  type ThreadSortInput,
} from '@t3tools/client-runtime/state/thread-sort'
