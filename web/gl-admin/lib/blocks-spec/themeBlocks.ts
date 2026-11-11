// Block Spec for theme blocks (#376): the types, attribute rules and validation a theme
// block declares, with no TipTap, React or DOM. Shared by the editor, the collab server's
// store validation, the public renderer and the API manifest
// (`themes/blocks.manifest.json`, `scripts/theme-blocks-manifest.mjs`). The API's Go
// sanitizer implements the same rules from that manifest (`api/theme_blocks.go`);
// `themeBlockVectors.json` holds the cases both sides must agree on.
//
// Plugin blocks (#452, docs/design/plugin-system.md 5.1) are the same kind of block in
// another namespace: `plugin:<slug>/<block>`. Everything here applies to them unchanged;
// "theme block" in names below means "extension block" unless a function says otherwise
// (`isThemeBlockType`, `themeOfBlockType`, `THEME_BLOCK_TYPE`).

/**
 * A theme block's type, which is also its ProseMirror node name: `theme:<theme>/<block>`,
 * e.g. `theme:example/alert`. No core block type has a `:`, so a theme block can never
 * collide with or shadow one, and two themes can't collide with each other. `<theme>` is
 * the theme's directory name (letters, digits, `-`, `_`), `<block>` lowercase.
 */
export const THEME_BLOCK_TYPE = /^theme:([A-Za-z0-9][A-Za-z0-9_-]*)\/([a-z][a-z0-9-]*)$/

export function isThemeBlockType(type: unknown): type is string {
  return typeof type === "string" && type.startsWith("theme:")
}

/**
 * Whether `type` is a namespaced extension block (#452): a theme block (`theme:<slug>/<block>`,
 * #376) or a plugin block (`plugin:<slug>/<block>`, docs/design/plugin-system.md 5.1). No
 * core type contains `:`. Everything that treats a block as "an extension's, maybe not in
 * this build" asks this, never one namespace: an extension block that isn't installed is
 * dropped at seed and kept in `meta.dropped` (#213), never given a stand-in.
 */
export function isExtensionBlockType(type: string): boolean {
  return type.startsWith("theme:") || type.startsWith("plugin:")
}

/** The theme slug in a theme block type (`theme:example/alert` → `example`), or null. */
export function themeOfBlockType(type: string): string | null {
  return THEME_BLOCK_TYPE.exec(type)?.[1] ?? null
}

/**
 * A plugin block's type, also its ProseMirror node name and Yjs element name:
 * `plugin:<slug>/<block>` (design 5.1). The same shape as a theme block's, so a plugin
 * block can't collide with a core or a theme block, and two plugins can't collide.
 */
export const PLUGIN_BLOCK_TYPE = /^plugin:([A-Za-z0-9][A-Za-z0-9_-]*)\/([a-z][a-z0-9-]*)$/

/** The plugin slug in a plugin block type (`plugin:reading-time/estimate` → `reading-time`), or null. */
export function pluginOfBlockType(type: string): string | null {
  return PLUGIN_BLOCK_TYPE.exec(type)?.[1] ?? null
}

/** Either extension block type, well formed: what a block spec's `type` may be. */
const isWellFormedExtensionBlockType = (type: string): boolean => THEME_BLOCK_TYPE.test(type) || PLUGIN_BLOCK_TYPE.test(type)

/**
 * One declared attribute. Values are plain JSON scalars: nested objects and arrays aren't
 * supported. `null` means "not set" (the default applies).
 */
export type ThemeAttrSpec =
  | { type: "string"; default: string; enum?: readonly string[]; maxLength?: number }
  | { type: "number"; default: number; enum?: readonly number[]; integer?: boolean; minimum?: number; maximum?: number }
  | { type: "boolean"; default: boolean }

/** What a theme block stores, and what the API's manifest carries for it. */
export interface ThemeBlockSpec {
  type: string
  /** The newest Block.version this build writes and reads (older ones too). */
  version: number
  attrs: Record<string, ThemeAttrSpec>
}

/** Attr names the bridge owns (the block's content), or that the sanitizer would strip (`on*`). */
const RESERVED_ATTR = /^(pm|text|data-block-id|on.*)$/i
const ATTR_NAME = /^[a-zA-Z][a-zA-Z0-9]*$/

/**
 * Why `spec` is not a usable extension block spec, or null. Checked when a theme is loaded.
 * A theme block and a plugin block (#452) share every rule but the namespace; which
 * namespace a block may use is its loader's check (`collectThemeBlocks`: its theme's).
 */
export function themeBlockSpecProblem(spec: ThemeBlockSpec): string | null {
  if (!isWellFormedExtensionBlockType(spec.type)) {
    return `type "${spec.type}" must look like theme:<theme directory>/<block> or plugin:<slug>/<block> (block: lowercase letters, digits, -)`
  }
  if (!Number.isInteger(spec.version) || spec.version < 1) return `${spec.type}: version must be an integer >= 1`
  for (const [name, attr] of Object.entries(spec.attrs)) {
    if (!ATTR_NAME.test(name) || RESERVED_ATTR.test(name)) return `${spec.type}: attr name "${name}" is not allowed`
    if (!["string", "number", "boolean"].includes(attr.type)) return `${spec.type}.${name}: unsupported type "${attr.type}"`
    if (attrProblem(attr, attr.default) !== null) return `${spec.type}.${name}: the default is not a valid value`
  }
  return null
}

