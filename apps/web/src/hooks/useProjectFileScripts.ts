import { PROJECT_FILE_NAME, type EnvironmentId, type ProjectFileScript } from "@t3tools/contracts";
import { ProjectFileFromJson } from "@t3tools/shared/projectFile";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const decodeProjectFile = Schema.decodeExit(ProjectFileFromJson);

const NO_SCRIPTS: ReadonlyArray<ProjectFileScript> = [];

/**
 * Scripts declared in the project's checked-in `456code.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<ProjectFileScript> {
  const query = useProjectFileQuery(environmentId, cwd ?? "", PROJECT_FILE_NAME, cwd !== null);
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  return useMemo(() => {
    if (contents === null) return NO_SCRIPTS;
    const decoded = decodeProjectFile(contents);
    if (Exit.isFailure(decoded)) return NO_SCRIPTS;
    return decoded.value.scripts ?? NO_SCRIPTS;
  }, [contents]);
}
