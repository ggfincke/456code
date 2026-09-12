import type { AnalysisCoverage } from "./types.js";

export const ANALYSIS_COVERAGE_EXAMPLE_LIMIT = 20;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isAnalysisCoverage(value: unknown): value is AnalysisCoverage {
  if (
    !record(value) ||
    !count(value.analyzedFiles) ||
    !Array.isArray(value.supportedLanguages) ||
    value.supportedLanguages.length !== 2 ||
    value.supportedLanguages[0] !== "javascript" ||
    value.supportedLanguages[1] !== "typescript" ||
    !record(value.unresolvedLocalImports)
  )
    return false;
  const unresolved = value.unresolvedLocalImports;
  return (
    count(unresolved.total) &&
    count(unresolved.omitted) &&
    Array.isArray(unresolved.examples) &&
    unresolved.examples.length <= ANALYSIS_COVERAGE_EXAMPLE_LIMIT &&
    unresolved.examples.length + unresolved.omitted === unresolved.total &&
    unresolved.examples.every(
      (example: unknown) =>
        record(example) &&
        typeof example.fileId === "string" &&
        example.fileId.length > 0 &&
        example.fileId.length <= 4096 &&
        typeof example.specifier === "string" &&
        example.specifier.length > 0 &&
        example.specifier.length <= 1024,
    )
  );
}
