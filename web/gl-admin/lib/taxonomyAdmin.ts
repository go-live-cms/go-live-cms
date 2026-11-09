import type { TaxonomyTerm, TaxonomyType } from "@gl-admin/lib/api/types"
import type { PostUrlStructure } from "@gl-admin/lib/api/settings"
import { ApiError, errorMessage } from "@gl-admin/lib/api/errors"
import { plural } from "@gl-admin/utils/formatting"
import { childCount, flattenTermTree, parentOptions, slugify, type TermNode } from "@gl-admin/lib/taxonomy/terms"

// The Taxonomies screen's rules and wording for #331: one category per post, categories
// nested one level and part of post URLs (post_url_structure "category"), the default
// category, slug changes that add redirects, and merging tags. Pure; tested in
// taxonomyAdmin.test.ts.

export const CATEGORY_TAXONOMY = "category"

type TypeInfo = Pick<TaxonomyType, "name" | "hierarchical"> & Partial<Pick<TaxonomyType, "public" | "default_term_id" | "label">>

// "category" from "Categories": the types only carry a plural label.
export function singularTaxonomyLabel(type: Pick<TaxonomyType, "label" | "name">): string {
  const label = type.label.trim()
  const lower = label.toLowerCase()
  if (lower.endsWith("ies")) return lower.slice(0, -3) + "y"
  if (lower.endsWith("s") && !lower.endsWith("ss")) return lower.slice(0, -1)
  return lower || type.name
}

export function isCategoryType(type: Pick<TaxonomyType, "name">): boolean {
  return type.name === CATEGORY_TAXONOMY
}

// Categories nest one level (the API's nesting_too_deep); other hierarchical types nest freely.
export function nestsOneLevel(type: TypeInfo): boolean {
  return type.hierarchical && isCategoryType(type)
}

export function isDefaultTerm(type: Pick<TypeInfo, "default_term_id">, term: Pick<TaxonomyTerm, "id"> | null | undefined): boolean {
  return term != null && type.default_term_id != null && type.default_term_id === term.id
}

// Not public = no pages, so no URL and no redirect. Absent counts as public.
const isPublic = (type: TypeInfo) => type.public !== false

// The parents `editingId` may get (any when creating). One-level types: only top-level
// terms other than itself, and none at all when it has children of its own.
export function termParentOptions(type: TypeInfo, terms: TaxonomyTerm[], editingId?: number): TermNode[] {
  if (!nestsOneLevel(type)) return parentOptions(terms, editingId)
  if (editingId && childCount(terms, editingId) > 0) return []
  return flattenTermTree(terms).filter(({ term }) => !term.parent_id && term.id !== editingId)
}

// Why the parent picker offers only "None": the term has children of its own.
export function parentHint(type: TypeInfo, terms: TaxonomyTerm[], term?: Pick<TaxonomyTerm, "id" | "name">): string | undefined {
  if (!nestsOneLevel(type) || !term || childCount(terms, term.id) === 0) return undefined
  return `“${term.name}” has subcategories, so it stays at the top level.`
}

// The line above the list.
export function taxonomyIntro(type: TypeInfo & Pick<TaxonomyType, "description">, structure: PostUrlStructure | undefined): string {
  if (isCategoryType(type)) {
    return structure === "category"
      ? "Each post has one category. Categories can be nested one level and appear in the post’s URL."
      : "Each post has one category. Categories can be nested one level."
  }
  return type.description ?? ""
}

// What the slug follows in an address: "/" when categories start post URLs
// (/guides/my-post), else the term page's "/tag/". null for a type without pages.
export function slugPrefix(type: TypeInfo, structure: PostUrlStructure | undefined): string | null {
  if (!isPublic(type)) return null
  if (isCategoryType(type) && structure === "category") return "/"
  return `/${type.name}/`
}

// The slug a save sends: the typed one, or the name's when it's left empty.
export function effectiveSlug(slug: string, name: string): string {
  return slugify(slug) || slugify(name)
}

// The note under an edited term's slug once it differs from the saved one: the API adds
// a redirect from the old address, and under the category URL structure the category's
// posts change address too.
export function slugChangeNote(
  type: TypeInfo,
  term: Pick<TaxonomyTerm, "slug" | "post_count"> | undefined,
  slug: string,
  name: string,
  structure: PostUrlStructure | undefined
): string | null {
  if (!term || !isPublic(type)) return null
  const next = effectiveSlug(slug, name)
  if (!next || next === term.slug) return null
  const posts = term.post_count ?? 0
  if (isCategoryType(type) && structure === "category" && posts > 0) {
    return `Changing it updates ${plural(posts, "post URL", "post URLs")}. Old links redirect.`
  }
  return "Old links redirect."
}

