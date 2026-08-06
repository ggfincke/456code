// apps/web/src/lib/projectPaths.ts
// provide the stable web facade for shared project path helpers

export {
  appendBrowsePathSegment,
  canNavigateUp,
  ensureBrowseDirectoryPath,
  findProjectByPath,
  getBrowseDirectoryPath,
  getBrowseLeafPathSegment,
  getBrowseParentPath,
  hasTrailingPathSeparator,
  inferProjectTitleFromPath,
  isExplicitRelativeProjectPath,
  isFilesystemBrowseQuery,
  isUnsupportedWindowsProjectPath,
  normalizeProjectPathForComparison,
  normalizeProjectPathForDispatch,
  resolveProjectPathForDispatch,
} from '@t3tools/client-runtime/state/projects'
