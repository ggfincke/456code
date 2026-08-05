// apps/mobile/src/features/threads/git/git-overview-navigation.ts
// resolve git overview review navigation action

export function resolveGitOverviewReviewNavigationAction(
  presentation: 'sheet' | 'inspector',
): 'replace' | 'navigate'
{
  return presentation === 'sheet' ? 'replace' : 'navigate'
}
