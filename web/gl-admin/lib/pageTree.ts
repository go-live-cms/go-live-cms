// The Pages list's tree (#340): pages under their post_parent, siblings by menu_order.

export type TreePage = {
  id: number
  title: string
  post_parent?: number | null
  menu_order: number
}

export type PageRow<T extends TreePage> = {
  page: T
  // 0 for a top-level page.
  depth: number
  // Its parent isn't in the list (filtered out, deleted, or a parent loop), so it's
  // shown at the top level.
  orphan: boolean
}

// Siblings: menu_order, then title, then id, so ties always come out the same way.
export function comparePages(a: TreePage, b: TreePage): number {
  return a.menu_order - b.menu_order || a.title.localeCompare(b.title) || a.id - b.id
}

// Depth-first rows, each page right after its parent. A page whose parent is missing
// becomes a top-level orphan. Pages caught in a parent loop (no way up to the top) are
// broken open at the loop's first page in sibling order, so every page appears once.
export function buildPageTree<T extends TreePage>(pages: T[]): PageRow<T>[] {
  const ids = new Set(pages.map((p) => p.id))
  const children = new Map<number, T[]>()
  const roots: { page: T; orphan: boolean }[] = []

  for (const page of pages) {
    const parent = page.post_parent
    if (parent == null || parent === 0) {
      roots.push({ page, orphan: false })
    } else if (!ids.has(parent) || parent === page.id) {
      roots.push({ page, orphan: true })
    } else {
      const list = children.get(parent) ?? []
      list.push(page)
      children.set(parent, list)
    }
  }

  const rows: PageRow<T>[] = []
  const seen = new Set<number>()
  const visit = (page: T, depth: number, orphan: boolean) => {
    if (seen.has(page.id)) return
    seen.add(page.id)
    rows.push({ page, depth, orphan })
    for (const child of (children.get(page.id) ?? []).sort(comparePages)) visit(child, depth + 1, false)
  }

  roots.sort((a, b) => comparePages(a.page, b.page)).forEach((r) => visit(r.page, 0, r.orphan))

  // What's left hangs off a loop.
  for (const page of [...pages].sort(comparePages)) {
    if (!seen.has(page.id)) visit(page, 0, true)
  }
  return rows
}
