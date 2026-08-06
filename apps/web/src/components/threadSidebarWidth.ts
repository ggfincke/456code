// apps/web/src/components/threadSidebarWidth.ts
// resolve thread sidebar maximum width

export const THREAD_SIDEBAR_WIDTH_STORAGE_KEY = 'chat_thread_sidebar_width'
export const THREAD_SIDEBAR_DEFAULT_WIDTH = 16 * 16
export const THREAD_SIDEBAR_MIN_WIDTH = 13 * 16
export const THREAD_MAIN_CONTENT_MIN_WIDTH = 40 * 16
// keep the left sidebar less dominant than the right panel's 70% cap.
const THREAD_SIDEBAR_MAX_WIDTH_FRACTION = 0.6

export function resolveThreadSidebarMaximumWidth(viewportWidth: number): number
{
  return Math.max(
    THREAD_SIDEBAR_MIN_WIDTH,
    Math.min(
      Math.floor(viewportWidth * THREAD_SIDEBAR_MAX_WIDTH_FRACTION),
      Math.floor(viewportWidth) - THREAD_MAIN_CONTENT_MIN_WIDTH,
    ),
  )
}

export function resolveInitialThreadSidebarWidth(
  storedWidth: number | null,
  viewportWidth: number,
): number
{
  const preferredWidth =
    storedWidth === null
      ? THREAD_SIDEBAR_DEFAULT_WIDTH
      : Math.max(THREAD_SIDEBAR_MIN_WIDTH, storedWidth)
  return Math.min(preferredWidth, resolveThreadSidebarMaximumWidth(viewportWidth))
}
