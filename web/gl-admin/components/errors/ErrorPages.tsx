import { useEffect, useState, type ReactNode } from "react"
import { Link, useLocation } from "react-router-dom"
import Button, { buttonClassName } from "@gl-admin/components/ui/Button"
import { toast } from "@gl-admin/components/ui/Toast"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import { authManager } from "@gl-admin/lib/auth"
import { useAuthUser } from "@gl-admin/lib/hooks/useAuthUser"
import { USER_ROLE_OPTIONS } from "@gl-admin/lib/roles"
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

  useEffect(() => {
    document.title = `${baseTitle} ${title}`
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
  const roleLabel = USER_ROLE_OPTIONS.find((r) => r.value === user?.role?.toLowerCase())?.label.toLowerCase()

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
        {user?.full_name && roleLabel && ` You’re signed in as ${user.full_name}, ${withArticle(roleLabel)}.`}
      </p>
    </ErrorLayout>
  )
}

function ErrorId({ id }: { id: string }) {
  const [copied, setCopied] = useState(false)

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
      <span className="gl-error-page__id-label" id="gl-error-id-label">
        Error ID
      </span>
      <code className="gl-error-page__id-value" aria-labelledby="gl-error-id-label">
        {id}
      </code>
      <Button variant="ghost" size="md" onClick={copy} icon={<CopyIcon />}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  )
}

const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <rect x="9" y="9" width="12" height="12" rx="2" />
    <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
  </svg>
)

type ServerErrorPageProps = {
  status?: number | null
  requestId?: string | null
  onRetry?: () => void
}

export function ServerErrorPage({ status = null, requestId = null, onRetry }: ServerErrorPageProps) {
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
        GoLive couldn’t load this page. It wasn’t anything you did. Try again; if it keeps happening, send
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
  return <ServerErrorPage status={info.status} requestId={info.requestId} onRetry={onRetry} />
}
