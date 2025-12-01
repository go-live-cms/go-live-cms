import { useState } from "react"
import { authManager } from "@gl-admin/lib/auth"
import { htmlToBlockDoc } from "@gl-admin/lib/utils/htmlToBlocks"
import { blockAPIClient } from "@gl-admin/lib/api/blockAPI"

export default function BackfillTool() {
  const [postId, setPostId] = useState("")
  const [status, setStatus] = useState("")
  const [loading, setLoading] = useState(false)

  const backfillPost = async () => {
    if (!postId) return

    setLoading(true)
    setStatus("Fetching post...")

    try {
      const token = authManager.getAccessToken()
      if (!token) {
        throw new Error("Not authenticated")
      }

      // Fetch current post
      const postRes = await fetch(`/api/v1/posts/${postId}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!postRes.ok) {
        const error = await postRes.text()
        throw new Error(`Post not found: ${error}`)
      }

      const postData = await postRes.json()
      const post = postData.post || postData

      setStatus("Converting HTML to blocks...")

      // Convert HTML to blocks
      const blockDoc = htmlToBlockDoc(post.content || "")

      setStatus(`Converting HTML to blocks... (${blockDoc.blocks_order.length} blocks created)`)

      // Set auth token for block API
      blockAPIClient.setAuthToken(token)

      setStatus("Getting current revision...")

      // Get current revision first
      let currentRevision = 1
      try {
        const current = await blockAPIClient.getPostBlocks(parseInt(postId))
        currentRevision = current.revision
      } catch (error) {
        // If post has no blocks yet, start at revision 0
        currentRevision = 0
      }

      setStatus("Saving blocks...")

      // Save blocks with correct revision
      await blockAPIClient.updatePostBlocks(parseInt(postId), blockDoc, currentRevision)

      setStatus("Publishing...")

      // Publish immediately
      await blockAPIClient.publishPost(parseInt(postId), undefined, "Backfilled from legacy HTML")

      setStatus(`✅ Successfully backfilled post ${postId} (${blockDoc.blocks_order.length} blocks)`)
    } catch (error) {
      setStatus(`❌ Error: ${(error as Error).message}`)
      console.error("Backfill error:", error)
    } finally {
      setLoading(false)
    }
  }

  const backfillAllPosts = async () => {
    setLoading(true)
    setStatus("Fetching all posts...")

    try {
      const token = authManager.getAccessToken()
      if (!token) {
        throw new Error("Not authenticated")
      }

      // Fetch all posts
      const postsRes = await fetch("/api/v1/posts?limit=100", {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!postsRes.ok) {
        throw new Error("Failed to fetch posts")
      }

      const postsData = await postsRes.json()
      const posts = postsData.posts || []

      setStatus(`Found ${posts.length} posts. Starting backfill...`)

      let successCount = 0
      let errorCount = 0

      for (let i = 0; i < posts.length; i++) {
        const post = posts[i]
        setStatus(`Processing ${i + 1}/${posts.length}: Post #${post.id}...`)

        try {
          const blockDoc = htmlToBlockDoc(post.content || "")
          blockAPIClient.setAuthToken(token)

          // Get current revision first
          let currentRevision = 1
          try {
            const current = await blockAPIClient.getPostBlocks(post.id)
            currentRevision = current.revision
          } catch (error) {
            // If post has no blocks yet, start at revision 0
            currentRevision = 0
          }

          await blockAPIClient.updatePostBlocks(post.id, blockDoc, currentRevision)
          await blockAPIClient.publishPost(post.id, undefined, "Backfilled from legacy HTML")
          successCount++
        } catch (error) {
          console.error(`Failed to backfill post ${post.id}:`, error)
          errorCount++
        }
      }

      setStatus(`✅ Backfill complete! Success: ${successCount}, Errors: ${errorCount}`)
    } catch (error) {
      setStatus(`❌ Error: ${(error as Error).message}`)
      console.error("Batch backfill error:", error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div style={{ padding: "2rem", maxWidth: "800px", margin: "0 auto" }}>
      <h1>Backfill Legacy Posts to Block Spec</h1>
      <p style={{ color: "#666", marginBottom: "2rem" }}>
        Convert legacy HTML content to Block Spec v1 format and publish immediately.
      </p>

      <div style={{ marginBottom: "2rem", padding: "1.5rem", background: "#f9f9f9", borderRadius: "8px" }}>
        <h2 style={{ marginTop: 0, fontSize: "1.2rem" }}>Single Post</h2>
        <div style={{ display: "flex", gap: "1rem", alignItems: "center" }}>
          <input
            type="number"
            value={postId}
            onChange={(e) => setPostId(e.target.value)}
            placeholder="Post ID"
            style={{
              padding: "0.75rem",
              fontSize: "1rem",
              border: "1px solid #ddd",
              borderRadius: "4px",
              flex: 1,
            }}
          />

          <button
            onClick={backfillPost}
            disabled={loading || !postId}
            style={{
              padding: "0.75rem 1.5rem",
              fontSize: "1rem",
              background: loading || !postId ? "#ccc" : "#0066cc",
              color: "white",
              border: "none",
              borderRadius: "4px",
              cursor: loading || !postId ? "not-allowed" : "pointer",
            }}
          >
            {loading ? "Processing..." : "Backfill Post"}
          </button>
        </div>
      </div>

      <div style={{ marginBottom: "2rem", padding: "1.5rem", background: "#fff3cd", borderRadius: "8px" }}>
        <h2 style={{ marginTop: 0, fontSize: "1.2rem" }}>⚠️ Batch Backfill (All Posts)</h2>
        <p style={{ fontSize: "0.9rem", color: "#856404", marginBottom: "1rem" }}>
          This will process ALL posts in the system. Use with caution!
        </p>
        <button
          onClick={backfillAllPosts}
          disabled={loading}
          style={{
            padding: "0.75rem 1.5rem",
            fontSize: "1rem",
            background: loading ? "#ccc" : "#ff6b6b",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Processing..." : "Backfill All Posts"}
        </button>
      </div>

      {status && (
        <div
          style={{
            padding: "1rem",
            background: status.startsWith("✅") ? "#d4edda" : status.startsWith("❌") ? "#f8d7da" : "#f5f5f5",
            border: `1px solid ${status.startsWith("✅") ? "#c3e6cb" : status.startsWith("❌") ? "#f5c6cb" : "#ddd"}`,
            borderRadius: "4px",
            marginTop: "1rem",
            whiteSpace: "pre-wrap",
            fontFamily: "monospace",
            fontSize: "0.9rem",
          }}
        >
          {status}
        </div>
      )}
    </div>
  )
}
