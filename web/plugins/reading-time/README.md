# Reading time (example plugin)

The repository's example plugin (#456): one content block, `plugin:reading-time/estimate`, that
shows a post's estimated reading time ("4 min read"). It exists to show the shape of a plugin
with a block and to keep the plugin block path exercised by the test suites
(`themeBlocks.loadable.test.ts`, `schema.test.ts`, the collab bundle's process test, Go's
`TestRepositoryPluginBlocks`).

```
plugin.json                      # The manifest (plugins/README.md).
blocks/Estimate/
  block.json                     # The block's definition: data only. Collab and the API read it.
  editor.ts, EstimateView.tsx    # Admin only: the node view and the menu entry.
  render.tsx                     # The public renderer.
  readingTime.ts                 # The estimate, shared by both halves.
```

- **Attrs:** `label` (text after the number, default `min read`, at most 40 characters).
- **The estimate** counts the words of every block's stored text at 200 a minute, at least one
  minute. A words-per-minute setting waits for plugin settings (#457).
- It starts disabled, like every plugin. Enabling it offers the block in the slash and + menus;
  disabling it takes it out of the menus only: existing blocks keep editing and keep rendering
  on the public site (`docs/design/plugin-system.md` 4.4).
