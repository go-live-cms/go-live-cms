import { useLocation } from "react-router-dom"
import { useMemo } from "react"

export function useRouteClasses(baseClass = "admin-main") {
  const location = useLocation()

  return useMemo(() => {
    const path = location.pathname
    const classes = [baseClass]

    const routeMap: Record<string, string[]> = {
      "/content/posts/new": ["editor", "new-content", "posts"],
      "/content/pages/new": ["editor", "new-content", "pages"],
      "/content/edit/": ["editor", "edit-content"],
      // The template and part editors are the post editor's chrome (#493); History scrolls as a page.
      "/site-editor/templates/": ["editor", "edit-content", "site-template"],
      "/site-editor/history": ["site-editor-history"],
      "/site-editor/": ["site-editor"],
      "/content/posts": ["content-list", "posts"],
      "/content/pages": ["content-list", "pages"],
      "/content": ["content"],
      "/media": ["media"],
      "/": ["dashboard"],
      "/404": ["error"],
    }

    if (routeMap[path]) {
      classes.push(...routeMap[path].map((cls) => `${baseClass}--${cls}`))
    } else {
      for (const [route, classNames] of Object.entries(routeMap)) {
        if (route.endsWith("/") && path.startsWith(route)) {
          classes.push(...classNames.map((cls) => `${baseClass}--${cls}`))
          break
        }
      }
    }

    return classes.join(" ")
  }, [location.pathname, baseClass])
}
