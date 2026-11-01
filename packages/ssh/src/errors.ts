import * as Data from "effect/Data";

export class SshInvalidTargetError extends Data.TaggedError("SshInvalidTargetError")<{
  readonly message: string;
}> {}

export class SshCommandError extends Data.TaggedError("SshCommandError")<{
  readonly message: string;
  readonly command: readonly string[];
  readonly exitCode: number | null;
  readonly stderr: string;
  readonly stdout?: string;
  readonly cause?: unknown;
}> {}
