import type { TaxonomyTerm } from "@gl-admin/lib/api/types"

// Pure helpers for the Taxonomies screen and the post sidebar's term pickers (#167).

export interface TermNode {
  term: TaxonomyTerm
  depth: number
}

const byName = (a: TaxonomyTerm, b: TaxonomyTerm) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" })

// Terms in display order: each parent followed by its children, A-Z at every
// level. A term whose parent isn't in the list, or that sits in a parent cycle
// (the API refuses new ones, old data may have them), is shown at the top level
// so it never disappears from the screen.
export function flattenTermTree(terms: TaxonomyTerm[]): TermNode[] {
  const ids = new Set(terms.map((t) => t.id))
  const children = new Map<number, TaxonomyTerm[]>()
  const roots: TaxonomyTerm[] = []
  for (const term of terms) {
    if (term.parent_id && ids.has(term.parent_id) && term.parent_id !== term.id) {
      const siblings = children.get(term.parent_id) ?? []
      siblings.push(term)
      children.set(term.parent_id, siblings)
    } else {
      roots.push(term)
    }
  }

  const result: TermNode[] = []
  const visited = new Set<number>()
  const visit = (term: TaxonomyTerm, depth: number) => {
    if (visited.has(term.id)) return
    visited.add(term.id)
    result.push({ term, depth })
    for (const child of (children.get(term.id) ?? []).sort(byName)) visit(child, depth + 1)
  }
  for (const root of roots.sort(byName)) visit(root, 0)
  // Anything left is only reachable through a cycle.
  for (const term of [...terms].sort(byName)) visit(term, 0)
  return result
}

// The term and everything below it.
export function subtreeIds(terms: TaxonomyTerm[], id: number): Set<number> {
  const result = new Set<number>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const term of terms) {
      if (term.parent_id && result.has(term.parent_id) && !result.has(term.id)) {
        result.add(term.id)
        grew = true
      }
    }
  }
  return result
}

// Terms that may become the parent of `editingId` (any term when creating):
// never the term itself or one of its descendants, which would make a cycle.
export function parentOptions(terms: TaxonomyTerm[], editingId?: number): TermNode[] {
  const excluded = editingId ? subtreeIds(terms, editingId) : new Set<number>()
  return flattenTermTree(terms).filter((node) => !excluded.has(node.term.id))
}

export function childCount(terms: TaxonomyTerm[], id: number): number {
  return terms.filter((t) => t.parent_id === id).length
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

// What deleting a term will do, for the confirmation dialog. Post assignments
// are removed with the term; child terms move to the top level (the parent_id
// foreign key is ON DELETE SET NULL).
export function deleteConsequences(term: TaxonomyTerm, children: number): string[] {
  const lines: string[] = []
  const posts = term.post_count ?? 0
  if (posts > 0) {
    lines.push(`It is assigned to ${plural(posts, "post", "posts")}. Deleting it removes it from ${posts === 1 ? "that post" : "those posts"}.`)
  }
  if (children > 0) {
    lines.push(`${plural(children, "child term moves", "child terms move")} to the top level.`)
  }
  if (lines.length === 0) lines.push("No posts use it.")
  return lines
}

export function findTermByName(terms: TaxonomyTerm[], name: string): TaxonomyTerm | undefined {
  const wanted = name.trim().toLocaleLowerCase()
  return terms.find((t) => t.name.trim().toLocaleLowerCase() === wanted)
}

// "News, go ,news,," -> ["News", "go"]: comma separated, trimmed, no blanks,
// duplicates (ignoring case) dropped.
export function parseTagNames(input: string): string[] {
  const seen = new Set<string>()
  const names: string[] = []
  for (const part of input.split(",")) {
    const name = part.trim()
    const key = name.toLocaleLowerCase()
    if (!name || seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

// Mirrors generateSlug in api/taxonomy_utils.go, which normalizes whatever the
// form sends; used only to preview the slug while typing a new term's name.
export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join("-")
    .replace(/_/g, "-")
    .replace(/-{2,}/g, "-")
}
