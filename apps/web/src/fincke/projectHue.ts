// apps/web/src/fincke/projectHue.ts
// a project's stable folder hue as a css var, for sidebar rows & the thread header
import { finckeFolderTint } from "@t3tools/shared/fincke-folder-tint";
import type { CSSProperties } from "react";

// "No project" has no folder, so it keeps the neutral look
export function projectHueStyle(
  project: { readonly id: string; readonly isScratch?: boolean } | null | undefined,
): CSSProperties | undefined {
  if (!project || project.isScratch) return undefined;
  return {
    "--project-hue": `var(--fincke-${finckeFolderTint(project.id).token})`,
  } as CSSProperties;
}
