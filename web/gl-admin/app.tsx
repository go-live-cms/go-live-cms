import { StrictMode, lazy, useEffect } from "react"
import { BrowserRouter, Routes, Route, Navigate, useParams } from "react-router-dom"
import { GoLiveProvider } from "./contexts/GoLiveContext"
import { ThemeProvider } from "./contexts/ThemeContext"
import AuthGuard from "@gl-admin/components/AuthGuard"
import Sidebar from "@gl-admin/components/sidebar/Sidebar"
import "@gl-admin/assets/styles/global.scss"
import NewContent from "./pages/NewContent"
import NewPost from "./pages/NewPost"
import NewPage from "./pages/NewPage"
import NewUser from "./pages/NewUser"
import EditUser from "./pages/EditUser"
import EditContent from "./pages/EditPost"
import { useRouteClasses } from "./utils/useRouteClasses"

// Wrapper so the Content list remounts when the post type changes.
// Route-level keys must come from params, which are only available inside <Routes>,
// so we need this thin component rather than an inline key prop on the route.
//
// Fallback to "all" if typeName is somehow undefined — defensive against future
// refactors where the param could become optional. React treats `key={undefined}`
// the same as no key, which would silently disable the remount/refetch behavior
// this wrapper exists to provide.
function ContentByType() {
  const { typeName } = useParams<{ typeName?: string }>()
  return <ContentComponent key={typeName || "all"} />
}

const NotFound = lazy(() => import("@gl-admin/pages/NotFound"))
const Dashboard = lazy(() => import("@gl-admin/pages/Dashboard"))
const ContentComponent = lazy(() => import("@gl-admin/pages/Content"))
const Media = lazy(() => import("@gl-admin/pages/Media"))
const Users = lazy(() => import("@gl-admin/pages/Users"))
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
            <Route path="/content" element={<ContentComponent key="all" />} />
            <Route path="/content/:typeName" element={<ContentByType />} />
            <Route path="/content/:typeName/new" element={<NewContent />} />
            <Route path="/content/edit/:id" element={<EditContent />} />
            <Route path="/media" element={<Media />} />
            <Route path="/themes" element={<Themes />} />
            <Route path="/users" element={<Users />} />
            <Route path="/users/new" element={<NewUser />} />
            <Route path="/users/edit/:id" element={<EditUser />} />
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
