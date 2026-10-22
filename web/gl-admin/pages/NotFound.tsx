import React, { useEffect } from "react"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import { useLocation, useNavigate } from "react-router-dom"
import Button from "@gl-admin/components/ui/Button"
import "@gl-admin/assets/styles/pages/not-found.scss"

const NotFound: React.FC = () => {
  const { baseTitle } = useGoLive()
  const navigate = useNavigate()
  const { pathname } = useLocation()

  useEffect(() => {
    document.title = `${baseTitle} Page not found`
  }, [baseTitle])

  return (
    <div className="not-found">
      <p className="not-found__status">404</p>
      <h1 className="not-found__title">Page not found</h1>
      <p className="not-found__message">
        There's nothing at <code className="not-found__path">/gl-admin{pathname === "/404" ? "" : pathname}</code>. The
        link may be broken, or the page may have been moved.
      </p>
      <div className="not-found__actions">
        <Button variation="primary" onClick={() => navigate("/")}>
          Go to Dashboard
        </Button>
        {/* React Router's history index: 0 means this page was opened directly. */}
        {(window.history.state?.idx ?? 0) > 0 && (
          <Button variation="flat" onClick={() => navigate(-1)}>
            Go back
          </Button>
        )}
      </div>
    </div>
  )
}

export default NotFound
