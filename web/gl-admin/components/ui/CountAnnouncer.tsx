import { useEffect, useRef, useState } from "react"
import { COUNT_ANNOUNCE_DELAY_MS, countAnnouncement } from "@gl-admin/lib/countAnnouncement"
import "@gl-admin/assets/styles/components/ui/input.scss"

/**
 * A character counter's voice (#477): a visually hidden status region, in the page from
 * the start, that says how many characters are left (or over) only near or over the limit,
 * and only once typing has paused. Opening a field that's already long says nothing; the
 * visible counter is the field's description for that. Pair it with a counter that is not
 * a live region.
 */
export default function CountAnnouncer({ count, limit, overNote }: { count: number; limit: number; overNote?: string }) {
  const [message, setMessage] = useState("")
  // The count last seen: the one it opened with isn't news (and StrictMode's second run of
  // the effect sees no change).
  const last = useRef(count)
  useEffect(() => {
    if (count === last.current) return
    last.current = count
    const said = countAnnouncement(count, limit, overNote)
    if (!said) {
      setMessage("")
      return
    }
    const timer = setTimeout(() => setMessage(said), COUNT_ANNOUNCE_DELAY_MS)
    return () => clearTimeout(timer)
  }, [count, limit, overNote])
  return (
    <span role="status" className="gl-visually-hidden">
      {message}
    </span>
  )
}
