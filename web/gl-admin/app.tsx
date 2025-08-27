import { StrictMode, lazy } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import AuthGuard from '@gl-admin/components/AuthGuard';
import Sidebar from '@gl-admin/components/sidebar/Sidebar';
import "@gl-admin/assets/styles/global.scss";

const NotFound = lazy(() => import("@gl-admin/pages/NotFound"));
const Dashboard = lazy(() => import("@gl-admin/pages/Dashboard"));
const Content = lazy(() => import("@gl-admin/pages/Content"));
const Media = lazy(() => import("@gl-admin/pages/Media"));

export default function App() {
    return (
        <AuthGuard>
            <StrictMode>
                <BrowserRouter basename="/gl-admin">
                    <main id="admin">
                        <Sidebar />
                        <section className="admin-main">
                            <div id="admin-content">
                                <Routes>
                                    <Route path="*" element={<Navigate to="/404" replace />} />
                                    <Route path="/" element={<Dashboard />} />
                                    <Route path="/404" element={<NotFound />} />
                                    <Route path="/content" element={<Content key="content" />} />
                                    <Route path="/content/pages" element={<Content key="content-pages" query={{ type: "page" }} title="Pages" />} />
                                    <Route path="/content/posts" element={<Content key="content-posts" query={{ type: "post" }} title="Posts" />} />
                                    <Route path="/media" element={<Media />} />
                                </Routes>
                            </div>
                        </section>
                    </main>
                </BrowserRouter>
            </StrictMode>
        </AuthGuard>
    );
}