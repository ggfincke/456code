// apps/server/src/mdx/WorkspaceMdxDocument.ts
// reads and compiles workspace mdx into the closed transport document

import type {
  MdxSafeDocumentDiagnostic,
  MdxSafeDocumentNode,
  MdxSafeDocumentRange,
  ProjectReadMdxDocumentInput,
} from "@t3tools/contracts";
import {
  MdxSafeDocument,
  type MdxSafeDocumentCalloutType,
  ProjectReadMdxDocumentError,
  ProjectReadMdxDocumentResult,
} from "@t3tools/contracts";
import {
  normalizeMdxWorkspacePath,
  resolveMdxAnchorTarget,
  resolveMdxImageTarget,
} from "@t3tools/shared/filePreview";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  compileSafeDocument,
  VALID_CALLOUT_TYPES,
  type SafeDocument,
  type SafeDocumentComponentNode,
  type SafeDocumentCompileOptions,
  type SafeDocumentDiagnostic,
  type SafeDocumentElementNode,
  type SafeDocumentJsonValue,
  type SafeDocumentNode,
} from "mdx-forge/compiler";

import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";

const MDX_PATH_MAX_LENGTH = 1024;
const MDX_REFERENCE_MAX_LENGTH = 256;
const MDX_SOURCE_MAX_BYTES = 1024 * 1024;
const MDX_LINE_MAXIMUM = 2_147_483_647;
const OPAQUE_REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/u;
const PUBLIC_COMPILER_DIAGNOSTICS = {
  MDXF001: {
    ruleId: "safe-document/unknown-component",
    message: "An unknown component is not allowed.",
  },
  MDXF002: {
    ruleId: "safe-document/unknown-prop",
    message: "An unsupported component prop is not allowed.",
  },
  MDXF003: {
    ruleId: "safe-document/invalid-enum-value",
    message: "A component prop has an invalid enum value.",
  },
  MDXF004: {
    ruleId: "safe-document/deprecated-prop",
    message: "A deprecated component prop is present.",
  },
  MDXF005: {
    ruleId: "safe-document/deprecated-alias",
    message: "A deprecated component alias is present.",
  },
  MDXF006: {
    ruleId: "safe-document/missing-required-prop",
    message: "A required component prop is missing.",
  },
  MDXF007: {
    ruleId: "safe-document/invalid-prop-value",
    message: "A component prop has an invalid value.",
  },
  MDXF008: {
    ruleId: "safe-document/unknown-compound-member",
    message: "An unknown compound component member is not allowed.",
  },
  MDXF020: {
    ruleId: "safe-document/invalid-frontmatter",
    message: "Frontmatter is invalid.",
  },
  MDXF021: {
    ruleId: "safe-document/duplicate-heading-id",
    message: "A heading identifier is duplicated.",
  },
  MDXF030: {
    ruleId: "safe-document/broken-link",
    message: "A link target could not be resolved.",
  },
  MDXF031: {
    ruleId: "safe-document/broken-anchor",
    message: "A heading anchor could not be resolved.",
  },
  MDXF032: {
    ruleId: "safe-document/missing-asset",
    message: "An asset target could not be resolved.",
  },
  MDXF100: {
    ruleId: "safe-document/mdx-parse-error",
    message: "The MDX source could not be parsed.",
  },
  MDXF101: {
    ruleId: "safe-document/plugin-load-error",
    message: "An MDX compiler plugin could not be loaded.",
  },
  MDXF110: {
    ruleId: "safe-document/unsupported-safe-syntax",
    message: "Executable or unsupported MDX syntax is not allowed.",
  },
  MDXF111: {
    ruleId: "safe-document/unsafe-url",
    message: "A URL is not allowed by the host policy.",
  },
  MDXF112: {
    ruleId: "safe-document/unsupported-element",
    message: "An HTML element is not supported.",
  },
  MDXF113: {
    ruleId: "safe-document/unsupported-attribute",
    message: "An HTML attribute is not supported.",
  },
  MDXF114: {
    ruleId: "safe-document/unsupported-raw-html",
    message: "Raw HTML is not allowed.",
  },
} as const;
const UNKNOWN_COMPILER_DIAGNOSTIC = {
  code: "MDXF000",
  ruleId: "safe-document/compiler-diagnostic",
  message: "The MDX document violates the safe document policy.",
} as const;
const decodeMdxSafeDocument = Schema.decodeUnknownEffect(MdxSafeDocument, {
  errors: "all",
  onExcessProperty: "error",
});
const decodeProjectReadMdxDocumentResult = Schema.decodeUnknownEffect(
  ProjectReadMdxDocumentResult,
  {
    errors: "all",
    onExcessProperty: "error",
  },
);

