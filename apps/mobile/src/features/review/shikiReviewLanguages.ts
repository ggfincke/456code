// apps/mobile/src/features/review/shikiReviewLanguages.ts
// shiki language catalogs and sync language resolution for review highlighting

import bashLanguage from '@shikijs/langs/bash'
import javascriptLanguage from '@shikijs/langs/javascript'
import jsonLanguage from '@shikijs/langs/json'
import jsxLanguage from '@shikijs/langs/jsx'
import tsxLanguage from '@shikijs/langs/tsx'
import typescriptLanguage from '@shikijs/langs/typescript'
import yamlLanguage from '@shikijs/langs/yaml'
import { getFiletypeFromFileName } from '@pierre/diffs/utils/getFiletypeFromFileName'
import { createHighlighterCore } from '@shikijs/core'

export const REVIEW_INITIAL_LANGUAGE_MODULES = [
  bashLanguage,
  javascriptLanguage,
  jsonLanguage,
  jsxLanguage,
  tsxLanguage,
  typescriptLanguage,
  yamlLanguage,
] satisfies Parameters<typeof createHighlighterCore>[0]['langs']
export const loadedLanguages = new Set<string>([
  'text',
  'bash',
  'javascript',
  'json',
  'jsx',
  'tsx',
  'typescript',
  'yaml',
])
export const languageLoadingPromises = new Map<string, Promise<boolean>>()
export const languageImports: Partial<Record<string, () => Promise<unknown>>> = {
  javascript: () => import('@shikijs/langs/javascript'),
  typescript: () => import('@shikijs/langs/typescript'),
  jsx: () => import('@shikijs/langs/jsx'),
  tsx: () => import('@shikijs/langs/tsx'),
  python: () => import('@shikijs/langs/python'),
  rust: () => import('@shikijs/langs/rust'),
  go: () => import('@shikijs/langs/go'),
  java: () => import('@shikijs/langs/java'),
  kotlin: () => import('@shikijs/langs/kotlin'),
  swift: () => import('@shikijs/langs/swift'),
  'objective-c': () => import('@shikijs/langs/objective-c'),
  c: () => import('@shikijs/langs/c'),
  cpp: () => import('@shikijs/langs/cpp'),
  csharp: () => import('@shikijs/langs/csharp'),
  php: () => import('@shikijs/langs/php'),
  ruby: () => import('@shikijs/langs/ruby'),
  lua: () => import('@shikijs/langs/lua'),
  perl: () => import('@shikijs/langs/perl'),
  r: () => import('@shikijs/langs/r'),
  dart: () => import('@shikijs/langs/dart'),
  scala: () => import('@shikijs/langs/scala'),
  elixir: () => import('@shikijs/langs/elixir'),
  haskell: () => import('@shikijs/langs/haskell'),
  clojure: () => import('@shikijs/langs/clojure'),
  ocaml: () => import('@shikijs/langs/ocaml'),
  fsharp: () => import('@shikijs/langs/fsharp'),
  erlang: () => import('@shikijs/langs/erlang'),
  zig: () => import('@shikijs/langs/zig'),
  nim: () => import('@shikijs/langs/nim'),
  html: () => import('@shikijs/langs/html'),
  css: () => import('@shikijs/langs/css'),
  scss: () => import('@shikijs/langs/scss'),
  less: () => import('@shikijs/langs/less'),
  xml: () => import('@shikijs/langs/xml'),
  svg: () => import('@shikijs/langs/xml'),
  vue: () => import('@shikijs/langs/vue'),
  svelte: () => import('@shikijs/langs/svelte'),
  astro: () => import('@shikijs/langs/astro'),
  json: () => import('@shikijs/langs/json'),
  jsonc: () => import('@shikijs/langs/jsonc'),
  yaml: () => import('@shikijs/langs/yaml'),
  toml: () => import('@shikijs/langs/toml'),
  ini: () => import('@shikijs/langs/ini'),
  bash: () => import('@shikijs/langs/bash'),
  shellscript: () => import('@shikijs/langs/shellscript'),
  powershell: () => import('@shikijs/langs/powershell'),
  fish: () => import('@shikijs/langs/fish'),
  sql: () => import('@shikijs/langs/sql'),
  graphql: () => import('@shikijs/langs/graphql'),
  prisma: () => import('@shikijs/langs/prisma'),
  docker: () => import('@shikijs/langs/docker'),
  hcl: () => import('@shikijs/langs/hcl'),
  nix: () => import('@shikijs/langs/nix'),
  markdown: () => import('@shikijs/langs/markdown'),
  mdx: () => import('@shikijs/langs/mdx'),
  tex: () => import('@shikijs/langs/tex'),
  diff: () => import('@shikijs/langs/diff'),
  regex: () => import('@shikijs/langs/regex'),
  viml: () => import('@shikijs/langs/viml'),
  makefile: () => import('@shikijs/langs/makefile'),
  cmake: () => import('@shikijs/langs/cmake'),
  groovy: () => import('@shikijs/langs/groovy'),
}

export const languageAliases: Record<string, string> = {
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  zsh: 'bash',
  shell: 'shellscript',
  yml: 'yaml',
  md: 'markdown',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  dockerfile: 'docker',
  vim: 'viml',
  objc: 'objective-c',
  objectivec: 'objective-c',
  'obj-c': 'objective-c',
  ps1: 'powershell',
  pwsh: 'powershell',
  hs: 'haskell',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  clj: 'clojure',
  ml: 'ocaml',
  fs: 'fsharp',
  tf: 'hcl',
  make: 'makefile',
  plain: 'text',
  plaintext: 'text',
  txt: 'text',
}

export function resolveLanguageAlias(language: string): string
{
  const normalized = language.toLowerCase()
  return languageAliases[normalized] ?? normalized
}

export function resolveLoadedLanguageFromPath(
  path: string,
  languageHint: string | null = null,
): string | null
{
  const detectedLanguage = languageHint ?? getFiletypeFromFileName(path)
  if (!detectedLanguage)
  {
    return 'text'
  }

  const candidate = resolveLanguageAlias(detectedLanguage)
  if (candidate === 'text' || candidate === 'ansi')
  {
    return 'text'
  }

  if (!(candidate in languageImports))
  {
    return 'text'
  }

  return loadedLanguages.has(candidate) ? candidate : null
}
