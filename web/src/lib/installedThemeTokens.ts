/**
 * The API's theme token manifest (#485): themes/tokens.manifest.json, every bundled theme's
 * declared tokens and font options, generated from its theme.config.ts by
 * scripts/theme-blocks-manifest.mjs (`npm run themes:manifest`). The API is Go and can't run
 * a theme's config, so it validates global styles against this file
 * (api/global_styles.go). Only the generator and the tests import this module: it loads
 * every theme's config eagerly.
 */
import { themeTokenManifest } from "./globalStyles"

const CONFIGS = import.meta.glob<{ themeConfig?: object; default?: object }>("../../themes/*/theme.config.ts", { eager: true })

export function installedThemeTokenManifest() {
  const configs: Record<string, object> = {}
  for (const [file, module] of Object.entries(CONFIGS)) {
    const slug = file.split("/").at(-2)
    const config = module.themeConfig ?? module.default
    if (slug && config) configs[slug] = config
  }
  return themeTokenManifest(configs)
}
