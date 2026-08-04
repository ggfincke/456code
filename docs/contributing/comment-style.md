<!-- docs/contributing/comment-style.md -->
<!-- define the repository formatting and low-noise comment contract -->

# Formatting and Comment Style

This guide is the tracked source of truth for formatting and comments in owned 456code files. Every
covered file follows it; generated, vendored, and format-owned exemptions are documented below. The
completed migration is recorded in
[the modernization plan](../../.plans/21-style-comments-and-structure-modernization.md).

## Formatting Profile

Owned JavaScript and TypeScript use this exact profile:

| Setting           | Value                        |
| ----------------- | ---------------------------- |
| brace style       | Allman                       |
| semicolons        | `false`                      |
| quotes            | single (`singleQuote: true`) |
| trailing commas   | `all`                        |
| indentation       | 2 spaces                     |
| print width       | 100                          |
| arrow parentheses | always                       |

```json
{
  "plugins": ["prettier-plugin-brace-style"],
  "braceStyle": "allman",
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "tabWidth": 2,
  "printWidth": 100,
  "arrowParens": "always"
}
```

Prettier with `prettier-plugin-brace-style` exclusively owns JavaScript and TypeScript, including
JSX, TSX, MJS, and CJS. Oxfmt owns only non-overlapping sidecar formats such as JSON, CSS,
Markdown, and YAML. A JavaScript or TypeScript file must never pass through both formatters.
Oxlint remains the JavaScript and TypeScript linter.

No routine semicolons does not mean no semicolons under any circumstances. Keep a defensive
automatic-semicolon-insertion guard when a leading token could join the preceding expression.

## File Headers

Every covered owned source file starts with exactly two comment lines:

1. the repo-relative path, with no leading slash
2. an untagged lowercase purpose phrase with no terminal period

```ts
// apps/server/src/example/ExampleService.ts
// coordinate example requests across the runtime boundary
```

The purpose is a phrase, not a third-line design note. Preserve canonical casing for proper names,
protocols, and code identifiers when lowercasing would mislead.

- Shebangs and required encoding cookies stay above the two-line header.
- Compiler and linter directives that must precede code — `/// <reference>` triple-slash
  directives, `@effect-diagnostics` lines, and similar — are preserved, placed after the header
  (blank line, then the directive immediately above the first import). A header migration must
  never drop them.
- The header replaces a module docstring; do not duplicate it with one.
- A file designed to be copied elsewhere names its destination path rather than its storage path.
- Moving a file requires updating its path header in the same change.

## Plain Comments

Plain `//` or `#` comments are the default. Put a comment immediately above the unit it explains,
never beside code. Prefer intent, ownership, ordering, a constraint, or a non-obvious tradeoff over
narrating visible syntax or restating types.

Plain comments are lowercase and casual. Short forms such as `&`, `w/`, `w/o`, `config`, and
`params` are welcome when they remain readable. Preserve canonical casing for symbols, acronyms,
protocols, and product names. Use ASCII `->`, never the Unicode arrow.

Keep comments concise. Durable architecture, incident history, and extended rationale belong in a
maintained document or tracked plan. Cross-reference exact symbols and stable module paths, never
source line numbers or positional phrases such as “the helper above.”

## Block Documentation

Docstrings, TSDoc, JSDoc, and Swift `///` documentation are reserved for larger constructs when a
short paragraph materially helps orientation. Typical owners are classes, TypeScript interfaces
and enums, and Swift classes, structs, enums, actors, and protocols.

Ordinary functions, methods, tests, and private helpers use plain comments when they need one.
Block documentation uses complete capitalized sentences with terminal punctuation. Do not pair a
block document with a plain comment that repeats it, and put constructor-level behavior on the
larger type rather than duplicating it on the constructor.

## Structured Tags

Use structured tags sparingly. These are the only canonical tags:

- `*` for an important, easy-to-miss invariant
- `!` for an immediate warning or active deprecation
- `?` for a real unresolved design question
- `TODO` for an actionable follow-up

A TODO is one short `TODO action` or `TODO(scope): action` line with a lowercase scope. Put any
needed context in a plain comment immediately above it. Do not introduce parallel labels such as
`NOTE:`, `HACK:`, `FIXME:`, or `FOOTGUN:`.

## Language Rules and Exemptions

The contract applies to owned application code, packages, scripts, native modules, and tests in
languages that support comments. Use the language's natural line form: `//` for JavaScript,
TypeScript, Kotlin, and Swift; `#` for Python and shell; and the required syntactic form in CSS,
JSX, or another constrained context. Formats such as JSON that do not permit comments follow their
canonical syntax and do not receive synthetic headers.

Swift retains `// MARK: -` section markers, `#Preview`, and `swiftlint:` directives. Narrow tooling
directives such as `eslint-disable-next-line`, `@ts-`, `noqa`, `type: ignore`, and
`pragma: no cover` are syntax-driven exceptions; add a plain rationale above only when the reason
is not obvious.

Generated output, vendored repositories, third-party code, and format-owned output are exempt
unless 456code owns and checks their source form. Section banners are reserved for files longer
than 150 lines with at least three real logical sections; they are not decoration.

## Change Hygiene

- Apply the final format and comment contract to every new, moved, or substantially revised owned
  source file.
- Do not churn untouched legacy comments or headers outside an approved migration batch.
- In a dirty worktree, run mutating formatters and fixers only on files owned by the current change.
- Keep formatter churn, comment-only rewrites, structural refactors, dependency changes, and
  behavior changes in separate review units unless an approved phase explicitly combines them.
- Keep comments synchronized with the code. When rationale becomes durable or lengthy, move it to
  maintained tracked documentation and leave only the concise local invariant.
