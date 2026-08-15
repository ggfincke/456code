#!/usr/bin/env python3
# scripts/check_comment_style.py
# check comments across owned Swift, Kotlin, shell, & Python sources

from __future__ import annotations

import argparse
import ast
import io
import re
import subprocess
import sys
import tokenize
from dataclasses import dataclass
from pathlib import Path

SUPPORTED_SUFFIXES = {".swift", ".kt", ".kts", ".sh", ".bash", ".zsh", ".py"}
SKIP_PARTS = {
    ".build",
    ".gradle",
    ".repos",
    ".venv",
    "Carthage",
    "DerivedData",
    "Pods",
    "Vendor",
    "__pycache__",
    "build",
    "generated",
    "migrations",
    "node_modules",
    "vendor",
}
NATIVE_PROJECT_PREFIXES = ("apps/mobile/android/", "apps/mobile/ios/")
TEST_PARTS = {"e2e", "test", "tests"}
TODO_PREFIX_RE = re.compile(r"^(?:#|//)\s*todo\b", re.IGNORECASE)
VALID_TODO_RE = re.compile(r"^(?:#|//) TODO(?:\([a-z][a-z0-9._/-]*\):)?\s+\S")
TAG_PREFIX_RE = re.compile(r"^(?:#|//)\s*([*!?])")
VALID_TAG_RE = re.compile(r"^(?:#|//) [*!?] \S")
# colon form flags any casing; the bare form must be ALL-CAPS so ordinary
# sentences starting with "note ..." or "warning ..." stay legal
LEGACY_TAG_COLON_RE = re.compile(
    r"^(?:#|//)\s*(?:FOOTGUN|HACK|NOTE|WARN(?:ING)?|FIXME|XXX)\s*:\s*",
    re.IGNORECASE,
)
LEGACY_TAG_BARE_RE = re.compile(
    r"^(?:#|//)\s*(?:FOOTGUN|HACK|NOTE|WARN(?:ING)?|FIXME|XXX)(?=\s|$)",
)
BLOCK_TODO_RE = re.compile(r"(?:^|\n)\s*\*?\s*TODO(?:\b|\()", re.IGNORECASE)
SWIFT_DOC_TODO_RE = re.compile(r"^///\s*TODO(?:\b|\()", re.IGNORECASE)
DECORATIVE_BANNER_RE = re.compile(r"^(?:#|//)\s*(?:={3,}|-{3,})\s*$")
PLAIN_COMMENT_RE = re.compile(r"^(?:#|//)\s+([A-Z][^\s]*)")
SUMMARY_START_RE = re.compile(r"^(?:[A-Z0-9]|[`'\"(\[]|[a-z][A-Z])")
SUMMARY_PERIOD_RE = re.compile(r"[.!?](?:[`'\"\])}]*)$")
PYTHON_ENCODING_RE = re.compile(r"coding[:=]\s*[-\w.]+")
PYTHON_TOOLING_RE = re.compile(
    r"^#\s*(?:noqa\b|type:\s*ignore\b|pragma:\s*no cover\b|pyright:|mypy:|ruff:|fmt:|isort:|coverage:)",
    re.IGNORECASE,
)
SHELL_TOOLING_RE = re.compile(r"^#\s*shellcheck\b", re.IGNORECASE)
SLASH_TOOLING_RE = re.compile(r"^//\s*(?:swiftlint:|noinspection\b|ktlint-|detekt:)", re.IGNORECASE)
SWIFT_TYPE_RE = re.compile(
    r"^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|open|internal|fileprivate|private|final|indirect)\s+)*"
    r"(?:class|struct|enum|actor|protocol)\b"
)
KOTLIN_TYPE_RE = re.compile(
    r"^(?:@[\w.]+(?:\([^)]*\))?\s+)*(?:(?:public|internal|private|protected|data|sealed|value|annotation|enum)\s+)*"
    r"(?:class|interface|object)\b"
)

ROOT = Path.cwd()


@dataclass(frozen=True)
class Violation:
    path: Path
    line: int
    message: str

    def render(self) -> str:
        return f"{self.path.relative_to(ROOT).as_posix()}:{self.line}: {self.message}"


