/**
 * The footer's link columns (#347), shared by the default theme's `SiteFooter` and, since #498, the
 * navigation site block's `columns` layout. Pure, with no imports, so the block renderers (which
 * the admin's revision preview loads too) can use it.
 */

/** A column: the top-level link it is made of (its heading), or null for the "Site" column, and its links. */
export interface MenuColumn<T> {
  heading: T | null
  links: T[]
}

/**
 * Each top-level link with children is a column headed by its label; the top-level links without
 * children are collected in one column (the theme titles it "Site"), in the place of the first of them.
 */
export function footerColumns<T extends { children: T[] }>(items: readonly T[]): MenuColumn<T>[] {
  const columns: MenuColumn<T>[] = []
  let loose: MenuColumn<T> | null = null
  for (const item of items) {
    if (item.children.length > 0) {
      columns.push({ heading: item, links: item.children })
    } else {
      if (!loose) {
        loose = { heading: null, links: [] }
        columns.push(loose)
      }
      loose.links.push(item)
    }
  }
  return columns
}
