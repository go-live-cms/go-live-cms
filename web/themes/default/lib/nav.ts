/**
 * The header's links (#345). Navigation menus are #347; until then the nav is the
 * public pages that exist: the front page (the site title) and the posts list.
 */
export type NavKey = "home" | "posts"

export const NAV_ITEMS: { key: Exclude<NavKey, "home">; label: string; href: string }[] = [
  { key: "posts", label: "Posts", href: "/post" },
]
