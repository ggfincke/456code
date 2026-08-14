// packages/cartographer-core/src/analyze/symbols.ts
// syntactic export/import symbol extraction via the ts compiler api

import * as NodeFS from 'node:fs'
import * as NodePath from 'node:path'
import ts from 'typescript'
import type {
  BlockDocumentation,
  CommentMarker,
  CommentNote,
  DocTag,
  ExportKind,
  ExportSymbol,
} from '../contracts/types.js'

// cap on stored declaration source so graph.json stays lean
const MAX_DEF_LENGTH = 1600
// cap on stored signature text
const MAX_SIGNATURE_LENGTH = 240
// tool directives never belong in a doc string
const DIRECTIVE_LINE =
  /^(eslint|@ts-|prettier|biome|c8|istanbul|v8|jshint|jslint|global |globals |type-coverage)/i
// tag lines stay structured on block docs instead of entering plain notes
const JSDOC_TAG_LINE = /^@\w+/

// rich per-export detail lifted from the declaration node
interface ExportDetail
{
  kind: ExportKind
  signature?: string
  def?: string
  documentation?: BlockDocumentation
  comments?: CommentNote[]
  markers?: CommentMarker[]
}

// per-specifier import evidence: which names are pulled & their type modality
export interface ImportInfo
{
  // pulled names; null -> namespace/star import (unknown/all)
  names: Set<string> | null
  // subset of `names` imported type-only (import type / `type` specifier)
  typeOnly: Set<string>
  // whole import is type-only: `import type ...`, or a type-only namespace
  wholeTypeOnly: boolean
}

interface ModuleBindingReference
{
  specifier: string
  // absent for `export * as name`, whose origin is the target namespace
  importedName?: string
  typeOnly: boolean
}

export interface ModuleSymbols
{
  // declared exports, incl. named re-exports; star re-exports added by expansion
  exports: Map<string, ExportSymbol>
  // specifier -> import evidence (names pulled + type modality)
  importsBySpecifier: Map<string, ImportInfo>
  // local import binding -> source binding provenance
  importedBindings: Map<string, ModuleBindingReference>
  // top-level local binding -> true when it exists only in type space
  localBindings: Map<string, boolean>
  // exported name -> local binding named by a source-less export clause
  localExportBindings: Map<string, string>
  // explicit `export { imported as name } from` provenance for star origins
  directReexports: Map<string, ModuleBindingReference>
  // export * routes, expanded against resolved deps afterward
  starReexports: Array<{ specifier: string; typeOnly: boolean }>
  // markers outside the header & exported declarations' attached comment runs
  fileMarkers: CommentMarker[]
  // accepted export record -> source lines claimed by its attached evidence
  claimedMarkerLinesByExport: Map<string, Set<number>>
}

interface ModuleRef
{
  source: string
  dependencies: Array<{
    module: string
    resolved: string
    couldNotResolve: boolean
  }>
}

// extract & star-expand symbols for every repo module, keyed by source path
export function buildSymbolTable(root: string, modules: ModuleRef[]): Map<string, ModuleSymbols>
{
  const table = new Map<string, ModuleSymbols>()
  const unreadable: string[] = []
  for (const m of modules)
  {
    try
    {
      const text = NodeFS.readFileSync(NodePath.resolve(root, m.source), 'utf-8')
      table.set(m.source, extractModuleSymbols(m.source, text))
    }
    catch
    {
      // unreadable file -> no symbol data, callers treat absence as unknown
      unreadable.push(m.source)
    }
  }
  // surface unreadable files because their export evidence is unavailable
  if (unreadable.length > 0)
  {
    const sample = unreadable.slice(0, 5).join(', ')
    console.error(
      `note: symbol extraction skipped ${unreadable.length} unreadable file(s): ` +
        `${sample}${unreadable.length > 5 ? ', ...' : ''}`,
    )
  }
  expandStarReexports(table, modules)
  return table
}

function extractModuleSymbols(fileName: string, text: string): ModuleSymbols
{
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind(fileName),
  )
  const result: ModuleSymbols = {
    exports: new Map(),
    importsBySpecifier: new Map(),
    importedBindings: new Map(),
    localBindings: new Map(),
    localExportBindings: new Map(),
    directReexports: new Map(),
    starReexports: [],
    fileMarkers: [],
    claimedMarkerLinesByExport: new Map(),
  }
  for (const statement of sourceFile.statements)
  {
    collectLocalBindings(statement, result)
    collectFromStatement(statement, result, sourceFile)
  }
  result.fileMarkers = collectFileMarkers(sourceFile, result.claimedMarkerLinesByExport)
  return result
}

