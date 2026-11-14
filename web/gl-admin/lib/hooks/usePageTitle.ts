import { useEffect } from "react"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"

// The tab's title for a page (#480, WCAG 2.4.2): "GoLive Admin | <title>". Every
// routed page calls it (pageTitles.test.ts checks), so the title never stays on the
// page before: New post used to show "My profile". Nothing is set while `title` is
// null (still loading); the title the page set before stays meanwhile.
export function adminTitle(baseTitle: string, title: string): string {
  return `${baseTitle.trimEnd()} ${title}`
}

export function usePageTitle(title: string | null | undefined) {
  const { baseTitle } = useGoLive()
  useEffect(() => {
    if (title) document.title = adminTitle(baseTitle, title)
  }, [baseTitle, title])
}