const COMPONENTS = {
  Callout: {
    props: {
      type: { type: "string", enum: VALID_CALLOUT_TYPES },
      title: { type: "string", maxLength: MDX_REFERENCE_MAX_LENGTH },
    },
    children: "required",
  },
  FileReference: {
    props: {
      path: { type: "string", format: "url", maxLength: MDX_PATH_MAX_LENGTH },
      line: {
        type: "number",
        integer: true,
        minimum: 1,
        maximum: MDX_LINE_MAXIMUM,
      },
      label: { type: "string", maxLength: MDX_REFERENCE_MAX_LENGTH },
    },
    requiredProps: ["path"],
    children: "none",
  },
  SymbolReference: {
    props: {
      id: { type: "string", maxLength: MDX_REFERENCE_MAX_LENGTH },
      label: { type: "string", maxLength: MDX_REFERENCE_MAX_LENGTH },
      path: { type: "string", format: "url", maxLength: MDX_PATH_MAX_LENGTH },
      line: {
        type: "number",
        integer: true,
        minimum: 1,
        maximum: MDX_LINE_MAXIMUM,
      },
    },
    requiredProps: ["id"],
    children: "none",
  },
  DiffReference: {
    props: {
      id: { type: "string", maxLength: MDX_REFERENCE_MAX_LENGTH },
      label: { type: "string", maxLength: MDX_REFERENCE_MAX_LENGTH },
    },
    requiredProps: ["id"],
    children: "none",
  },
  ArchitectureImpact: {
    props: {
      id: { type: "string", maxLength: MDX_REFERENCE_MAX_LENGTH },
      title: { type: "string", maxLength: MDX_REFERENCE_MAX_LENGTH },
    },
    requiredProps: ["id"],
    children: "optional",
  },
} as const satisfies NonNullable<SafeDocumentCompileOptions["components"]>;

type WorkspaceMdxDocumentInput = ProjectReadMdxDocumentInput & {
  readonly workspaceRoot: string;
};

export interface CompileSafeDocumentSourceInput {
  readonly threadId: ProjectReadMdxDocumentInput["threadId"];
  readonly relativePath: ProjectReadMdxDocumentInput["relativePath"];
  readonly source: string;
}

type SafeDocumentRange = NonNullable<SafeDocument["root"]["source"]>;

type DocumentMappingContext = {
  readonly diagnostics: Array<MdxSafeDocumentDiagnostic>;
};

function sourceRange(range: SafeDocumentRange | undefined): MdxSafeDocumentRange | undefined {
  if (!range) {
    return undefined;
  }
  return {
    start: {
      line: range.start.line,
      column: range.start.column,
      ...(range.start.offset === undefined ? {} : { offset: range.start.offset }),
    },
    end: {
      line: range.end.line,
      column: range.end.column,
      ...(range.end.offset === undefined ? {} : { offset: range.end.offset }),
    },
  };
}

function nodeSource(range: SafeDocumentRange | undefined): { source?: MdxSafeDocumentRange } {
  const source = sourceRange(range);
  return source ? { source } : {};
}

function mapCompilerDiagnostic(diagnostic: SafeDocumentDiagnostic): MdxSafeDocumentDiagnostic {
  const publicDiagnostic =
    diagnostic.code in PUBLIC_COMPILER_DIAGNOSTICS
      ? PUBLIC_COMPILER_DIAGNOSTICS[diagnostic.code as keyof typeof PUBLIC_COMPILER_DIAGNOSTICS]
      : UNKNOWN_COMPILER_DIAGNOSTIC;
  const range = sourceRange(diagnostic.range);
  return {
    code:
      diagnostic.code in PUBLIC_COMPILER_DIAGNOSTICS
        ? diagnostic.code
        : UNKNOWN_COMPILER_DIAGNOSTIC.code,
    ruleId: publicDiagnostic.ruleId,
    severity: diagnostic.severity,
    message: publicDiagnostic.message,
    source: "mdx-forge",
    ...(range ? { range } : {}),
  };
}

