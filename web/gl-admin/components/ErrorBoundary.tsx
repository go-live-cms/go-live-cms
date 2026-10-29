import { Component, type ErrorInfo, type ReactNode } from "react"
import { ErrorPage } from "@gl-admin/components/errors/ErrorPages"
import { isChunkLoadError } from "@gl-admin/lib/errorPages"

type ErrorBoundaryProps = {
  children: ReactNode
  // Changing this clears the error, so navigating to another page recovers.
  resetKey?: string
  // Replaces the default full-page fallback (e.g. a compact one for the sidebar).
  fallback?: ReactNode
}

type ErrorBoundaryState = {
  error: unknown
}

// Catches render errors in admin pages so one broken page shows a friendly
// fallback instead of unmounting the whole admin (sidebar included). An ApiError a
// page throws gets its page (#339): 404, 403, or the generic one with the error ID.
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error ?? new Error("Unknown error") }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Admin page crashed:", error, info.componentStack)
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  // A lazily loaded page whose chunk failed to download (e.g. after a deploy)
  // stays failed until the page is reloaded, so Try again reloads for those.
  retry = () => {
    if (isChunkLoadError(this.state.error)) window.location.reload()
    else this.setState({ error: null })
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback !== undefined) return this.props.fallback

    const detail = import.meta.env.DEV && error instanceof Error ? error.stack || error.message : null

    return (
      <div className="gl-error-boundary">
        <ErrorPage error={error} onRetry={this.retry} />
        {detail && <pre className="gl-error-boundary__detail">{detail}</pre>}
      </div>
    )
  }
}
