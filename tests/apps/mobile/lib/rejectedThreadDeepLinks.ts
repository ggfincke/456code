// tests/apps/mobile/lib/rejectedThreadDeepLinks.ts
// shared deny-list samples for thread deep-link allowlists

// common rejects for shortcutHref + extractAgentNotificationDeepLink;
// keep entrypoint-specific edges (non-string href, empty payload, /new/extra) local
export const REJECTED_THREAD_DEEP_LINKS = [
  'https://evil.example',
  '//evil.example',
  '/settings',
  '/threads/only-one-segment',
  '/threads/a/b/c',
  '/threads//x',
  '/threads/a/b?x=1',
  '/threads/a/b#frag',
] as const