function scriptKind(fileName: string): ts.ScriptKind
{
  if (fileName.endsWith('.tsx'))
  {
    return ts.ScriptKind.TSX
  }
  if (fileName.endsWith('.jsx'))
  {
    return ts.ScriptKind.JSX
  }
  if (/\.[cm]?js$/.test(fileName))
  {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

function collectLocalBindings(statement: ts.Statement, result: ModuleSymbols): void
{
  if (ts.isVariableStatement(statement))
  {
    for (const declaration of statement.declarationList.declarations)
    {
      for (const name of bindingNames(declaration.name))
      {
        addLocalBinding(result, name, false)
      }
    }
    return
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  )
  {
    if (statement.name && ts.isIdentifier(statement.name))
    {
      addLocalBinding(result, statement.name.text, false)
    }
    return
  }
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
  {
    addLocalBinding(result, statement.name.text, true)
  }
}

function addLocalBinding(result: ModuleSymbols, name: string, typeOnly: boolean): void
{
  const existing = result.localBindings.get(name)
  result.localBindings.set(name, existing === undefined ? typeOnly : existing && typeOnly)
}

function collectFromStatement(
  statement: ts.Statement,
  result: ModuleSymbols,
  sourceFile: ts.SourceFile,
): void
{
  if (ts.isImportDeclaration(statement))
  {
    collectImport(statement, result)
    return
  }
  if (ts.isExportDeclaration(statement))
  {
    collectExportDeclaration(statement, result)
    return
  }
  if (ts.isExportAssignment(statement))
  {
    // export default expr / export = expr
    const def = clampText(statement.expression.getText(sourceFile), MAX_DEF_LENGTH)
    const detail: ExportDetail = {
      kind: 'default',
      ...(leadingComments(statement, sourceFile) ?? {}),
    }
    if (def !== undefined)
    {
      detail.def = def
    }
    const stored = addExport(result, 'default', false, false, detail)
    if (stored)
    {
      claimAttachedCommentLines(result, 'default', statement, sourceFile)
    }
    return
  }
  collectExportedDeclaration(statement, result, sourceFile)
}

function collectImport(statement: ts.ImportDeclaration, result: ModuleSymbols): void
{
  const specifier = specifierText(statement.moduleSpecifier)
  if (specifier === undefined)
  {
    return
  }
  const clause = statement.importClause
  if (!clause)
  {
    // side-effect import -> pulls no names
    mergeImport(result, specifier, [], [])
    return
  }
  // `import type` marks the whole clause type-only
  const clauseTypeOnly = clause.isTypeOnly
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings))
  {
    if (clause.name)
    {
      result.importedBindings.set(clause.name.text, {
        specifier,
        importedName: 'default',
        typeOnly: clauseTypeOnly,
      })
    }
    result.importedBindings.set(clause.namedBindings.name.text, {
      specifier,
      typeOnly: clauseTypeOnly,
    })
    mergeNamespaceImport(result, specifier, clauseTypeOnly)
    return
  }
  const names: string[] = []
  const typeOnly: string[] = []
  if (clause.name)
  {
    names.push('default')
    result.importedBindings.set(clause.name.text, {
      specifier,
      importedName: 'default',
      typeOnly: clauseTypeOnly,
    })
    if (clauseTypeOnly)
    {
      typeOnly.push('default')
    }
  }
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings))
  {
    for (const element of clause.namedBindings.elements)
    {
      const name = (element.propertyName ?? element.name).text
      names.push(name)
      result.importedBindings.set(element.name.text, {
        specifier,
        importedName: name,
        typeOnly: clauseTypeOnly || element.isTypeOnly,
      })
      // `import { type Foo, Bar }` -> Foo type-only; clause type-only marks all
      if (clauseTypeOnly || element.isTypeOnly)
      {
        typeOnly.push(name)
      }
    }
  }
  mergeImport(result, specifier, names, typeOnly, clauseTypeOnly)
}

