import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ProjectScriptIcon } from "./orchestration.ts";

/** File name of the checked-in 456code project file, resolved at the workspace root. */
export const PROJECT_FILE_NAME = "456code.json";

const PROJECT_FILE_PATH_MAX_LENGTH = 512;
const PROJECT_FILE_MAX_SCRIPTS = 50;

// Annotations go on the encoded (string) side so they survive into the
// published JSON Schema; decoding still trims and re-validates non-emptiness.
const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

export const ProjectFileScript = Schema.Struct({
  name: trimmedNonEmpty({
    description: "Display name for the script, shown in the 456code scripts menu.",
  }),
  command: trimmedNonEmpty({
    description: "Shell command executed in a 456code terminal at the project root.",
  }),
  icon: Schema.optionalKey(
    ProjectScriptIcon.annotate({
      description: 'Icon shown next to the script in the scripts menu. Defaults to "play".',
    }),
  ),
  runOnWorktreeCreate: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs automatically after a worktree is created for a new thread.",
    }),
  ),
  previewUrl: Schema.optionalKey(
    trimmedNonEmpty({
      description:
        "URL opened in the in-app browser preview when this script runs. Only honored on the desktop build.",
    }),
  ),
  autoOpenPreview: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, automatically open the preview panel at `previewUrl` the moment the script starts.",
    }),
  ),
}).annotate({
  description: "A project script that team members can import into 456code.",
});
export type ProjectFileScript = typeof ProjectFileScript.Type;

export const ProjectFile = Schema.Struct({
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before 456code\'s built-in icon locations.',
      },
      PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(ProjectFileScript)
      .annotate({
        description: "Project scripts shared with everyone who opens this repository in 456code.",
      })
      .check(Schema.isMaxLength(PROJECT_FILE_MAX_SCRIPTS)),
  ),
}).annotate({
  title: "456code project file",
  description:
    "Checked-in project configuration for 456code (456code.json at the repository root). See https://github.com/ggfincke/456code for documentation.",
});
export type ProjectFile = typeof ProjectFile.Type;
