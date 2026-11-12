import { renderToStaticMarkup } from "react-dom/server"
import { setPluginBlockServerProbe } from "../components/blocks/PluginBlockBoundary"

// Server only (#456): gives PluginBlockBoundary the server renderer it probes a plugin block
// with (a throw there hides that block instead of failing the page). Imported for this side
// effect by the middleware, which every SSR request runs through, so the admin's browser
// bundle never carries react-dom/server.
setPluginBlockServerProbe((element) => {
  renderToStaticMarkup(element)
})