function collectExportDeclaration(statement: ts.ExportDeclaration, result: ModuleSymbols): void
{
  const specifier = statement.moduleSpecifier ? specifierText(statement.moduleSpecifier) : undefined
  const typeOnly = statement.isTypeOnly

  if (!statement.exportClause)
  {
    // export * from './x' -> expanded later, imports everything
    if (specifier !== undefined)
    {
      result.starReexports.push({ specifier, typeOnly })
      mergeNamespaceImport(result, specifier, typeOnly)
    }
    return
  }
  if (ts.isNamespaceExport(statement.exportClause))
  {
    // export * as ns from './x'
    const exportedName = statement.exportClause.name.text
    const stored = addExport(result, exportedName, typeOnly, true)
    if (specifier !== undefined)
    {
      if (stored)
      {
        result.directReexports.set(exportedName, { specifier, typeOnly })
      }
      mergeNamespaceImport(result, specifier, typeOnly)
    }
    return
  }
  const reExport = specifier !== undefined
  const imported: string[] = []
  const importedTypeOnly: string[] = []
  for (const element of statement.exportClause.elements)
  {
    const elementTypeOnly = typeOnly || element.isTypeOnly
    const exportedName = element.name.text
    const local = (element.propertyName ?? element.name).text
    const stored = addExport(result, exportedName, elementTypeOnly, reExport)
    if (stored)
    {
      if (specifier !== undefined)
      {
        result.directReexports.set(exportedName, {
          specifier,
          importedName: local,
          typeOnly: elementTypeOnly,
        })
      }
      else
      {
        result.localExportBindings.set(exportedName, local)
      }
    }
    imported.push(local)
    if (elementTypeOnly)
    {
      importedTypeOnly.push(local)
    }
  }
  if (specifier !== undefined)
  {
    mergeImport(result, specifier, imported, importedTypeOnly, typeOnly)
  }
}

function collectExportedDeclaration(
  statement: ts.Statement,
  result: ModuleSymbols,
  sourceFile: ts.SourceFile,
): void
{
  const modifiers = ts.canHaveModifiers(statement) ? (ts.getModifiers(statement) ?? []) : []
  const isExported = modifiers.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
  if (!isExported)
  {
    return
  }
  const detail = declarationDetail(statement, sourceFile)
  if (modifiers.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword))
  {
    // a default-exported interface/type alias is still compile-time only
    const defaultTypeOnly =
      ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
    const stored = addExport(result, 'default', defaultTypeOnly, false, detail)
    if (stored)
    {
      if (
        (ts.isFunctionDeclaration(statement) ||
          ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) ||
          ts.isTypeAliasDeclaration(statement)) &&
        statement.name
      )
      {
        result.localExportBindings.set('default', statement.name.text)
      }
      claimAttachedCommentLines(result, 'default', statement, sourceFile)
    }
    return
  }
  if (
    ts.isFunctionDeclaration(statement) ||
    ts.isClassDeclaration(statement) ||
    ts.isEnumDeclaration(statement) ||
    ts.isModuleDeclaration(statement)
  )
  {
    if (statement.name && ts.isIdentifier(statement.name))
    {
      const name = statement.name.text
      const stored = addExport(result, name, false, false, detail)
      if (stored)
      {
        result.localExportBindings.set(name, name)
        claimAttachedCommentLines(result, name, statement, sourceFile)
      }
    }
    return
  }
  if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
  {
    const name = statement.name.text
    const stored = addExport(result, name, true, false, detail)
    if (stored)
    {
      result.localExportBindings.set(name, name)
      claimAttachedCommentLines(result, name, statement, sourceFile)
    }
    return
  }
  if (ts.isVariableStatement(statement))
  {
    const statementEvidence = detail
      ? {
          ...(detail.documentation ? { documentation: detail.documentation } : {}),
          ...(detail.comments?.length ? { comments: detail.comments } : {}),
          ...(detail.markers?.length ? { markers: detail.markers } : {}),
        }
      : {}
    let evidenceAssigned = false
    for (const declaration of statement.declarationList.declarations)
    {
      const syntacticDetail: ExportDetail = {
        kind: 'const',
        ...declaratorDetail(declaration, sourceFile),
      }
      for (const name of bindingNames(declaration.name))
      {
        const ownsEvidence = !evidenceAssigned
        const stored = addExport(result, name, false, false, {
          ...syntacticDetail,
          ...(ownsEvidence ? statementEvidence : {}),
        })
        evidenceAssigned = true
        if (stored)
        {
          result.localExportBindings.set(name, name)
          if (ownsEvidence)
          {
            claimAttachedCommentLines(result, name, statement, sourceFile)
          }
        }
      }
    }
  }
}

