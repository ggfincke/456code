// apps/web/src/hooks/useSyntaxThemeName.ts
// resolves the shiki theme that diffs and code blocks render with
import { useTheme } from "./useTheme";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";

// ocean collapses to a dark resolvedTheme for chrome, so the preference itself
// decides whether code gets the ocean palette
export function useSyntaxThemeName(): DiffThemeName {
  const { theme, resolvedTheme } = useTheme();
  return resolveDiffThemeName(theme === "ocean" ? "ocean" : resolvedTheme);
}