function addHostDiagnostic(
  context: DocumentMappingContext,
  input: {
    readonly code: string;
    readonly ruleId: string;
    readonly message: string;
    readonly range: SafeDocumentRange | undefined;
    readonly componentName?: string;
    readonly propName?: string;
  },
): void {
  const range = sourceRange(input.range);
  context.diagnostics.push({
    code: input.code,
    ruleId: input.ruleId,
    severity: "error",
    message: input.message,
    source: "456code",
    ...(range ? { range } : {}),
    ...(input.componentName || input.propName
      ? {
          data: {
            ...(input.componentName ? { componentName: input.componentName } : {}),
            ...(input.propName ? { propName: input.propName } : {}),
          },
        }
      : {}),
  });
}

function normalizeComponentPath(
  value: SafeDocumentJsonValue | undefined,
  input: {
    readonly componentName: string;
    readonly required: boolean;
    readonly range: SafeDocumentRange | undefined;
  },
  context: DocumentMappingContext,
): string | undefined {
  const resolution =
    typeof value === "string" && value.length <= MDX_PATH_MAX_LENGTH
      ? normalizeMdxWorkspacePath(value)
      : { kind: "rejected" as const };
  if (resolution.kind === "workspace") {
    return resolution.path;
  }
  if (value !== undefined || input.required) {
    addHostDiagnostic(context, {
      code: "T3MDX001",
      ruleId: "safe-document/invalid-workspace-path",
      message: `${input.componentName} path must be workspace-relative.`,
      range: input.range,
      componentName: input.componentName,
      propName: "path",
    });
  }
  return undefined;
}

function normalizeOpaqueReference(
  value: SafeDocumentJsonValue | undefined,
  input: {
    readonly componentName: string;
    readonly range: SafeDocumentRange | undefined;
  },
  context: DocumentMappingContext,
): string | undefined {
  if (
    typeof value === "string" &&
    value.length <= MDX_REFERENCE_MAX_LENGTH &&
    OPAQUE_REFERENCE_PATTERN.test(value)
  ) {
    return value;
  }
  addHostDiagnostic(context, {
    code: "T3MDX002",
    ruleId: "safe-document/invalid-opaque-reference",
    message: `${input.componentName} id must be an opaque reference.`,
    range: input.range,
    componentName: input.componentName,
    propName: "id",
  });
  return undefined;
}

function optionalString(
  value: SafeDocumentJsonValue | undefined,
  maximumLength = MDX_REFERENCE_MAX_LENGTH,
): string | undefined {
  return typeof value === "string" && value.length <= maximumLength ? value : undefined;
}

function optionalCalloutType(
  value: SafeDocumentJsonValue | undefined,
): MdxSafeDocumentCalloutType | undefined {
  return typeof value === "string" && (VALID_CALLOUT_TYPES as ReadonlyArray<string>).includes(value)
    ? (value as MdxSafeDocumentCalloutType)
    : undefined;
}

function optionalLine(value: SafeDocumentJsonValue | undefined): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MDX_LINE_MAXIMUM
    ? value
    : undefined;
}

function mapComponentNode(
  node: SafeDocumentComponentNode,
  context: DocumentMappingContext,
): ReadonlyArray<MdxSafeDocumentNode> {
  const children = node.children.flatMap((child) => mapNode(child, context));
  const source = nodeSource(node.source);

  switch (node.name) {
    case "Callout": {
      const type = optionalCalloutType(node.props.type);
      const title = optionalString(node.props.title);
      return [
        {
          type: "component",
          name: "Callout",
          props: {
            ...(type === undefined ? {} : { type }),
            ...(title === undefined ? {} : { title }),
          },
          children,
          ...source,
        },
      ];
    }
    case "FileReference": {
      const path = normalizeComponentPath(
        node.props.path,
        { componentName: node.name, required: true, range: node.source },
        context,
      );
      if (!path) {
        return children;
      }
      const line = optionalLine(node.props.line);
      const label = optionalString(node.props.label);
      return [
        {
          type: "component",
          name: "FileReference",
          props: {
            path,
            ...(line === undefined ? {} : { line }),
            ...(label === undefined ? {} : { label }),
          },
          children: [],
          ...source,
        },
      ];
    }
    case "SymbolReference": {
      const id = normalizeOpaqueReference(
        node.props.id,
        { componentName: node.name, range: node.source },
        context,
      );
      if (!id) {
        return children;
      }
      const path = normalizeComponentPath(
        node.props.path,
        { componentName: node.name, required: false, range: node.source },
        context,
      );
      const label = optionalString(node.props.label);
      const line = optionalLine(node.props.line);
      return [
        {
          type: "component",
          name: "SymbolReference",
          props: {
            id,
            ...(label === undefined ? {} : { label }),
            ...(path ? { path } : {}),
            ...(line === undefined ? {} : { line }),
          },
          children: [],
          ...source,
        },
      ];
    }
    case "DiffReference": {
      const id = normalizeOpaqueReference(
        node.props.id,
        { componentName: node.name, range: node.source },
        context,
      );
      if (!id) {
        return children;
      }
      const label = optionalString(node.props.label);
      return [
        {
          type: "component",
          name: "DiffReference",
          props: {
            id,
            ...(label === undefined ? {} : { label }),
          },
          children: [],
          ...source,
        },
      ];
    }
    case "ArchitectureImpact": {
      const id = normalizeOpaqueReference(
        node.props.id,
        { componentName: node.name, range: node.source },
        context,
      );
      if (!id) {
        return children;
      }
      const title = optionalString(node.props.title);
      return [
        {
          type: "component",
          name: "ArchitectureImpact",
          props: {
            id,
            ...(title === undefined ? {} : { title }),
          },
          children,
          ...source,
        },
      ];
    }
    default:
      addHostDiagnostic(context, {
        code: "T3MDX003",
        ruleId: "safe-document/unexpected-component",
        message: "The compiler returned an unsupported component.",
        range: node.source,
      });
      return [];
  }
}