// signature/def specific to one declarator in a multi-var statement
function declaratorDetail(
  declaration: ts.VariableDeclaration,
  sourceFile: ts.SourceFile,
): Partial<ExportDetail>
{
  const def = clampText(declaration.getText(sourceFile), MAX_DEF_LENGTH)
  if (!ts.isIdentifier(declaration.name))
  {
    const signature = clampText(
      declaration.getText(sourceFile).replace(/\s+/g, ' '),
      MAX_SIGNATURE_LENGTH,
    )
    return {
      ...(def ? { def } : {}),
      ...(signature ? { signature } : {}),
    }
  }
  const name = declaration.name.text
  let signature: string | undefined
  if (declaration.type)
  {
    signature = `${name}: ${declaration.type.getText(sourceFile)}`
  }
  else if (declaration.initializer)
  {
    signature = `${name} = ${declaration.initializer.getText(sourceFile)}`
  }
  else
  {
    signature = name
  }
  const clampedSignature = signature
    ? clampText(signature.replace(/\s+/g, ' '), MAX_SIGNATURE_LENGTH)
    : undefined
  return {
    ...(def ? { def } : {}),
    ...(clampedSignature === undefined ? {} : { signature: clampedSignature }),
  }
}

function bindingNames(name: ts.BindingName): string[]
{
  if (ts.isIdentifier(name))
  {
    return [name.text]
  }
  const names: string[] = []
  for (const element of name.elements)
  {
    if (ts.isBindingElement(element))
    {
      names.push(...bindingNames(element.name))
    }
  }
  return names
}

function addExport(
  result: ModuleSymbols,
  name: string,
  typeOnly: boolean,
  reExport = false,
  detail?: ExportDetail,
): boolean
{
  const existing = result.exports.get(name)
  // value export wins over type, local declaration wins over re-export
  if (
    !existing ||
    (existing.typeOnly && !typeOnly) ||
    (existing.reExport === true && !reExport) ||
    (detail !== undefined &&
      existing.kind === undefined &&
      !reExport &&
      (existing.typeOnly === true || !typeOnly))
  )
  {
    result.directReexports.delete(name)
    result.localExportBindings.delete(name)
    result.claimedMarkerLinesByExport.delete(name)
    result.exports.set(name, {
      name,
      ...(typeOnly ? { typeOnly: true } : {}),
      ...(reExport ? { reExport: true } : {}),
      ...(detail
        ? {
            kind: detail.kind,
            ...(detail.signature ? { signature: detail.signature } : {}),
            ...(detail.def ? { def: detail.def } : {}),
            ...(detail.documentation ? { documentation: detail.documentation } : {}),
            ...(detail.comments?.length ? { comments: detail.comments } : {}),
            ...(detail.markers?.length ? { markers: detail.markers } : {}),
          }
        : {}),
    })
    return true
  }
  return false
}

// syntactic kind, signature, documentation & definition for a local export
function declarationDetail(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): ExportDetail | undefined
{
  const kind = declarationKind(statement)
  if (!kind)
  {
    return undefined
  }
  const signature = declarationSignature(statement, sourceFile)
  const def = clampText(statement.getText(sourceFile), MAX_DEF_LENGTH)
  const detail: ExportDetail = {
    kind,
    ...(leadingComments(statement, sourceFile) ?? {}),
  }
  if (signature !== undefined)
  {
    detail.signature = signature
  }
  if (def !== undefined)
  {
    detail.def = def
  }
  return detail
}

function declarationKind(statement: ts.Statement): ExportKind | undefined
{
  if (ts.isFunctionDeclaration(statement))
  {
    return 'fn'
  }
  if (ts.isClassDeclaration(statement))
  {
    return 'class'
  }
  if (ts.isInterfaceDeclaration(statement))
  {
    return 'interface'
  }
  if (ts.isTypeAliasDeclaration(statement))
  {
    return 'type'
  }
  if (ts.isEnumDeclaration(statement))
  {
    return 'enum'
  }
  if (ts.isModuleDeclaration(statement))
  {
    return 'namespace'
  }
  if (ts.isVariableStatement(statement))
  {
    return 'const'
  }
  return undefined
}

// concise one-line declaration header: name + params/return, alias or init text
function declarationSignature(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): string | undefined
{
  const raw = rawSignature(statement, sourceFile)
  if (raw === undefined)
  {
    return undefined
  }
  return clampText(raw.replace(/\s+/g, ' '), MAX_SIGNATURE_LENGTH)
}

