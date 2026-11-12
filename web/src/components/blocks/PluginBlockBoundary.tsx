import React, { useContext } from "react"
import { pluginOfBlockType } from "@gl-admin/lib/blocks-spec/themeBlocks"
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
// reports. So on the server the block is first rendered on its own, synchronously, inside a
// try/catch (the probe, `react-dom/server`'s renderToStaticMarkup, registered by the SSR side
// with `setPluginBlockServerProbe` so the admin bundle doesn't carry the server renderer);
// only a block that renders is then rendered into the page. Its markup is exactly the
// renderer's own (no wrapper element: themes style `.block-content > * + *`). The cost is a
// second render of each plugin block. A renderer that throws only on its second render (it
// isn't a pure function of its props) isn't caught; renderers must be pure, as React asks.
// In a browser (the admin's History preview, a theme that hydrates) it is an ordinary error
// boundary.

type ServerProbe = (element: React.ReactElement) => void

let serverProbe: ServerProbe | null = null
let missingProbeLogged = false

/** Set by the SSR server (src/lib/pluginBlockProbe.ts, loaded by the middleware); tests set it too. */
export function setPluginBlockServerProbe(probe: ServerProbe | null) {
  serverProbe = probe
}

const isServer = () => typeof window === "undefined"

function reportFailure(type: string, blockId: string, error: unknown) {
  // Never the block's content or attrs: they're the author's, and the error is enough.
  log.error("plugin_block_render_failed", { plugin: pluginOfBlockType(type), type, block_id: blockId, error })
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
  // The contexts BlockRenderer provides, given to the probe's separate render too, so the
  // block renders there as it does on the page (footnote numbers, heading ids, image sizes).
  const imageSizes = useContext(ImageSizesContext)
  const inGallery = useContext(ImageInGalleryContext)
  const headingIds = useContext(HeadingIdsContext)
  const footnotes = useContext(FootnotesContext)

  if (isServer()) {
    if (serverProbe) {
      try {
        serverProbe(
          <ImageSizesContext.Provider value={imageSizes}>
            <ImageInGalleryContext.Provider value={inGallery}>
              <HeadingIdsContext.Provider value={headingIds}>
                <FootnotesContext.Provider value={footnotes}>{children}</FootnotesContext.Provider>
              </HeadingIdsContext.Provider>
            </ImageInGalleryContext.Provider>
          </ImageSizesContext.Provider>,
        )
      } catch (error) {
        reportFailure(type, blockId, error)
        return null
      }
    } else if (!missingProbeLogged) {
      missingProbeLogged = true
      log.warn("plugin_block_probe_missing", { type })
    }
  }
  return (
    <BrowserBoundary type={type} blockId={blockId}>
      {children}
    </BrowserBoundary>
  )
}
