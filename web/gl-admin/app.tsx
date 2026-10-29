import { StrictMode, Suspense, lazy, useEffect, type ReactNode } from "react"
import { BrowserRouter, Routes, Route, useLocation, useParams } from "react-router-dom"
import { GoLiveProvider } from "./contexts/GoLiveContext"
import { ThemeProvider } from "./contexts/ThemeContext"
import AuthGuard from "@gl-admin/components/AuthGuard"
import ErrorBoundary from "@gl-admin/components/ErrorBoundary"
import RequireRole from "@gl-admin/components/RequireRole"
import { isSiteAdmin } from "@gl-admin/lib/roles"
import Sidebar from "@gl-admin/components/sidebar/Sidebar"
import { Toaster } from "@gl-admin/components/ui/Toast"
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
const MediaDetail = lazy(() => import("@gl-admin/pages/MediaDetail"))
const Taxonomies = lazy(() => import("@gl-admin/pages/Taxonomies"))
const Users = lazy(() => import("@gl-admin/pages/Users"))
const Settings = lazy(() => import("@gl-admin/pages/Settings"))
const Themes = lazy(() => import("@gl-admin/pages/Themes"))
const Profile = lazy(() => import("@gl-admin/pages/Profile"))
const PostTypes = lazy(() => import("@gl-admin/pages/PostTypes"))
// Dev-only component gallery (#338): every UI component in light and dark. Vite drops
// the import from production builds, where import.meta.env.DEV is false.
const UiGallery = import.meta.env.DEV ? lazy(() => import("@gl-admin/pages/dev/UiGallery")) : null

// Minimal navigation shown if the sidebar itself fails to render.
function SidebarFallback() {
  return (
    <nav className="gl-sidebar-fallback" aria-label="Admin">
      <p>The menu couldn't be loaded.</p>
      <a href="/gl-admin/">Dashboard</a>
      <button type="button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </nav>
  )
}

function AdminOnly({ area, children }: { area: string; children: ReactNode }) {
  return (
    <RequireRole allow={isSiteAdmin} area={area}>
      {children}
    </RequireRole>
  )
}

function AppLayout() {
  const routeClasses = useRouteClasses()
  const { pathname } = useLocation()

  return (
    <main id="admin">
      {/* Its own boundary, so a sidebar crash doesn't take the pages down with it. */}
      <ErrorBoundary resetKey={pathname} fallback={<SidebarFallback />}>
        <Sidebar />
      </ErrorBoundary>
      <section className={routeClasses}>
        <div id="admin-content">
          {/* Resets on navigation, so leaving a crashed page recovers. */}
          <ErrorBoundary resetKey={pathname}>
            <Suspense fallback={null}>
              <Routes>
                {/* Rendered in place (no redirect) so the broken URL stays visible. */}
                <Route path="*" element={<NotFound />} />
                <Route path="/" element={<Dashboard />} />
                <Route path="/404" element={<NotFound />} />
                <Route path="/content" element={<ContentComponent key="all" />} />
                <Route path="/content/:typeName" element={<ContentByType />} />
                <Route path="/content/:typeName/new" element={<NewContent />} />
                <Route path="/content/edit/:id" element={<EditContent />} />
                <Route path="/media" element={<Media />} />
                <Route path="/media/:id" element={<MediaDetail />} />
                <Route path="/taxonomies" element={<Taxonomies />} />
                {/* Admin-only pages (requireSiteAdmin in the API): others get the 403. */}
                <Route path="/themes" element={<AdminOnly area="Themes"><Themes /></AdminOnly>} />
                <Route path="/users" element={<AdminOnly area="Users"><Users /></AdminOnly>} />
                <Route path="/users/new" element={<AdminOnly area="Users"><NewUser /></AdminOnly>} />
                <Route path="/users/edit/:id" element={<AdminOnly area="Users"><EditUser /></AdminOnly>} />
                <Route path="/profile" element={<Profile />} />
                <Route path="/settings" element={<AdminOnly area="Settings"><Settings /></AdminOnly>} />
                <Route path="/post-types" element={<AdminOnly area="Post types"><PostTypes /></AdminOnly>} />
                {UiGallery && <Route path="/dev/ui" element={<UiGallery />} />}
              </Routes>
            </Suspense>
          </ErrorBoundary>
        </div>
      </section>
      <Toaster />
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