function rawSignature(statement: ts.Statement, sourceFile: ts.SourceFile): string | undefined
{
  if (ts.isFunctionDeclaration(statement) && statement.name)
  {
    const params = statement.parameters.map((p) => p.getText(sourceFile)).join(', ')
    const ret = statement.type ? `: ${statement.type.getText(sourceFile)}` : ''
    return `${statement.name.text}(${params})${ret}`
  }
  if (ts.isClassDeclaration(statement) && statement.name)
  {
    const heritage = statement.heritageClauses?.map((h) => h.getText(sourceFile)).join(' ')
    return `class ${statement.name.text}${heritage ? ` ${heritage}` : ''}`
  }
  if (ts.isInterfaceDeclaration(statement))
  {
    const params = statement.typeParameters?.length
      ? `<${statement.typeParameters.map((t) => t.getText(sourceFile)).join(', ')}>`
      : ''
    return `interface ${statement.name.text}${params}`
  }
  if (ts.isTypeAliasDeclaration(statement))
  {
    return `type ${statement.name.text} = ${statement.type.getText(sourceFile)}`
  }
  if (ts.isEnumDeclaration(statement))
  {
    return `enum ${statement.name.text}`
  }
  if (ts.isVariableStatement(statement))
  {
    const declaration = statement.declarationList.declarations[0]
    if (declaration && ts.isIdentifier(declaration.name))
    {
      if (declaration.type)
      {
        return `${declaration.name.text}: ${declaration.type.getText(sourceFile)}`
      }
      if (declaration.initializer)
      {
        return `${declaration.name.text} = ${declaration.initializer.getText(sourceFile)}`
      }
      return declaration.name.text
    }
  }
  return undefined
}

// comment ranges directly attached to a node -> excludes the file header &
// unrelated section comments separated by a blank line
function attachedCommentRanges(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): ts.CommentRange[]
{
  const text = sourceFile.text
  const ranges = ts.getLeadingCommentRanges(text, statement.getFullStart())
  if (!ranges || ranges.length === 0)
  {
    return []
  }
  const attached: ts.CommentRange[] = []
  let nextStart = statement.getStart(sourceFile)
  for (let i = ranges.length - 1; i >= 0; i -= 1)
  {
    const range = ranges[i]
    if (range === undefined)
    {
      continue
    }
    const gap = text.slice(range.end, nextStart)
    if ((gap.match(/\n/g)?.length ?? 0) > 1)
    {
      break
    }
    attached.unshift(range)
    nextStart = range.pos
  }
  return attached
}

// classified leading comments preserve their source distinctions
interface LeadingComments
{
  documentation?: BlockDocumentation
  comments?: CommentNote[]
  markers?: CommentMarker[]
}

function leadingComments(
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): LeadingComments | undefined
{
  const attached = attachedCommentRanges(statement, sourceFile)
  if (attached.length === 0)
  {
    return undefined
  }
  const text = sourceFile.text
  let documentation: BlockDocumentation | undefined
  const comments: CommentNote[] = []
  const markers: CommentMarker[] = []
  // contiguous // lines fold into one note, flushed at block boundaries
  let run: string[] = []
  const flushRun = (): void =>
  {
    if (run.length > 0)
    {
      comments.push({ text: run.join(' ') })
      run = []
    }
  }
  for (const range of attached)
  {
    const raw = text.slice(range.pos, range.end)
    const isBlock = range.kind === ts.SyntaxKind.MultiLineCommentTrivia
    const isBlockDoc = isBlock && raw.startsWith('/**')
    const prose: string[] = []
    const tags: DocTag[] = []
    for (const line of commentLines(raw))
    {
      const trimmed = line.trim()
      if (!trimmed || DIRECTIVE_LINE.test(trimmed))
      {
        continue
      }
      if (JSDOC_TAG_LINE.test(trimmed))
      {
        if (isBlockDoc)
        {
          tags.push(parseDocTag(trimmed))
        }
        continue
      }
      if (isBlock)
      {
        prose.push(trimmed)
        continue
      }
      const marker = parseMarker(trimmed)
      if (marker)
      {
        markers.push(marker)
        continue
      }
      run.push(trimmed)
    }
    if (isBlockDoc)
    {
      flushRun()
      const docText = prose.join(' ').trim()
      if (docText || tags.length > 0)
      {
        documentation = {
          text: docText,
          syntax: docSyntax(sourceFile.fileName),
          ...(tags.length > 0 ? { tags } : {}),
        }
      }
      continue
    }
    if (isBlock)
    {
      // plain /* */ prose -> a note, never block documentation
      flushRun()
      const noteText = prose.join(' ').trim()
      if (noteText)
      {
        comments.push({ text: noteText })
      }
    }
  }
  flushRun()
  if (!documentation && comments.length === 0 && markers.length === 0)
  {
    return undefined
  }
  return {
    ...(documentation ? { documentation } : {}),
    ...(comments.length > 0 ? { comments } : {}),
    ...(markers.length > 0 ? { markers } : {}),
  }
}

function docSyntax(fileName: string): BlockDocumentation['syntax']
{
  const kind = scriptKind(fileName)
  return kind === ts.ScriptKind.JS || kind === ts.ScriptKind.JSX ? 'jsdoc' : 'tsdoc'
}

