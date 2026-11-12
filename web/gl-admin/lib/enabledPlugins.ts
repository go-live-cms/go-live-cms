import { apiCall } from "./api"
import { setEnabledPlugins } from "../components/editor/blocks/catalog"

// Which plugins' blocks the block menus offer (#456, docs/design/plugin-system.md 4.3):
// `GET /plugins/enabled` (any content role, slugs only), read by ThemeProvider when the admin
// loads and again whenever the tab becomes visible, like the active theme. Memory only.
//
// Nothing else follows it: the editor's and collab server's schemas are every installed
// plugin's blocks, enabled or not (design 5.3), so a tab that hasn't noticed a change can
// still edit an existing block, and enabling or disabling restarts nothing. A failed read
// offers no plugin block (existing ones still edit).

export type EnabledPluginsFetcher = () => Promise<unknown>

const fetchEnabledPlugins: EnabledPluginsFetcher = () => apiCall("/plugins/enabled")

/** The slugs in an answer of `GET /plugins/enabled` (`{"plugins": [...]}`), or null when it isn't one. */
export function enabledPluginSlugs(answer: unknown): string[] | null {
  const plugins = (answer as { plugins?: unknown } | null)?.plugins
  if (!Array.isArray(plugins) || !plugins.every((slug) => typeof slug === "string")) return null
  return plugins
}

let latestRead = 0

/**
 * Reads the enabled list and hands it to the block menus (`setEnabledPlugins`). A failed or
 * malformed answer sets the empty list. Only the newest read applies, so a slow answer never
 * replaces a later one.
 */
export async function refreshEnabledPlugins(fetcher: EnabledPluginsFetcher = fetchEnabledPlugins): Promise<void> {
  const read = ++latestRead
  let slugs: string[] = []
  try {
    slugs = enabledPluginSlugs(await fetcher()) ?? []
  } catch {
    slugs = []
  }
  if (read === latestRead) setEnabledPlugins(slugs)
}

/** Reads now and on every return to the tab; returns the cleanup. */
export function watchEnabledPlugins(fetcher: EnabledPluginsFetcher = fetchEnabledPlugins, doc: Document = document): () => void {
  void refreshEnabledPlugins(fetcher)
  const onVisibility = () => {
    if (doc.visibilityState === "visible") void refreshEnabledPlugins(fetcher)
  }
  doc.addEventListener("visibilitychange", onVisibility)
  return () => doc.removeEventListener("visibilitychange", onVisibility)
}