// Everything under the slug field: how an empty or unusual slug is saved, then the
// change note.
export function slugHint(
  type: TypeInfo,
  term: Pick<TaxonomyTerm, "slug" | "post_count"> | undefined,
  slug: string,
  name: string,
  structure: PostUrlStructure | undefined
): string | undefined {
  const parts: string[] = []
  const trimmed = slug.trim()
  if (!trimmed) parts.push(`Leave empty to use “${slugify(name) || "…"}”.`)
  else if (slugify(slug) !== trimmed) parts.push(`Saved as “${slugify(slug)}”.`)
  const note = slugChangeNote(type, term, slug, name, structure)
  if (note) parts.push(note)
  return parts.join(" ") || undefined
}

// "Photos", "Photos and Pictures", "Photos, Pictures and Pics".
export function joinNames(names: string[], word = "and"): string {
  if (names.length <= 1) return names[0] ?? ""
  return `${names.slice(0, -1).join(", ")} ${word} ${names[names.length - 1]}`
}

export function termPath(taxonomy: string, slug: string): string {
  return `/${taxonomy}/${slug}`
}

// The tag the merge keeps by default: the one on the most posts, then A–Z.
export function defaultKeep(terms: TaxonomyTerm[]): TaxonomyTerm | undefined {
  return [...terms].sort((a, b) => (b.post_count ?? 0) - (a.post_count ?? 0) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))[0]
}

// Up to this many old addresses are listed by name.
const MAX_LISTED_PATHS = 3

// What merging does, as on the board: "The 3 posts tagged Photos get Images instead, and
// Photos is deleted. /tag/photos redirects to /tag/images."
export function mergeSummary(type: TypeInfo, keep: TaxonomyTerm, sources: TaxonomyTerm[]): string {
  if (sources.length === 0) return ""
  const tagged = type.name === "tag" ? "tagged" : "with"
  const posts = sources.reduce((n, t) => n + (t.post_count ?? 0), 0)
  const either = joinNames(sources.map((t) => t.name), "or")
  const all = joinNames(sources.map((t) => t.name))
  const isAre = sources.length === 1 ? "is" : "are"

  let text: string
  if (posts === 0) text = `No posts are ${tagged} ${either}. ${all} ${isAre} deleted.`
  else if (posts === 1) text = `The post ${tagged} ${either} gets ${keep.name} instead, and ${all} ${isAre} deleted.`
  else text = `The ${posts} posts ${tagged} ${either} get ${keep.name} instead, and ${all} ${isAre} deleted.`

  if (!isPublic(type)) return text
  const target = termPath(type.name, keep.slug)
  if (sources.length === 1) return `${text} ${termPath(type.name, sources[0].slug)} redirects to ${target}.`
  if (sources.length <= MAX_LISTED_PATHS) return `${text} ${joinNames(sources.map((t) => termPath(type.name, t.slug)))} redirect to ${target}.`
  return `${text} Their old addresses redirect to ${target}.`
}

export type TermErrorContext = "save" | "delete" | "merge"

// The API's codes as sentences, with the field they belong to.
export function termErrorMessage(error: unknown, context: TermErrorContext = "save"): { field: "slug" | "parent" | null; message: string } {
  const code = error instanceof ApiError ? error.code : null
  switch (code) {
    case "slug_taken":
      return { field: "slug", message: "Another term already uses this slug. Slugs are unique across all taxonomies." }
    case "slug_reserved":
      return { field: "slug", message: "This slug is already part of the site’s addresses (a post type, a taxonomy or a reserved path). Pick another." }
    case "nesting_too_deep":
      return {
        field: "parent",
        message: "Categories nest one level: the parent must be a top-level category, and a category with subcategories stays at the top level.",
      }
    case "default_term":
      return {
        field: null,
        message:
          context === "merge"
            ? "The default category can’t be merged away."
            : "This is the default category, so it can’t be deleted. Posts without a category get it.",
      }
    case "merge_not_supported":
      return { field: null, message: "Categories can’t be merged. Move their posts to another category instead." }
    case "merge_type_mismatch":
      return { field: null, message: "Only terms of the same taxonomy can be merged." }
    case "one_category":
      return { field: null, message: "A post has one category." }
  }
  return { field: null, message: errorMessage(error) }
}