// "@deprecated use bar" -> { name: 'deprecated', value: 'use bar' }
function parseDocTag(line: string): DocTag
{
  const match = /^@(\w+)\s*(.*)$/.exec(line)
  const name = match?.[1] ?? line.slice(1)
  const value = match?.[2]?.trim()
  return { name, ...(value ? { value } : {}) }
}

// structured marker line -> kind/scope/text; undefined for ordinary prose
function parseMarker(line: string): CommentMarker | undefined
{
  const todo = /^TODO(?:\(([^)]+)\))?(?::|\s|$)\s*(.*)$/.exec(line)
  if (todo)
  {
    const text = todo[2]
    if (text === undefined)
    {
      return undefined
    }
    return {
      kind: 'todo',
      text: text.trim(),
      ...(todo[1] ? { scope: todo[1].trim() } : {}),
    }
  }
  const tagged = /^([*!?])\s+(.*)$/.exec(line)
  if (!tagged)
  {
    return undefined
  }
  const tag = tagged[1]
  const text = tagged[2]
  if (tag === undefined || text === undefined)
  {
    return undefined
  }
  const kind = tag === '*' ? 'important' : tag === '!' ? 'warning' : 'question'
  return { kind, text: text.trim() }
}

// strip // or /* */ markers & * gutters from a raw comment range
function commentLines(raw: string): string[]
{
  if (raw.startsWith('//'))
  {
    return [raw.replace(/^\/\/+\s?/, '')]
  }
  return raw
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
}

// file-level markers from whole-line // comments; skips block comments
// (* gutters read as the important marker), the header & runs claimed by
// exported declarations -> a marker lives here or on one export, never both
function collectFileMarkers(
  sourceFile: ts.SourceFile,
  claims: Map<string, Set<number>>,
): CommentMarker[]
{
  const lines = sourceFile.text.split('\n')
  const skip = new Set<number>()
  markHeaderLines(lines, skip)
  for (const claimed of claims.values())
  {
    for (const line of claimed)
    {
      skip.add(line)
    }
  }
  const markers: CommentMarker[] = []
  for (let index = 0; index < lines.length; index += 1)
  {
    if (skip.has(index))
    {
      continue
    }
    const line = lines[index]
    if (line === undefined)
    {
      continue
    }
    const match = /^\s*\/\/+\s?(.*)$/.exec(line)
    if (!match)
    {
      continue
    }
    const markerText = match[1]
    if (markerText === undefined)
    {
      continue
    }
    const marker = parseMarker(markerText.trim())
    if (marker)
    {
      markers.push(marker)
    }
  }
  return markers
}

// header = leading comment block at the file top (after an optional shebang);
// skipping it guarantees a header purpose line never reads as a marker
function markHeaderLines(lines: string[], skip: Set<number>): void
{
  let index = 0
  if (lines[0]?.startsWith('#!'))
  {
    skip.add(0)
    index = 1
  }
  while (lines[index]?.trim() === '')
  {
    index += 1
  }
  const first = lines[index]?.trimStart()
  if (first?.startsWith('//'))
  {
    while (lines[index]?.trimStart().startsWith('//'))
    {
      skip.add(index)
      index += 1
    }
    return
  }
  if (first?.startsWith('/*'))
  {
    while (index < lines.length)
    {
      skip.add(index)
      if (lines[index]?.includes('*/'))
      {
        return
      }
      index += 1
    }
  }
}

function claimAttachedCommentLines(
  result: ModuleSymbols,
  owner: string,
  statement: ts.Statement,
  sourceFile: ts.SourceFile,
): void
{
  const claimed = new Set<number>()
  for (const range of attachedCommentRanges(statement, sourceFile))
  {
    const start = sourceFile.getLineAndCharacterOfPosition(range.pos).line
    const end = sourceFile.getLineAndCharacterOfPosition(range.end).line
    for (let line = start; line <= end; line += 1)
    {
      claimed.add(line)
    }
  }
  if (claimed.size > 0)
  {
    result.claimedMarkerLinesByExport.set(owner, claimed)
  }
}

function clampText(text: string, max: number): string | undefined
{
  const trimmed = text.trim()
  if (!trimmed)
  {
    return undefined
  }
  return trimmed.length > max ? `${trimmed.slice(0, max)} …` : trimmed
}