/** Why `value` is not valid for `attr`, or null when it is. `null` / `undefined` are valid (not set). */
export function attrProblem(attr: ThemeAttrSpec, value: unknown): string | null {
  if (value === null || value === undefined) return null
  switch (attr.type) {
    case "string":
      if (typeof value !== "string") return "must be a string"
      if (attr.enum && !attr.enum.includes(value)) return `must be one of ${attr.enum.join(", ")}`
      // Code points, like the Go sanitizer's runes.
      if (attr.maxLength !== undefined && [...value].length > attr.maxLength) return `at most ${attr.maxLength} characters`
      return null
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number"
      if (attr.integer && !Number.isInteger(value)) return "must be an integer"
      if (attr.enum && !attr.enum.includes(value)) return `must be one of ${attr.enum.join(", ")}`
      if (attr.minimum !== undefined && value < attr.minimum) return `at least ${attr.minimum}`
      if (attr.maximum !== undefined && value > attr.maximum) return `at most ${attr.maximum}`
      return null
    case "boolean":
      return typeof value === "boolean" ? null : "must be a boolean"
  }
}

/** Looks up the spec of an installed theme block type; undefined when it isn't installed. */
export type ThemeBlockLookup = (type: string) => ThemeBlockSpec | undefined

/**
 * The ProseMirror NodeSpec field `defineThemeBlock` (theme-blocks/define.ts) puts the spec
 * in, so code that only has a schema (the bridge, the collab store's validation) knows a
 * node is an installed theme block. A stand-in (schemaWithStandIns) never has it.
 */
export const THEME_BLOCK_SPEC_FIELD = "glThemeBlock"

/** The theme block spec of a ProseMirror node type, if it is an installed theme block. */
export function themeBlockSpecOf(type: { spec: object } | undefined): ThemeBlockSpec | undefined {
  return (type?.spec as Record<string, unknown> | undefined)?.[THEME_BLOCK_SPEC_FIELD] as ThemeBlockSpec | undefined
}

/** The theme blocks `schema` has, as a lookup for `validateBlockDoc`. */
export const themeBlockLookup =
  (schema: { nodes: Record<string, { spec: object }> }): ThemeBlockLookup =>
  (type) =>
    Object.prototype.hasOwnProperty.call(schema.nodes, type) ? themeBlockSpecOf(schema.nodes[type]) : undefined

export interface ThemeBlockIssue {
  path: (string | number)[]
  message: string
}

/**
 * A version newer than this build's spec: written by a newer build of the theme (e.g.
 * before a rollback). Such a block is kept as it is, like a block of an uninstalled theme:
 * this build can't know its attrs, the editor hides it and the public page skips it.
 */
export const isNewerThemeBlock = (spec: ThemeBlockSpec, version: unknown): boolean =>
  typeof version === "number" && Number.isInteger(version) && version > spec.version

/**
 * The problems of a stored theme block against its spec: a version that isn't a positive
 * integer, or a declared attr with an invalid value. A newer version than the spec is not
 * checked (isNewerThemeBlock). Undeclared attrs are not a problem here (the API strips
 * them, the bridge never writes them). Same rules as the Go sanitizer.
 */
export function themeBlockIssues(spec: ThemeBlockSpec, block: { version?: unknown; attrs?: unknown }): ThemeBlockIssue[] {
  const issues: ThemeBlockIssue[] = []
  const version = block.version
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    issues.push({ path: ["version"], message: `${spec.type}: version must be an integer >= 1` })
    return issues
  }
  if (isNewerThemeBlock(spec, version)) return issues
  const attrs = block.attrs && typeof block.attrs === "object" ? (block.attrs as Record<string, unknown>) : {}
  for (const [name, attr] of Object.entries(spec.attrs)) {
    const problem = attrProblem(attr, attrs[name])
    if (problem) issues.push({ path: ["attrs", name], message: `${name} ${problem}` })
  }
  return issues
}

/**
 * The declared attrs of a stored block, ready to render: every declared name, with the
 * default for one that is missing, null or invalid. Undeclared attrs are left out.
 */
export function themeBlockAttrs(spec: ThemeBlockSpec, attrs: unknown): Record<string, string | number | boolean> {
  const source = attrs && typeof attrs === "object" ? (attrs as Record<string, unknown>) : {}
  return Object.fromEntries(
    Object.entries(spec.attrs).map(([name, attr]) => {
      const value = source[name]
      return [name, value !== null && value !== undefined && attrProblem(attr, value) === null ? value : attr.default]
    }),
  ) as Record<string, string | number | boolean>
}

/** The API's manifest (`themes/blocks.manifest.json`): every installed theme block's spec. */
export interface ThemeBlockManifest {
  manifest_version: 1
  blocks: Record<string, { version: number; attrs: Record<string, ThemeAttrSpec> }>
}

export function themeBlockManifest(specs: ThemeBlockSpec[]): ThemeBlockManifest {
  const sorted = <T>(record: Record<string, T>) => Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)))
  return {
    manifest_version: 1,
    blocks: sorted(
      Object.fromEntries(
        specs.map((spec) => [
          spec.type,
          {
            version: spec.version,
            attrs: sorted(
              Object.fromEntries(
                Object.entries(spec.attrs).map(([name, attr]) => [name, sorted<unknown>({ ...attr }) as unknown as ThemeAttrSpec]),
              ),
            ),
          },
        ]),
      ),
    ),
  }
}

/** The manifest file's text, as the generator writes it and the staleness test compares it. */
export const manifestText = (manifest: ThemeBlockManifest): string => `${JSON.stringify(manifest, null, 2)}\n`
