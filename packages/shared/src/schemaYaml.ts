// packages/shared/src/schemaYaml.ts
// parse yaml

import * as Effect from 'effect/Effect'
import * as Option from 'effect/Option'
import * as Schema from 'effect/Schema'
import * as SchemaGetter from 'effect/SchemaGetter'
import * as SchemaIssue from 'effect/SchemaIssue'
import * as SchemaTransformation from 'effect/SchemaTransformation'
import {
  YAMLParseError,
  parse as parseYamlString,
  stringify as stringifyYamlValue,
  type CreateNodeOptions,
  type DocumentOptions,
  type ParseOptions,
  type SchemaOptions,
  type ToJSOptions,
  type ToStringOptions,
} from 'yaml'

export type YamlParseOptions = ParseOptions & DocumentOptions & SchemaOptions & ToJSOptions
export type YamlStringifyOptions = DocumentOptions &
  SchemaOptions &
  ParseOptions &
  CreateNodeOptions &
  ToStringOptions

function formatYamlParseError(error: unknown): string
{
  if (!(error instanceof YAMLParseError))
  {
    return 'Invalid YAML.'
  }

  const position = error.linePos?.[0]
  const location = position === undefined ? '' : `, line=${position.line}, column=${position.col}`
  return `Invalid YAML (code=${error.code}${location}).`
}

// parse present YAML text & surface failures as `SchemaIssue.InvalidValue`
export function parseYaml<E extends string>(
  options?: YamlParseOptions,
): SchemaGetter.Getter<unknown, E>
{
  return SchemaGetter.transformOrFail((input: E) =>
    Effect.try({
      try: () => parseYamlString(input, options) as unknown,
      catch: (error) =>
        new SchemaIssue.InvalidValue(Option.none(), { message: formatYamlParseError(error) }),
    }),
  )
}

// serialize present values as YAML & surface failures as `SchemaIssue.InvalidValue`
export function stringifyYaml(
  options?: YamlStringifyOptions,
): SchemaGetter.Getter<string, unknown>
{
  return SchemaGetter.transformOrFail((input: unknown) =>
    Effect.try({
      try: () => stringifyYamlValue(input, options),
      catch: () =>
        new SchemaIssue.InvalidValue(Option.none(), { message: 'Failed to stringify YAML.' }),
    }),
  )
}

// decode YAML text before schema validation & encode validated values as YAML
export const fromYamlString = new SchemaTransformation.Transformation<unknown, string>(
  parseYaml(),
  stringifyYaml(),
)

// build a schema that decodes a YAML string into `A`.
//
// decode before validation; encode only validated values
export const fromYaml = <S extends Schema.Top>(schema: S) =>
  Schema.String.pipe(Schema.decodeTo(schema, fromYamlString))