function mergeImport(
  result: ModuleSymbols,
  specifier: string,
  names: string[],
  typeOnly: string[],
  emptyTypeOnly = false,
): void
{
  const existing = result.importsBySpecifier.get(specifier)
  if (!existing)
  {
    result.importsBySpecifier.set(specifier, {
      names: new Set(names),
      typeOnly: new Set(typeOnly),
      wholeTypeOnly: names.length === 0 ? emptyTypeOnly : typeOnly.length === names.length,
    })
    return
  }
  const typeOnlySet = new Set(typeOnly)
  // names already pulled at runtime keep runtime status across declarations
  const runtimeBefore = new Set<string>()
  for (const name of existing.names ?? [])
  {
    if (!existing.typeOnly.has(name))
    {
      runtimeBefore.add(name)
    }
  }
  // namespace import already pulls all -> keep names null
  if (existing.names !== null)
  {
    for (const name of names)
    {
      existing.names.add(name)
    }
  }
  for (const name of typeOnly)
  {
    if (!runtimeBefore.has(name))
    {
      existing.typeOnly.add(name)
    }
  }
  // a runtime pull of a name clears its type-only mark
  for (const name of names)
  {
    if (!typeOnlySet.has(name))
    {
      existing.typeOnly.delete(name)
    }
  }
  // runtime evidence (incl. side-effect import) clears whole-edge type-only
  const runtime = names.length === 0 ? !emptyTypeOnly : names.some((name) => !typeOnlySet.has(name))
  existing.wholeTypeOnly = existing.wholeTypeOnly && !runtime
}

function mergeNamespaceImport(result: ModuleSymbols, specifier: string, typeOnly: boolean): void
{
  const existing = result.importsBySpecifier.get(specifier)
  result.importsBySpecifier.set(specifier, {
    names: null,
    typeOnly: existing?.typeOnly ?? new Set(),
    wholeTypeOnly: existing ? existing.wholeTypeOnly && typeOnly : typeOnly,
  })
}

function specifierText(expression: ts.Expression): string | undefined
{
  return ts.isStringLiteral(expression) ? expression.text : undefined
}

interface ExportOriginEvidence
{
  typeOnly: boolean
}

type ExportOriginSet = Map<string, ExportOriginEvidence>
type ModuleExportOrigins = Map<string, ExportOriginSet>

interface ModuleResolution
{
  targetId: string
  couldNotResolve: boolean
}

function mergeExportOrigins(
  target: ExportOriginSet,
  incoming: ExportOriginSet,
  forceTypeOnly: boolean,
): boolean
{
  let changed = false
  for (const [origin, evidence] of incoming)
  {
    const typeOnly = evidence.typeOnly || forceTypeOnly
    const existing = target.get(origin)
    if (!existing)
    {
      target.set(origin, { typeOnly })
      changed = true
    }
    else if (existing.typeOnly && !typeOnly)
    {
      existing.typeOnly = false
      changed = true
    }
  }
  return changed
}

function projectedReexport(name: string, typeOnly: boolean): ExportSymbol
{
  return { name, reExport: true, ...(typeOnly ? { typeOnly: true } : {}) }
}

function withTypeOnly(symbol: ExportSymbol, typeOnly: boolean): ExportSymbol
{
  const projected = { ...symbol }
  if (typeOnly)
  {
    projected.typeOnly = true
  }
  else
  {
    delete projected.typeOnly
  }
  return projected
}

function exportBindingReference(
  symbols: ModuleSymbols,
  name: string,
  symbol: ExportSymbol,
): ModuleBindingReference | undefined
{
  const direct = symbols.directReexports.get(name)
  if (direct)
  {
    return {
      ...direct,
      typeOnly: direct.typeOnly || symbol.typeOnly === true,
    }
  }
  const localName = symbols.localExportBindings.get(name)
  const imported = localName ? symbols.importedBindings.get(localName) : undefined
  if (!imported)
  {
    return undefined
  }
  return {
    ...imported,
    typeOnly: imported.typeOnly || symbol.typeOnly === true,
  }
}

function resolvedOrigin(
  source: string,
  reference: ModuleBindingReference,
  resolution: ModuleResolution | undefined,
  table: Map<string, ModuleSymbols>,
): string | undefined
{
  if (
    reference.importedName !== undefined &&
    resolution &&
    !resolution.couldNotResolve &&
    table.has(resolution.targetId)
  )
  {
    return undefined
  }
  if (resolution && !resolution.couldNotResolve)
  {
    return reference.importedName === undefined
      ? JSON.stringify(['namespace', resolution.targetId])
      : JSON.stringify(['external', resolution.targetId, reference.importedName])
  }
  return JSON.stringify(['unresolved', source, reference.specifier, reference.importedName ?? null])
}

