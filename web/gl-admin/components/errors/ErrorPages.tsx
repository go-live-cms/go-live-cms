import { useEffect, useId, useState, type ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import Button, { buttonClassName } from "@gl-admin/components/ui/Button"
import { toast } from "@gl-admin/components/ui/Toast"
import { CopyIcon } from "@gl-admin/components/ui/icons"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import { authManager } from "@gl-admin/lib/auth"
import { useAuthUser } from "@gl-admin/lib/hooks/useAuthUser"
import { roleLabel } from "@gl-admin/lib/roles"
import { errorPageFor, forbiddenReason } from "@gl-admin/lib/errorPages"
import "@gl-admin/assets/styles/pages/error-page.scss"

// The admin's full-page errors (#339): 404, 403 and the generic one with an error ID.
// They render inside the shell, so the sidebar stays usable. Search and "Check the
// trash" on the 404 wait for #327; the 403's list of admins needs a users endpoint
// contributors may read, so it isn't shown.

type ErrorLayoutProps = {
  code: string
  title: string
  children: ReactNode
  actions: ReactNode
}

function ErrorLayout({ code, title, children, actions }: ErrorLayoutProps) {
  const { baseTitle } = useGoLive()

  // Put the old title back on the way out, so a page that recovers (Try again) and
  // sets none of its own doesn't keep this one.
  useEffect(() => {
    const previous = document.title
    document.title = `${baseTitle} ${title}`
    return () => {
      document.title = previous
    }
  }, [baseTitle, title])

  return (
    <div className="gl-error-page">
      <div className="gl-error-page__body">
        <p className="gl-error-page__code">{code}</p>
        <div className="gl-error-page__text">
          <h1 className="gl-error-page__title">{title}</h1>
          {children}
        </div>
        <div className="gl-error-page__actions">{actions}</div>
      </div>
    </div>
  )
}

function HomeLink({ variant = "primary" }: { variant?: "primary" | "ghost" }) {
  return (
    <Link to="/" className={buttonClassName(variant, "lg")}>
      <span className="gl-button__label">Go to Home</span>
    </Link>
  )
}

export function NotFoundPage() {
  const { pathname } = useLocation()
  const shown = pathname === "/404" ? null : `/gl-admin${pathname}`

  return (
    <ErrorLayout code="Error 404" title="We can’t find that page" actions={<HomeLink />}>
      <p className="gl-error-page__message">
        {shown && (
          <>
            There’s nothing at <code className="gl-error-page__path">{shown}</code>.{" "}
          </>
        )}
        The link may be mistyped, or the post was deleted or moved. If someone sent it to you, ask them for a new one.
      </p>
    </ErrorLayout>
  )
}

function withArticle(word: string): string {
  return `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`
}

type ForbiddenPageProps = {
  // What the guard refused, plural: "Settings", "Users". Omitted for an API 403.
  area?: string
  // A specific reason from the API ("you can only delete your own media").
  serverMessage?: string | null
}

export function ForbiddenPage({ area, serverMessage = null }: ForbiddenPageProps) {
  const user = useAuthUser()
  const name = user?.full_name || user?.username
  const role = roleLabel(user?.role)?.toLowerCase()

  return (
    <ErrorLayout
      code="Error 403"
      title="You don’t have access to this"
      actions={
        <>
          <HomeLink />
          {/* AuthGuard sends the signed-out user to the login page. */}
          <Button variant="ghost" size="lg" onClick={() => void authManager.logout()}>
            Sign in as someone else
          </Button>
        </>
      }
    >
      <p className="gl-error-page__message">
        {forbiddenReason(area, serverMessage)}
        {name && role && ` You’re signed in as ${name}, ${withArticle(role)}.`}
      </p>
    </ErrorLayout>
  )
}

function ErrorId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)
  const labelId = useId()

  // Back to "Copy" after a moment, so copying again doesn't look done already.
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(id)
      setCopied(true)
      toast.success("Error ID copied")
    } catch {
      // No clipboard access (insecure origin, denied): the ID is selectable text.
      toast.error("Couldn't copy. Select the error ID and copy it instead.")
    }
  }

  return (
    <div className="gl-error-page__id">
      <span className="gl-error-page__id-label" id={labelId}>
        Error ID
      </span>
      <code className="gl-error-page__id-value" aria-labelledby={labelId}>
        {id}
      </code>
      <Button variant="ghost" size="md" onClick={copy} icon={<CopyIcon size={14} />}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  )
}

type ServerErrorPageProps = {
  status?: number | null
  requestId?: string | null
  // A 4xx's own explanation, in place of "it wasn't anything you did".
  message?: string | null
  onRetry?: () => void
}

export function ServerErrorPage({ status = null, requestId = null, message = null, onRetry }: ServerErrorPageProps) {
  return (
    <ErrorLayout
      code={status ? `Error ${status}` : "Error"}
      title="Something went wrong"
      actions={
        <>
          <Button variant="primary" size="lg" onClick={onRetry ?? (() => window.location.reload())}>
            Try again
          </Button>
          <HomeLink variant="ghost" />
        </>
      }
    >
      <p className="gl-error-page__message">
        {message ? `${message} ` : "GoLive couldn’t load this page. It wasn’t anything you did. "}
        Try again; if it keeps happening, send
        {requestId ? " the error ID below " : " what you were doing "}
        to whoever runs your GoLive.
      </p>
      {requestId && <ErrorId id={requestId} />}
    </ErrorLayout>
  )
}

// The right page for anything a page threw or a request returned: an API 404 or 403
// gets its own page, everything else the generic one (with the request_id when the
// API sent one).
export function ErrorPage({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const info = errorPageFor(error)
  if (info.kind === "not-found") return <NotFoundPage />
  if (info.kind === "forbidden") return <ForbiddenPage serverMessage={info.serverMessage} />
  return <ServerErrorPage status={info.status} requestId={info.requestId} message={info.message} onRetry={onRetry} />
}
