import React, { useEffect, useState } from "react"
import { useGoLive } from "@gl-admin/contexts/GoLiveContext"
import Button from "@gl-admin/components/ui/Button"
import { getPosts } from "@gl-admin/lib/api/posts"
import { getUsers } from "@gl-admin/lib/api/users"
import { getTaxonomyTypes } from "@gl-admin/lib/api/taxonomies"
import { getMedia } from "@gl-admin/lib/api/media"
import type { Post, User, TaxonomyType, Media } from "@gl-admin/lib/types"

const Dashboard: React.FC = () => {
  const { baseTitle } = useGoLive();
  const [totalPosts, setTotalPosts] = useState(0)
  const [totalUsers, setTotalUsers] = useState(0)
  const [totalTaxonomies, setTotalTaxonomies] = useState(0)
  const [totalMedia, setTotalMedia] = useState(0)
  const [recentPosts, setRecentPosts] = useState<Post[]>([])
  const [recentUsers, setRecentUsers] = useState<User[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    document.title = `${baseTitle} Dashboard`;

    const fetchData = async () => {
      try {
        const [postsResponse, usersResponse, taxonomiesResponse, mediaResponse] = await Promise.all([
          getPosts(),
          getUsers(),
          getTaxonomyTypes(),
          getMedia(),
        ])

        setTotalPosts(postsResponse.meta.total || 0)
        setTotalUsers(usersResponse.meta.total || 0)
        setTotalTaxonomies(taxonomiesResponse.meta.total || 0)
        setTotalMedia(mediaResponse.meta.total || 0)

        setRecentPosts(postsResponse.data.slice(0, 5))
        setRecentUsers(usersResponse.data.slice(0, 5))
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to fetch admin data")
        console.error("Admin dashboard error:", e)
      }
    }

    fetchData()
  }, [])

  return (
    <>
      <Button variation="primary" onClick={() => console.log("Clicked!")}>
        Add Item
      </Button>
      <div className="admin-header">
        <h1>🚀 Admin Dashboard</h1>
        <p>Manage your Go Live CMS content and settings</p>
      </div>

      {error && (
        <div className="admin-error">
          <strong>Dashboard Error:</strong> {error}
          <br />
          <small>Make sure your Go backend is running on port 8080</small>
        </div>
      )}

      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-number">{totalPosts}</div>
          <div className="stat-label">Total Posts</div>
          <a href="/posts" className="stat-link">
            Manage Posts
          </a>
        </div>
        <div className="stat-card">
          <div className="stat-number">{totalUsers}</div>
          <div className="stat-label">Total Users</div>
          <a href="/users" className="stat-link">
            Manage Users
          </a>
        </div>
        <div className="stat-card">
          <div className="stat-number">{totalTaxonomies}</div>
          <div className="stat-label">Taxonomies</div>
          <a href="/taxonomies" className="stat-link">
            Manage Tags
          </a>
        </div>
        <div className="stat-card">
          <div className="stat-number">{totalMedia}</div>
          <div className="stat-label">Media Files</div>
          <a href="/media" className="stat-link">
            Media Library
          </a>
        </div>
      </div>

      <div className="admin-sections">
        <div className="admin-section">
          <h2>📝 Recent Posts</h2>
          {recentPosts.length > 0 ? (
            recentPosts.map((post) => (
              <div className="recent-item" key={post.id}>
                <div className="recent-item-info">
                  <h4>{post.title}</h4>
                  <p>By {post.username}</p>
                </div>
                <div className="recent-item-date">{new Date(post.created_at).toLocaleDateString()}</div>
              </div>
            ))
          ) : (
            <p>No recent posts found.</p>
          )}
        </div>

        <div className="admin-section">
          <h2>👥 Recent Users</h2>
          {recentUsers.length > 0 ? (
            recentUsers.map((user) => (
              <div className="recent-item" key={user.id}>
                <div className="recent-item-info">
                  <h4>{user.full_name}</h4>
                  <p>
                    @{user.username} • {user.role}
                  </p>
                </div>
                <div className="recent-item-date">{new Date(user.created_at).toLocaleDateString()}</div>
              </div>
            ))
          ) : (
            <p>No recent users found.</p>
          )}
        </div>

        <div className="admin-section quick-actions">
          <h2>⚡ Quick Actions</h2>
          <div className="action-buttons">
            <a href="/gl-admin/posts/new" className="action-button">
              Create New Post
            </a>
            <a href="/gl-admin/users/new" className="action-button">
              Add User
            </a>
            <a href="/gl-admin/media/upload" className="action-button secondary">
              Upload Media
            </a>
            <a href="/gl-admin/settings" className="action-button secondary">
              Settings
            </a>
          </div>
        </div>
      </div>
    </>
  )
}

export default Dashboard