function mapElementNode(
  node: SafeDocumentElementNode,
  context: DocumentMappingContext,
): ReadonlyArray<MdxSafeDocumentNode> {
  const children = node.children.flatMap((child) => mapNode(child, context));
  const source = nodeSource(node.source);

  switch (node.tag) {
    case "a":
      return [
        {
          type: "element",
          tag: "a",
          props: {
            href: node.props.href,
            ...(node.props.title === undefined ? {} : { title: node.props.title }),
          },
          children,
          ...source,
        },
      ];
    case "img":
      return [
        {
          type: "element",
          tag: "img",
          props: {
            src: node.props.src,
            alt: node.props.alt,
            ...(node.props.title === undefined ? {} : { title: node.props.title }),
          },
          children: [],
          ...source,
        },
      ];
    case "code":
      return [
        {
          type: "element",
          tag: "code",
          props: {
            ...(node.props.language === undefined ? {} : { language: node.props.language }),
            ...(node.props.meta === undefined ? {} : { meta: node.props.meta }),
          },
          children,
          ...source,
        },
      ];
    case "ol":
      return [
        {
          type: "element",
          tag: "ol",
          props: node.props.start === undefined ? {} : { start: node.props.start },
          children,
          ...source,
        },
      ];
    case "li":
      return [
        {
          type: "element",
          tag: "li",
          props: node.props.checked === undefined ? {} : { checked: node.props.checked },
          children,
          ...source,
        },
      ];
    case "td":
    case "th":
      return [
        {
          type: "element",
          tag: node.tag,
          props: node.props.align === undefined ? {} : { align: node.props.align },
          children,
          ...source,
        },
      ];
    case "blockquote":
    case "br":
    case "del":
    case "em":
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
    case "hr":
    case "p":
    case "pre":
    case "strong":
    case "table":
    case "tbody":
    case "thead":
    case "tr":
    case "ul":
      return [
        {
          type: "element",
          tag: node.tag,
          props: {},
          children,
          ...source,
        },
      ];
  }
}

function mapNode(
  node: SafeDocumentNode,
  context: DocumentMappingContext,
): ReadonlyArray<MdxSafeDocumentNode> {
  switch (node.type) {
    case "text":
      return [
        {
          type: "text",
          value: node.value,
          ...nodeSource(node.source),
        },
      ];
    case "element":
      return mapElementNode(node, context);
    case "component":
      return mapComponentNode(node, context);
    case "unknownComponent":
      addHostDiagnostic(context, {
        code: "T3MDX003",
        ruleId: "safe-document/unexpected-component",
        message: "The compiler returned an unsupported component.",
        range: node.source,
      });
      return [];
  }
}

function mapDocument(document: SafeDocument): unknown {
  const context: DocumentMappingContext = {
    diagnostics: document.diagnostics.map(mapCompilerDiagnostic),
  };
  const children = document.root.children.flatMap((child) => mapNode(child, context));
  return {
    version: document.version,
    frontmatter: document.frontmatter,
    root: {
      type: "root",
      children,
      ...nodeSource(document.root.source),
    },
    diagnostics: context.diagnostics,
  };
}

