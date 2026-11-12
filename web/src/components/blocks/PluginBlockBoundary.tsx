import React, { createContext, useContext } from "react"
import { pluginOfBlockType } from "@gl-admin/lib/blocks-spec/themeBlocks"
import { EMPTY_FOOTNOTE_INDEX } from "@gl-admin/lib/blocks-spec/footnotes"
import { ImageInGalleryContext, ImageSizesContext } from "./utils/responsiveImage"
import { HeadingIdsContext } from "./utils/headingAnchors"
import { FootnotesContext } from "./utils/footnotes"
// Browser-safe: the admin's revision preview renders plugin blocks too.
import { log } from "../../lib/log"

// The per-block safeguard for plugin blocks (#456): on the public site and in the admin's
// preview, a plugin's renderer that throws renders **nothing** for that block, shows no error
// text, and is logged with the plugin slug, the block type and the error; the rest of the
// page renders. Theme and core blocks don't go through this.
//
// React has no error boundaries on the server: Fizz unwinds a throw to the nearest Suspense
// boundary at best, and Astro's React renderer fails the whole component on any error it
// reports. So on the server each plugin block is first rendered on its own, synchronously,
// inside a try/catch (the probe, `react-dom/server`'s renderToStaticMarkup, registered by the
// SSR side with `setPluginBlockServerProbe` so the admin bundle doesn't carry the server
// renderer); only a block that renders is then rendered into the page. Its markup is exactly
// the renderer's own (no wrapper element: themes style `.block-content > * + *`). The cost is
// a second render of each plugin block. A renderer that throws only on its second render (it
// isn't a pure function of its props) isn't caught; renderers must be pure, as React asks.
//
// BlockRenderer probes every plugin block of the doc before it renders anything
// (`probePluginBlocks`), so the footnotes it numbers leave out a hidden block's references,
// and hands the result down (`PluginBlockChecksContext`); the boundary then only reads it. A
// block rendered without BlockRenderer around it is probed by its boundary. In a browser (the
// admin's History preview, a theme that hydrates) it is an ordinary error boundary.

type ServerProbe = (element: React.ReactElement) => void

let serverProbe: ServerProbe | null = null
let missingProbeLogged = false

/** Set by the SSR server (src/lib/pluginBlockProbe.ts, loaded by the middleware); tests set it too. */
export function setPluginBlockServerProbe(probe: ServerProbe | null) {
  serverProbe = probe
}

const isServer = () => typeof window === "undefined"

/** At most one log line per block type in this window, with how many were left out. */
const FAILURE_LOG_INTERVAL_MS = 60_000
const failureLog = new Map<string, { at: number; suppressed: number }>()

function reportFailure(type: string, blockId: string, error: unknown) {
  // A broken renderer on a busy page would otherwise write a line (and a stack) per view.
  const now = Date.now()
  const last = failureLog.get(type)
  if (last && now - last.at < FAILURE_LOG_INTERVAL_MS) {
    last.suppressed += 1
    return
  }
  failureLog.set(type, { at: now, suppressed: 0 })
  // Never the block's content or attrs: they're the author's, and the error is enough.
  log.error("plugin_block_render_failed", {
    plugin: pluginOfBlockType(type),
    type,
    block_id: blockId,
    error,
    ...(last?.suppressed ? { suppressed: last.suppressed } : {}),
  })
}

/** Tests only: forget which failures were logged. */
export function resetPluginBlockFailureLog() {
  failureLog.clear()
}

/**
 * The plugin blocks BlockRenderer already probed, by whether they failed: the ids whose
 * renderer threw. null = not probed (a browser, no probe registered, or no BlockRenderer).
 */
export const PluginBlockChecksContext = createContext<ReadonlySet<string> | null>(null)

interface ProbeContexts {
  imageSizes: string
  headingIds: ReadonlyMap<string, string>
}

/** Renders `element` on its own through the server probe; false (and logged) when it throws. */
function probe(type: string, blockId: string, element: React.ReactElement): boolean {
  try {
    serverProbe!(element)
    return true
  } catch (error) {
    reportFailure(type, blockId, error)
    return false
  }
}

function warnMissingProbe(type: string) {
  if (missingProbeLogged) return
  missingProbeLogged = true
  log.warn("plugin_block_probe_missing", { type })
}

/**
 * Server only: probes each plugin block in `blocks` (`elementFor` builds its renderer's
 * element, unguarded) and returns the ids whose renderer throws. null in a browser or when no
 * probe is registered (the boundaries then do what they can). The footnote index isn't known
 * yet, so the probe renders references as nothing; nothing else differs from the page.
 */
export function probePluginBlocks(
  blocks: readonly { id: string; type: string }[],
  elementFor: (blockId: string) => React.ReactElement | null,
  contexts: ProbeContexts,
): Set<string> | null {
  if (!isServer()) return null
  const plugin = blocks.filter((block) => pluginOfBlockType(block.type) !== null)
  if (!serverProbe) {
    if (plugin.length > 0) warnMissingProbe(plugin[0].type)
    return null
  }
  const failed = new Set<string>()
  for (const block of plugin) {
    let element: React.ReactElement | null
    try {
      element = elementFor(block.id)
    } catch (error) {
      reportFailure(block.type, block.id, error)
      failed.add(block.id)
      continue
    }
    if (!element) continue
    const wrapped = (
      <ImageSizesContext.Provider value={contexts.imageSizes}>
        <HeadingIdsContext.Provider value={contexts.headingIds}>
          <FootnotesContext.Provider value={EMPTY_FOOTNOTE_INDEX}>{element}</FootnotesContext.Provider>
        </HeadingIdsContext.Provider>
      </ImageSizesContext.Provider>
    )
    if (!probe(block.type, block.id, wrapped)) failed.add(block.id)
  }
  return failed
}

interface BoundaryProps {
  type: string
  blockId: string
  children: React.ReactElement
}

class BrowserBoundary extends React.Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    reportFailure(this.props.type, this.props.blockId, error)
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}

/** One plugin block, rendered only if its renderer doesn't throw. */
export function PluginBlockBoundary({ type, blockId, children }: BoundaryProps): React.ReactElement | null {
  const checked = useContext(PluginBlockChecksContext)
  // The contexts BlockRenderer provides, given to the probe's separate render too, so the
  // block renders there as it does on the page (footnote numbers, heading ids, image sizes).
  const imageSizes = useContext(ImageSizesContext)
  const inGallery = useContext(ImageInGalleryContext)
  const headingIds = useContext(HeadingIdsContext)
  const footnotes = useContext(FootnotesContext)

  if (checked) {
    // BlockRenderer probed it already (and logged a failure).
    if (checked.has(blockId)) return null
  } else if (isServer()) {
    if (serverProbe) {
      const ok = probe(
        type,
        blockId,
        <ImageSizesContext.Provider value={imageSizes}>
          <ImageInGalleryContext.Provider value={inGallery}>
            <HeadingIdsContext.Provider value={headingIds}>
              <FootnotesContext.Provider value={footnotes}>{children}</FootnotesContext.Provider>
            </HeadingIdsContext.Provider>
          </ImageInGalleryContext.Provider>
        </ImageSizesContext.Provider>,
      )
      if (!ok) return null
    } else {
      warnMissingProbe(type)
    }
  }
  return (
    <BrowserBoundary type={type} blockId={blockId}>
      {children}
    </BrowserBoundary>
  )
}