// fixpoint expansion tracks ultimate binding origins; fixed names mask stars
function expandStarReexports(table: Map<string, ModuleSymbols>, modules: ModuleRef[]): void
{
  const resolved = new Map<string, Map<string, ModuleResolution>>()
  for (const m of modules)
  {
    const bySpecifier = new Map<string, ModuleResolution>()
    for (const dep of m.dependencies)
    {
      const candidate = {
        targetId: dep.resolved,
        couldNotResolve: dep.couldNotResolve,
      }
      const existing = bySpecifier.get(dep.module)
      if (!existing || (existing.couldNotResolve && !dep.couldNotResolve))
      {
        bySpecifier.set(dep.module, candidate)
      }
    }
    resolved.set(m.source, bySpecifier)
  }

  const fixedBySource = new Map(
    [...table].map(([source, symbols]) => [source, new Map(symbols.exports)]),
  )
  const originsBySource = new Map<string, ModuleExportOrigins>()
  for (const [source, symbols] of table)
  {
    const origins: ModuleExportOrigins = new Map()
    originsBySource.set(source, origins)
    for (const [name, symbol] of fixedBySource.get(source) ?? [])
    {
      const reference = exportBindingReference(symbols, name, symbol)
      const resolution = reference ? resolved.get(source)?.get(reference.specifier) : undefined
      const origin = reference
        ? resolvedOrigin(source, reference, resolution, table)
        : JSON.stringify(['local', source, symbols.localExportBindings.get(name) ?? name])
      if (origin === undefined)
      {
        continue
      }
      const localName = symbols.localExportBindings.get(name) ?? name
      const typeOnly = reference
        ? reference.typeOnly
        : symbol.typeOnly === true || symbols.localBindings.get(localName) === true
      origins.set(name, new Map([[origin, { typeOnly }]]))
    }
  }

  let changed = true
  while (changed)
  {
    changed = false
    for (const [source, symbols] of table)
    {
      const sourceOrigins = originsBySource.get(source)!
      for (const [name, symbol] of fixedBySource.get(source) ?? [])
      {
        const reference = exportBindingReference(symbols, name, symbol)
        if (reference?.importedName === undefined)
        {
          continue
        }
        const resolution = resolved.get(source)?.get(reference.specifier)
        if (!resolution || resolution.couldNotResolve)
        {
          continue
        }
        const targetOrigins = originsBySource.get(resolution.targetId)?.get(reference.importedName)
        if (!targetOrigins)
        {
          continue
        }
        let nameOrigins = sourceOrigins.get(name)
        if (!nameOrigins)
        {
          nameOrigins = new Map()
          sourceOrigins.set(name, nameOrigins)
        }
        changed = mergeExportOrigins(nameOrigins, targetOrigins, reference.typeOnly) || changed
      }
      for (const route of symbols.starReexports)
      {
        const resolution = resolved.get(source)?.get(route.specifier)
        const targetOrigins =
          resolution && !resolution.couldNotResolve
            ? originsBySource.get(resolution.targetId)
            : undefined
        if (!targetOrigins)
        {
          continue
        }
        for (const [name, incoming] of targetOrigins)
        {
          if (name === 'default' || fixedBySource.get(source)?.has(name))
          {
            continue
          }
          let nameOrigins = sourceOrigins.get(name)
          if (!nameOrigins)
          {
            nameOrigins = new Map()
            sourceOrigins.set(name, nameOrigins)
          }
          changed = mergeExportOrigins(nameOrigins, incoming, route.typeOnly) || changed
        }
      }
    }
  }

  for (const [source, symbols] of table)
  {
    const fixed = fixedBySource.get(source)!
    const origins = originsBySource.get(source)!
    const exports = new Map<string, ExportSymbol>()
    for (const [name, symbol] of fixed)
    {
      const nameOrigins = origins.get(name)
      if (exportBindingReference(symbols, name, symbol))
      {
        if (nameOrigins?.size === 1)
        {
          const evidence = nameOrigins.values().next().value!
          exports.set(name, projectedReexport(name, evidence.typeOnly))
        }
        continue
      }
      if (nameOrigins?.size === 1)
      {
        const evidence = nameOrigins.values().next().value!
        exports.set(name, withTypeOnly(symbol, evidence.typeOnly))
      }
    }
    for (const [name, nameOrigins] of origins)
    {
      if (fixed.has(name) || nameOrigins.size !== 1)
      {
        continue
      }
      const evidence = nameOrigins.values().next().value!
      exports.set(name, projectedReexport(name, evidence.typeOnly))
    }
    symbols.exports = exports
  }
}

export function exportList(symbols: ModuleSymbols): ExportSymbol[]
{
  return [...symbols.exports.values()].sort((a, b) => a.name.localeCompare(b.name))
}