@dataclass(frozen=True)
class LineComment:
    line: int
    column: int
    text: str
    tooling: bool


@dataclass(frozen=True)
class BlockComment:
    line: int
    text: str
    documentation: bool
    target: str | None


def resolve_root(explicit: Path | None) -> Path:
    if explicit is not None:
        return explicit.resolve()
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            capture_output=True,
            check=True,
            text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        return Path.cwd().resolve()
    return Path(result.stdout.strip()).resolve()


def repo_path(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def is_within(path: Path, parent: Path) -> bool:
    resolved = path.resolve()
    root = parent.resolve()
    return resolved == root or root in resolved.parents


def is_exempt(path: Path) -> bool:
    relative = repo_path(path)
    return (
        any(relative.startswith(prefix) for prefix in NATIVE_PROJECT_PREFIXES)
        or bool(SKIP_PARTS.intersection(Path(relative).parts))
    )


def discover_paths(values: list[Path]) -> list[Path]:
    found: set[Path] = set()
    for value in values:
        path = value if value.is_absolute() else ROOT / value
        path = path.resolve()
        if not is_within(path, ROOT):
            raise ValueError(f"{path} is outside --root {ROOT}")
        if not path.exists():
            raise ValueError(f"{path} does not exist")
        if path.is_file():
            if path.suffix not in SUPPORTED_SUFFIXES:
                raise ValueError(f"{path} is not a supported source file")
            candidates = [path]
        elif path.is_dir():
            candidates = [
                candidate
                for candidate in path.rglob("*")
                if candidate.is_file() and candidate.suffix in SUPPORTED_SUFFIXES
            ]
        else:
            raise ValueError(f"{path} is not a file or directory")

        eligible = [candidate for candidate in candidates if not is_exempt(candidate)]
        found.update(eligible)
    if not found:
        raise ValueError("selected paths have no supported source files")
    return sorted(found)


def prelude_length(path: Path, lines: list[str]) -> int:
    count = 1 if lines and lines[0].startswith("#!") else 0
    if path.suffix == ".py" and count < len(lines) and PYTHON_ENCODING_RE.search(lines[count]):
        count += 1
    return count


def comment_prefix(path: Path) -> str:
    return "# " if path.suffix in {".py", ".sh", ".bash", ".zsh"} else "// "


def header_violations(path: Path, lines: list[str]) -> list[Violation]:
    index = prelude_length(path, lines)
    prefix = comment_prefix(path)
    expected = f"{prefix}{repo_path(path)}"
    violations: list[Violation] = []
    if len(lines) <= index or lines[index].rstrip("\r\n") != expected:
        violations.append(Violation(path, index + 1, f'file header must be "{expected}"'))
    if len(lines) <= index + 1 or not lines[index + 1].startswith(prefix):
        violations.append(Violation(path, index + 2, "file header needs a lowercase purpose phrase"))
        return violations
    purpose = lines[index + 1].removeprefix(prefix).strip()
    if not purpose or not re.match(r"^[a-z0-9]", purpose):
        violations.append(Violation(path, index + 2, "file header purpose must begin lowercase"))
    if purpose.endswith("."):
        violations.append(Violation(path, index + 2, "file header purpose must not end with a period"))
    if re.match(r"^(?:[*!?](?:\s|$)|todo(?:\([^)]*\))?:?\s)", purpose, re.IGNORECASE):
        violations.append(Violation(path, index + 2, "file header purpose must not use an annotation tag"))
    if len(lines) > index + 2 and lines[index + 2].startswith(prefix.rstrip()):
        violations.append(Violation(path, index + 3, "file headers contain exactly two comment lines"))
    return violations


def normalize_header(path: Path, lines: list[str]) -> bool:
    index = prelude_length(path, lines)
    prefix = comment_prefix(path)
    if len(lines) <= index + 1 or not lines[index].startswith(prefix) or not lines[index + 1].startswith(prefix):
        return False
    changed = False
    newline = "\n" if lines[index].endswith("\n") else ""
    expected = f"{prefix}{repo_path(path)}{newline}"
    if lines[index] != expected:
        lines[index] = expected
        changed = True
    body = lines[index + 1].rstrip("\r\n").removeprefix(prefix).strip()
    if body and body[0].isupper():
        body = body[0].lower() + body[1:]
    body = body.rstrip(".")
    normalized = f"{prefix}{body}{'\n' if lines[index + 1].endswith(chr(10)) else ''}"
    if lines[index + 1] != normalized:
        lines[index + 1] = normalized
        changed = True
    return changed


def is_code_like_token(token: str) -> bool:
    bare = token.rstrip(".:,;!?")
    return bare.lower() not in {"eslint", "oxlint"} and (
        token == "No."
        or any(char.isupper() for char in token[1:])
        or bool(re.search(r"[._\d]", token))
    )


def structured_violations(path: Path, line: int, comment: str) -> list[Violation]:
    if LEGACY_TAG_COLON_RE.match(comment) or LEGACY_TAG_BARE_RE.match(comment):
        return [Violation(path, line, "use a canonical `*`, `!`, `?`, or `TODO` annotation")]
    if TODO_PREFIX_RE.match(comment) and not VALID_TODO_RE.match(comment):
        return [Violation(path, line, "use `TODO action` or `TODO(scope): action` with a lowercase scope")]
    if TAG_PREFIX_RE.match(comment) and not VALID_TAG_RE.match(comment):
        return [Violation(path, line, "use one space around the structured comment tag")]
    if DECORATIVE_BANNER_RE.match(comment):
        return [Violation(path, line, "use a short plain comment instead of a decorative banner")]
    match = PLAIN_COMMENT_RE.match(comment)
    if match and not is_code_like_token(match.group(1)):
        return [Violation(path, line, "plain comments start lowercase; preserve exact code symbols")]
    return []


def normalize_comment(comment: str) -> str:
    normalized = comment.replace("→", "->").replace("⇒", "->")
    match = PLAIN_COMMENT_RE.match(normalized)
    if match and not TODO_PREFIX_RE.match(normalized) and not TAG_PREFIX_RE.match(normalized):
        token = match.group(1)
        if not is_code_like_token(token):
            start = match.start(1)
            if token.rstrip(".:,;!?").lower() in {"eslint", "oxlint"}:
                normalized = normalized[:start] + token.lower() + normalized[start + len(token) :]
            else:
                normalized = normalized[:start] + normalized[start].lower() + normalized[start + 1 :]
    return normalized


def is_test_path(path: Path) -> bool:
    relative = path.relative_to(ROOT)
    return (
        bool(TEST_PARTS.intersection(relative.parts))
        or path.stem.startswith("test_")
        or path.stem.endswith((".spec", ".test"))
    )


def python_comments(path: Path, text: str) -> list[LineComment]:
    comments: list[LineComment] = []
    try:
        tokens = tokenize.generate_tokens(io.StringIO(text).readline)
        for token in tokens:
            if token.type != tokenize.COMMENT:
                continue
            comments.append(
                LineComment(
                    token.start[0],
                    token.start[1],
                    token.string,
                    bool(PYTHON_TOOLING_RE.match(token.string)),
                )
            )
    except tokenize.TokenError:
        pass
    return comments


def python_doc_violations(path: Path, text: str) -> list[Violation]:
    try:
        tree = ast.parse(text)
    except SyntaxError:
        return []
    top_level_classes = {id(node) for node in tree.body if isinstance(node, ast.ClassDef)}
    violations: list[Violation] = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        body = getattr(node, "body", [])
        if not body:
            continue
        expression = body[0]
        if not (
            isinstance(expression, ast.Expr)
            and isinstance(expression.value, ast.Constant)
            and isinstance(expression.value.value, str)
        ):
            continue
        allowed = (
            isinstance(node, ast.ClassDef)
            and id(node) in top_level_classes
            and not node.name.startswith("_")
            and not is_test_path(path)
        )
        if not allowed:
            violations.append(Violation(path, expression.lineno, "block docs belong on module-level public classes"))
            continue
        summary = " ".join(expression.value.value.strip().split("\n\n", 1)[0].split())
        if not SUMMARY_START_RE.match(summary):
            violations.append(Violation(path, expression.lineno, "block documentation starts with a capitalized sentence"))
        if summary and not SUMMARY_PERIOD_RE.search(summary):
            violations.append(Violation(path, expression.lineno, "block documentation summaries end with a period"))
    return violations


def scan_shell_line(line: str) -> tuple[int, list[tuple[str, bool]]]:
    quote: str | None = None
    escaped = False
    arithmetic_depth = 0
    heredocs: list[tuple[str, bool]] = []
    index = 0
    while index < len(line):
        char = line[index]
        if escaped:
            escaped = False
            index += 1
            continue
        if char == "\\" and quote != "'":
            escaped = True
            index += 1
            continue
        if quote is not None:
            if char == quote:
                quote = None
            index += 1
            continue
        if char in {"'", '"'}:
            quote = char
            index += 1
            continue
        if line.startswith("((", index):
            arithmetic_depth += 1
            index += 2
            continue
        if arithmetic_depth > 0 and line.startswith("))", index):
            arithmetic_depth -= 1
            index += 2
            continue
        if char == "#" and (index == 0 or line[index - 1].isspace() or line[index - 1] in ";|&()"):
            return index, heredocs
        if (
            arithmetic_depth == 0
            and line.startswith("<<", index)
            and not line.startswith("<<<", index)
        ):
            cursor = index + 2
            strip_tabs = cursor < len(line) and line[cursor] == "-"
            if strip_tabs:
                cursor += 1
            while cursor < len(line) and line[cursor] in " \t":
                cursor += 1
            marker: list[str] = []
            marker_quote: str | None = None
            while cursor < len(line):
                marker_char = line[cursor]
                if marker_quote is not None:
                    if marker_char == marker_quote:
                        marker_quote = None
                    else:
                        marker.append(marker_char)
                    cursor += 1
                    continue
                if marker_char in {"'", '"'}:
                    marker_quote = marker_char
                    cursor += 1
                    continue
                if marker_char == "\\" and cursor + 1 < len(line):
                    marker.append(line[cursor + 1])
                    cursor += 2
                    continue
                if marker_char.isspace() or marker_char in ";|&()<>":
                    break
                marker.append(marker_char)
                cursor += 1
            if marker and (marker[0].isalpha() or marker[0] == "_"):
                heredocs.append(("".join(marker), strip_tabs))
            index = cursor
            continue
        index += 1
    return -1, heredocs


def shell_comments(text: str) -> list[LineComment]:
    comments: list[LineComment] = []
    heredocs: list[tuple[str, bool]] = []
    for number, line in enumerate(text.splitlines(), start=1):
        if heredocs:
            marker, strip_tabs = heredocs[0]
            candidate = line.lstrip("\t") if strip_tabs else line
            if candidate == marker:
                heredocs.pop(0)
            continue
        column, line_heredocs = scan_shell_line(line)
        heredocs.extend(line_heredocs)
        if column == -1:
            continue
        comment = line[column:]
        comments.append(LineComment(number, column, comment, bool(SHELL_TOOLING_RE.match(comment))))
    return comments


def is_standalone_attribute(line: str) -> bool:
    name = re.match(r"@[\w.]+", line)
    if name is None:
        return False
    remainder = line[name.end() :].strip()
    if not remainder:
        return True
    if not remainder.startswith("("):
        return False
    depth = 0
    quote: str | None = None
    escaped = False
    for index, char in enumerate(remainder):
        if escaped:
            escaped = False
            continue
        if quote is not None:
            if char == "\\":
                escaped = True
            elif char == quote:
                quote = None
            continue
        if char in {"'", '"'}:
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return not remainder[index + 1 :].strip()
    return False


def next_code_line(lines: list[str], start: int) -> str | None:
    for line in lines[start:]:
        stripped = line.strip()
        if not stripped or stripped.startswith(("//", "*", "*/")):
            continue
        if is_standalone_attribute(stripped):
            continue
        return stripped
    return None


def slash_comments(
    text: str,
    *,
    swift_raw_strings: bool = False,
) -> tuple[list[LineComment], list[BlockComment]]:
    lines = text.splitlines()
    line_comments: list[LineComment] = []
    block_comments: list[BlockComment] = []
    in_block = False
    block_start = 0
    block_text: list[str] = []
    block_doc = False
    triple: str | None = None
    raw_string_end: str | None = None
    for number, line in enumerate(lines, start=1):
        index = 0
        quote: str | None = None
        escaped = False
        while index < len(line):
            if in_block:
                end = line.find("*/", index)
                if end == -1:
                    block_text.append(line[index:])
                    break
                block_text.append(line[index:end])
                block_comments.append(
                    BlockComment(block_start, "\n".join(block_text), block_doc, next_code_line(lines, number))
                )
                in_block = False
                block_text = []
                index = end + 2
                continue
            if triple is not None:
                end = line.find(triple, index)
                if end == -1:
                    break
                triple = None
                index = end + 3
                continue
            if raw_string_end is not None:
                end = line.find(raw_string_end, index)
                if end == -1:
                    break
                index = end + len(raw_string_end)
                raw_string_end = None
                continue
            if escaped:
                escaped = False
                index += 1
                continue
            if quote is not None:
                if line[index] == "\\":
                    escaped = True
                elif line[index] == quote:
                    quote = None
                index += 1
                continue
            if line.startswith(('"""', "'''"), index):
                triple = line[index : index + 3]
                index += 3
            elif swift_raw_strings and line[index] == "#":
                raw_start = re.match(r'(?P<hashes>#+)(?P<quotes>"""|")', line[index:])
                if raw_start is None:
                    index += 1
                    continue
                hashes = raw_start.group("hashes")
                quotes = raw_start.group("quotes")
                raw_string_end = f"{quotes}{hashes}"
                index += len(raw_start.group(0))
            elif line[index] in {"'", '"'}:
                quote = line[index]
                index += 1
            elif line.startswith("//", index):
                comment = line[index:]
                line_comments.append(LineComment(number, index, comment, bool(SLASH_TOOLING_RE.match(comment))))
                break
            elif line.startswith("/*", index):
                in_block = True
                block_start = number
                block_doc = line.startswith("/**", index)
                block_text = []
                index += 3 if block_doc else 2
            else:
                index += 1
    return line_comments, block_comments


def block_doc_violations(path: Path, blocks: list[BlockComment]) -> list[Violation]:
    violations: list[Violation] = []
    for block in blocks:
        if block.documentation and BLOCK_TODO_RE.search(block.text):
            violations.append(
                Violation(path, block.line, "TODO annotations use line comments outside block documentation")
            )
            continue
        if path.suffix == ".swift" or not block.documentation:
            violations.append(Violation(path, block.line, "use line comments instead of implementation block comments"))
            continue
        target = block.target or ""
        if is_test_path(path) or not KOTLIN_TYPE_RE.match(target):
            violations.append(Violation(path, block.line, "block documentation belongs on Kotlin classes, interfaces, or objects"))
            continue
        summary_lines = [re.sub(r"^\s*\*?\s?", "", line).strip() for line in block.text.splitlines()]
        summary = " ".join(line for line in summary_lines if line and not line.startswith("@"))
        if not SUMMARY_START_RE.match(summary):
            violations.append(Violation(path, block.line, "block documentation starts with a capitalized sentence"))
        if summary and not SUMMARY_PERIOD_RE.search(summary):
            violations.append(Violation(path, block.line, "block documentation summaries end with a period"))
    return violations


def swift_doc_violations(
    path: Path,
    lines: list[str],
    comments: list[LineComment],
) -> list[Violation]:
    docs = [comment for comment in comments if comment.text.startswith("///")]
    violations: list[Violation] = []
    index = 0
    while index < len(docs):
        start = docs[index]
        group = [start]
        index += 1
        while index < len(docs) and docs[index].line == group[-1].line + 1:
            group.append(docs[index])
            index += 1
        if any(SWIFT_DOC_TODO_RE.match(comment.text) for comment in group):
            violations.append(
                Violation(path, start.line, "TODO annotations use line comments outside block documentation")
            )
            continue
        target = next_code_line(lines, group[-1].line)
        if is_test_path(path) or target is None or not SWIFT_TYPE_RE.match(target):
            violations.append(
                Violation(path, start.line, "/// documentation belongs on Swift types")
            )
            continue
        summary = " ".join(comment.text.removeprefix("///").strip() for comment in group).strip()
        if not summary or not SUMMARY_START_RE.match(summary):
            violations.append(
                Violation(path, start.line, "block documentation starts with a capitalized sentence")
            )
        if summary and not SUMMARY_PERIOD_RE.search(summary):
            violations.append(
                Violation(path, start.line, "block documentation summaries end with a period")
            )
        if any(arrow in summary for arrow in ("→", "⇒")):
            violations.append(Violation(path, start.line, "use ASCII ->, not the Unicode arrow"))
    return violations


def line_comment_violations(path: Path, lines: list[str], comments: list[LineComment]) -> list[Violation]:
    header_lines = {
        prelude_length(path, lines) + 1,
        prelude_length(path, lines) + 2,
    }
    violations: list[Violation] = []
    for comment in comments:
        if comment.line == 1 and comment.text.startswith("#!"):
            continue
        if comment.line in header_lines or comment.tooling:
            continue
        if path.suffix == ".swift" and comment.text.startswith(("///", "// MARK:")):
            continue
        if any(arrow in comment.text for arrow in ("→", "⇒")):
            violations.append(Violation(path, comment.line, "use ASCII ->, not the Unicode arrow"))
        if comment.column > 0 and lines[comment.line - 1][: comment.column].strip():
            violations.append(Violation(path, comment.line, "move prose comments above the code"))
        violations.extend(structured_violations(path, comment.line, comment.text))
    return violations


def check_file(path: Path, headers: bool) -> list[Violation]:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as error:
        return [Violation(path, 1, f"file could not be read as UTF-8: {error}")]
    lines = text.splitlines(keepends=True)
    violations = header_violations(path, lines) if headers else []
    if path.suffix == ".py":
        comments = python_comments(path, text)
        violations.extend(python_doc_violations(path, text))
    elif path.suffix in {".sh", ".bash", ".zsh"}:
        comments = shell_comments(text)
    else:
        comments, blocks = slash_comments(text, swift_raw_strings=path.suffix == ".swift")
        violations.extend(block_doc_violations(path, blocks))
        if path.suffix == ".swift":
            violations.extend(swift_doc_violations(path, lines, comments))
    violations.extend(line_comment_violations(path, lines, comments))
    return violations


def fix_file(path: Path, headers: bool) -> bool:
    text = path.read_text(encoding="utf-8")
    lines = text.splitlines(keepends=True)
    changed = normalize_header(path, lines) if headers else False
    current = "".join(lines)
    if path.suffix == ".py":
        comments = python_comments(path, current)
    elif path.suffix in {".sh", ".bash", ".zsh"}:
        comments = shell_comments(current)
    else:
        comments, _ = slash_comments(current, swift_raw_strings=path.suffix == ".swift")
    header_lines = {
        prelude_length(path, lines) + 1,
        prelude_length(path, lines) + 2,
    }
    for comment in reversed(comments):
        if (
            comment.tooling
            or comment.line in header_lines
            or (comment.line == 1 and comment.text.startswith("#!"))
        ):
            continue
        replacement = normalize_comment(comment.text)
        if replacement == comment.text:
            continue
        index = comment.line - 1
        line = lines[index]
        lines[index] = line[: comment.column] + replacement + line[comment.column + len(comment.text) :]
        changed = True
    if changed:
        path.write_text("".join(lines), encoding="utf-8")
    return changed


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="check comments in owned Swift, Kotlin, shell, and Python files")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="report violations without editing (default)")
    mode.add_argument("--fix", action="store_true", help="apply safe header, arrow, and lowercase fixes")
    parser.add_argument("--headers", action="store_true", help="require exact two-line file headers")
    parser.add_argument("--root", type=Path, default=None, help="repository root for header paths")
    parser.add_argument("paths", nargs="*", type=Path, help="explicit migrated files or directories")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    global ROOT
    ROOT = resolve_root(args.root)
    values = args.paths or [Path("scripts/check_comment_style.py")]
    try:
        paths = discover_paths(values)
    except ValueError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2
    if args.fix:
        changed = sum(fix_file(path, args.headers) for path in paths)
        print(f"comment style fixed {changed} files")
        return 0
    violations = [violation for path in paths for violation in check_file(path, args.headers)]
    for violation in violations:
        print(violation.render())
    return 1 if violations else 0


if __name__ == "__main__":
    raise SystemExit(main())
