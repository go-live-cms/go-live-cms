import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react"
import Button, { IconButton } from "@gl-admin/components/ui/Button"
import Select from "@gl-admin/components/ui/Select"
import { ExternalIcon } from "@gl-admin/components/ui/icons"
import { toast } from "@gl-admin/components/ui/Toast"
import { openDesignPreview } from "@gl-admin/lib/api/designPreview"
import { errorMessage } from "@gl-admin/lib/api/errors"
import "@gl-admin/assets/styles/pages/global-styles.scss"

// The Site editor's preview frame (docs/design/theme-builder.md 8.3, the global styles
// board): the public site with the draft design, through #486's preview cookie. It always
// shows what the server has, never the form's state: it reloads after each save
// (`reloadKey`). Desktop or Phone width, Light or Dark (the frame is same-origin, so its
// <html data-theme> is set directly, never the reader's stored choice), and which page.

export type PreviewDevice = "desktop" | "phone"
export type PreviewScheme = "light" | "dark"

const VIEWPORT: Record<PreviewDevice, number> = { desktop: 1280, phone: 375 }
const FRAME_HEIGHT = 620

/** Pages the frame can show, without reading any content: each exercises its own layout. */
export const PREVIEW_PAGES = [
  { value: "/", label: "Home" },
  { value: "/search?q=the", label: "Search results" },
  { value: "/gl-preview-page-not-found", label: "Page not found" },
] as const

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  return (
    <div className="gl-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export type PreviewPage = { value: string; label: string }

export default function StylesPreview({
  reloadKey,
  pages = PREVIEW_PAGES,
  frameTitle = "Your site with these styles",
  note = "Shows what's saved, reloaded after each save. Posts are the published ones.",
  className = "",
}: {
  reloadKey: number
  /** The pages the picker offers (the template editor: the posts or lists its route renders). */
  pages?: readonly PreviewPage[]
  frameTitle?: string
  note?: string
  className?: string
}) {
  const frameName = `gl-styles-preview-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`
  const frameRef = useRef<HTMLIFrameElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [device, setDevice] = useState<PreviewDevice>("desktop")
  const [scheme, setScheme] = useState<PreviewScheme>("light")
  const [chosen, setPath] = useState<string | null>(null)
  // The chosen page while it is offered, else the first (the list may arrive later).
  const path = chosen && pages.some((page) => page.value === chosen) ? chosen : (pages[0]?.value ?? "/")
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading")
  const [width, setWidth] = useState(438)
  const schemeRef = useRef(scheme)
  schemeRef.current = scheme

  const applyScheme = useCallback(() => {
    try {
      frameRef.current?.contentDocument?.documentElement?.setAttribute("data-theme", schemeRef.current)
    } catch {
      // Not same-origin (a page that redirected off the site): leave it as it is.
    }
  }, [])

  // Saves can come faster than tokens: only the newest load may say the preview failed.
  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setStatus("loading")
    try {
      await openDesignPreview(frameName, path)
    } catch {
      if (seq === loadSeq.current) setStatus("error")
    }
  }, [frameName, path])

  useEffect(() => {
    void load()
  }, [load, reloadKey])

  useEffect(applyScheme, [scheme, applyScheme])

  useLayoutEffect(() => {
    const stage = stageRef.current
    if (!stage || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(stage)
    return () => observer.disconnect()
  }, [])

  const openInTab = async () => {
    // Opened now, while the click still counts as the user's; the token is posted into it.
    const name = `${frameName}-tab`
    const tab = window.open("", name)
    if (!tab) {
      toast.error("Your browser blocked the new tab. Allow pop-ups for this site and try again.")
      return
    }
    try {
      await openDesignPreview(name, path)
    } catch (error) {
      tab.close()
      toast.error(`Couldn't open the preview. ${errorMessage(error)}`)
    }
  }

  const viewport = VIEWPORT[device]
  const scale = Math.min(1, width > 0 ? width / viewport : 1)

  return (
    <aside className={`gl-styles-preview ${className}`.trim()} aria-labelledby={`${frameName}-h`}>
      <h2 id={`${frameName}-h`} className="gl-visually-hidden">
        Preview
      </h2>
      <div className="gl-styles-preview__bar">
        <Segmented<PreviewDevice>
          label="Width"
          value={device}
          onChange={setDevice}
          options={[
            { value: "desktop", label: "Desktop" },
            { value: "phone", label: "Phone" },
          ]}
        />
        <Segmented<PreviewScheme>
          label="Colour scheme"
          value={scheme}
          onChange={setScheme}
          options={[
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
        <span className="gl-styles-preview__spacer" />
        <IconButton
          aria-label="Open the preview in a new tab"
          icon={<ExternalIcon size={16} />}
          variant="ghost"
          onClick={openInTab}
        />
      </div>
      <Select
        label="Page"
        value={path}
        onChange={setPath}
        options={pages.map((page) => ({ ...page }))}
        className="gl-styles-preview__page"
      />
      <div
        ref={stageRef}
        className={`gl-styles-preview__stage is-${device}`}
        style={{ height: FRAME_HEIGHT }}
        aria-busy={status === "loading" || undefined}
      >
        <iframe
          ref={frameRef}
          name={frameName}
          title={frameTitle}
          className="gl-styles-preview__frame"
          hidden={status === "error"}
          style={{
            width: viewport,
            height: FRAME_HEIGHT / scale,
            transform: `scale(${scale})`,
            marginLeft: device === "phone" ? Math.max(0, (width - viewport * scale) / 2) : 0,
          }}
          onLoad={() => {
            applyScheme()
            // The first load is the empty frame, before the preview's form is posted.
            let blank = false
            try {
              blank = frameRef.current?.contentWindow?.location.href === "about:blank"
            } catch {
              // Another origin: a page, so not the empty frame.
            }
            if (!blank) setStatus("ready")
          }}
        />
        {status === "error" && (
          <div className="gl-styles-preview__error" role="status">
            <strong>The preview couldn't load</strong>
            <span>Your changes are saved. The site didn't answer.</span>
            <Button variant="secondary" onClick={() => void load()}>
              Reload preview
            </Button>
          </div>
        )}
      </div>
      <p className="gl-styles-preview__note">{note}</p>
    </aside>
  )
}
