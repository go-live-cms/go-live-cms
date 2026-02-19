import { StrictMode, lazy, useEffect } from "react"
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom"
import { GoLiveProvider } from "./contexts/GoLiveContext"
import { ThemeProvider } from "./contexts/ThemeContext"
import AuthGuard from "@gl-admin/components/AuthGuard"
import Sidebar from "@gl-admin/components/sidebar/Sidebar"
import "@gl-admin/assets/styles/global.scss"
import NewPost from "./pages/NewPost"
import NewPage from "./pages/NewPage"
import EditContent from "./pages/EditPost"
import { useRouteClasses } from "./utils/useRouteClasses"

const NotFound = lazy(() => import("@gl-admin/pages/NotFound"))
const Dashboard = lazy(() => import("@gl-admin/pages/Dashboard"))
const Content = lazy(() => import("@gl-admin/pages/Content"))
const Media = lazy(() => import("@gl-admin/pages/Media"))
const BackfillBlocks = lazy(() => import("@gl-admin/pages/BackfillBlocks"))
const Settings = lazy(() => import("@gl-admin/pages/Settings"))
const Themes = lazy(() => import("@gl-admin/pages/Themes"))

function AppLayout() {
  const routeClasses = useRouteClasses()

  return (
    <main id="admin">
      <Sidebar />
      <section className={routeClasses}>
        <div id="admin-content">
          <Routes>
            <Route path="*" element={<Navigate to="/404" replace />} />
            <Route path="/" element={<Dashboard />} />
            <Route path="/404" element={<NotFound />} />
            <Route path="/content" element={<Content key="content" />} />
            <Route
              path="/content/pages"
              element={<Content key="content-pages" query={{ type: "page" }} title="Pages" />}
            />
            <Route
              path="/content/posts"
              element={<Content key="content-posts" query={{ type: "post" }} title="Posts" />}
            />
            <Route path="/content/posts/new" element={<NewPost />} />
            <Route path="/content/pages/new" element={<NewPage />} />
            <Route path="/content/edit/:id" element={<EditContent />} />
            <Route path="/media" element={<Media />} />
            <Route path="/themes" element={<Themes />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/tools/backfill-blocks" element={<BackfillBlocks />} />
          </Routes>
        </div>
      </section>
    </main>
  )
}

export default function App() {
  useEffect(() => {
    const root = document.documentElement
    const current = root.getAttribute("data-theme")
    root.setAttribute("data-theme", current === "dark" ? "light" : "dark")
  }, [])

  return (
    <AuthGuard>
      <StrictMode>
        <BrowserRouter basename="/gl-admin">
          <ThemeProvider>
            <GoLiveProvider>
              <AppLayout />
            </GoLiveProvider>
          </ThemeProvider>
        </BrowserRouter>
      </StrictMode>
    </AuthGuard>
  )
}