function allowUrl(
  documentPath: string,
  url: string,
  context: {
    readonly kind: "element" | "component";
    readonly name: string;
    readonly prop: string;
  },
): boolean {
  if (context.kind === "element" && context.name === "a" && context.prop === "href") {
    const resolution = resolveMdxAnchorTarget(documentPath, url);
    return (
      resolution.kind !== "rejected" &&
      (resolution.kind !== "workspace" || resolution.path.length <= MDX_PATH_MAX_LENGTH)
    );
  }
  if (context.kind === "element" && context.name === "img" && context.prop === "src") {
    const resolution = resolveMdxImageTarget(documentPath, url);
    return resolution.kind === "workspace" && resolution.path.length <= MDX_PATH_MAX_LENGTH;
  }
  if (
    context.kind === "component" &&
    (context.name === "FileReference" || context.name === "SymbolReference") &&
    context.prop === "path"
  ) {
    const resolution = normalizeMdxWorkspacePath(url);
    return resolution.kind === "workspace" && resolution.path.length <= MDX_PATH_MAX_LENGTH;
  }
  return false;
}

export const compileSafeDocumentSource = Effect.fn(
  "WorkspaceMdxDocument.compileSafeDocumentSource",
)(function* (input: CompileSafeDocumentSourceInput) {
  if (!input.relativePath.toLowerCase().endsWith(".mdx")) {
    return yield* new ProjectReadMdxDocumentError({
      threadId: input.threadId,
      relativePath: input.relativePath,
      failure: "unsupported_extension",
    });
  }
  const byteLength = new TextEncoder().encode(input.source).byteLength;
  if (byteLength > MDX_SOURCE_MAX_BYTES) {
    return yield* new ProjectReadMdxDocumentError({
      threadId: input.threadId,
      relativePath: input.relativePath,
      failure: "file_too_large",
    });
  }

  const document = yield* Effect.tryPromise({
    try: () =>
      compileSafeDocument(input.source, {
        components: COMPONENTS,
        unknownComponents: "reject",
        rawHtml: "reject",
        allowUrl: (url, context) => allowUrl(input.relativePath, url, context),
      }),
    catch: () =>
      new ProjectReadMdxDocumentError({
        threadId: input.threadId,
        relativePath: input.relativePath,
        failure: "compile_failed",
      }),
  });

  const mappedCandidate = yield* Effect.try({
    try: () => mapDocument(document),
    catch: () =>
      new ProjectReadMdxDocumentError({
        threadId: input.threadId,
        relativePath: input.relativePath,
        failure: "invalid_compiler_output",
      }),
  });
  const mappedDocument = yield* decodeMdxSafeDocument(mappedCandidate).pipe(
    Effect.mapError(
      () =>
        new ProjectReadMdxDocumentError({
          threadId: input.threadId,
          relativePath: input.relativePath,
          failure: "invalid_compiler_output",
        }),
    ),
  );

  return yield* decodeProjectReadMdxDocumentResult({
    transportVersion: 1,
    relativePath: input.relativePath,
    byteLength,
    source: input.source,
    document: mappedDocument,
  }).pipe(
    Effect.mapError(
      () =>
        new ProjectReadMdxDocumentError({
          threadId: input.threadId,
          relativePath: input.relativePath,
          failure: "invalid_compiler_output",
        }),
    ),
  );
});

export const readWorkspaceMdxDocument = Effect.fn("WorkspaceMdxDocument.readWorkspaceMdxDocument")(
  function* (input: WorkspaceMdxDocumentInput) {
    if (!input.relativePath.toLowerCase().endsWith(".mdx")) {
      return yield* new ProjectReadMdxDocumentError({
        threadId: input.threadId,
        relativePath: input.relativePath,
        failure: "unsupported_extension",
      });
    }

    const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;
    const file = yield* workspaceFileSystem.readFile({
      cwd: input.workspaceRoot,
      relativePath: input.relativePath,
    });
    if (file.truncated) {
      return yield* new ProjectReadMdxDocumentError({
        threadId: input.threadId,
        relativePath: input.relativePath,
        failure: "file_too_large",
      });
    }

    return yield* compileSafeDocumentSource({
      threadId: input.threadId,
      relativePath: file.relativePath,
      source: file.contents,
    });
  },
);
