// packages/shared/src/projectFile.ts
// expose project file from json

import { ProjectFile } from '@t3tools/contracts'

import { fromLenientJson } from './schemaJson.ts'

// codec between the raw `456code.json` file contents (lenient JSONC string) and the
// decoded {@link ProjectFile}.
export const ProjectFileFromJson = fromLenientJson(ProjectFile)
