// What build.mjs refuses in the collab bundle, as plain functions so they're tested
// (bundleChecks.test.ts) without running esbuild. Inputs are the metafile's paths with
// forward slashes.

// Theme and plugin blocks (#376, #452): only their headless definitions belong in the
// bundle. A theme's or plugin's editor.ts (React node view) or render.tsx, or React itself,
// means a client-only module leaked in.
const CLIENT_ONLY_PACKAGE = /node_modules\/(react|react-dom|@tiptap\/react)\//
const CLIENT_ONLY_EXTENSION_FILE = /(^|\/)(themes|plugins)\/[^/]+\/blocks\/.+\/(editor|render)\.[jt]sx?$/

/** The inputs that must not be in the collab bundle. */
export const clientOnlyInputs = (inputs) =>
  inputs.filter((input) => CLIENT_ONLY_PACKAGE.test(input) || CLIENT_ONLY_EXTENSION_FILE.test(input))

/** The installed theme blocks' headless definitions in the bundle (counted in the build's log line). */
export const themeBlockInputs = (inputs) => inputs.filter((input) => /(^|\/)themes\/[^/]+\/blocks\/[^/]+\/index\.ts$/.test(input))

// Plugins (#456, rule 13): the collab server reads a plugin's block.json and plugin.json and
// nothing else, so no plugin JavaScript can change the bundle's module graph. Inputs here are
// relative to web/ (build.mjs resolves them), so web/gl-admin/lib/plugins/ doesn't count.
const PLUGIN_FILE = /^plugins\//

/** The plugin files in the bundle that aren't JSON: always a leak. */
export const pluginCodeInputs = (webRelativeInputs) =>
  webRelativeInputs.filter((input) => PLUGIN_FILE.test(input) && !/\.json$/.test(input))

/** The installed plugin blocks' block.json files in the bundle (counted in the build's log line). */
export const pluginBlockInputs = (webRelativeInputs) =>
  webRelativeInputs.filter((input) => /^plugins\/[^/]+\/blocks\/[^/]+\/block\.json$/.test(input))
