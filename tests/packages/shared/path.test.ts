import { describe, expect, it } from "vite-plus/test";
import {
  isExplicitRelativePath,
  isUncPath,
  isWindowsAbsolutePath,
  isWindowsDrivePath,
} from "../../../packages/shared/src/path.ts";

describe("path helpers", () => {
  it.each([
    ["drive C:\\repo", () => isWindowsDrivePath("C:\\repo"), true],
    ["drive D:/repo", () => isWindowsDrivePath("D:/repo"), true],
    ["drive /repo", () => isWindowsDrivePath("/repo"), false],
    ["unc \\\\server\\share\\repo", () => isUncPath("\\\\server\\share\\repo"), true],
    ["unc C:\\repo", () => isUncPath("C:\\repo"), false],
    ["absolute C:\\repo", () => isWindowsAbsolutePath("C:\\repo"), true],
    ["absolute UNC", () => isWindowsAbsolutePath("\\\\server\\share\\repo"), true],
    ["absolute ./repo", () => isWindowsAbsolutePath("./repo"), false],
    ["relative .", () => isExplicitRelativePath("."), true],
    ["relative ..", () => isExplicitRelativePath(".."), true],
    ["relative ./repo", () => isExplicitRelativePath("./repo"), true],
    ["relative ..\\repo", () => isExplicitRelativePath("..\\repo"), true],
    ["relative ~/repo", () => isExplicitRelativePath("~/repo"), false],
  ] as const)("%s", (_label, run, expected) => {
    expect(run()).toBe(expected);
  });
});
