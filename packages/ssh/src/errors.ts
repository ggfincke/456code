import * as Schema from "effect/Schema";

export class SshInvalidTargetError extends Schema.TaggedError<SshInvalidTargetError>()(
  "SshInvalidTargetError",
  {
    message: Schema.String,
  },
) {}

export class SshCommandError extends Schema.TaggedError<SshCommandError>()("SshCommandError", {
  message: Schema.String,
  command: Schema.Array(Schema.String),
  exitCode: Schema.NullOr(Schema.Number),
  stderr: Schema.String,
  stdout: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {}
