import { apiCall, authenticatedFetch } from "../api"

export interface PostMeta {
  id?: number
  post_id: number
  meta_key: string
  meta_value: string
}

export interface CreatePostMetaRequest {
  meta_key: string
  meta_value: string
}

export interface UpdatePostMetaRequest {
  meta_value: string
}

export async function getPostMeta(postId: number): Promise<{ meta: PostMeta[] }> {
  return apiCall(`/posts/${postId}/meta`)
}

// Get specific meta value by key
export async function getPostMetaByKey(postId: number, metaKey: string): Promise<PostMeta | null> {
  try {
    const response = await getPostMeta(postId)
    const meta = response.meta.find(m => m.meta_key === metaKey)
    return meta || null
  } catch (error) {
    console.error(`Error getting post meta for key ${metaKey}:`, error)
    return null
  }
}

// Create or update post meta
export async function setPostMeta(
  postId: number, 
  metaKey: string, 
  metaValue: string
): Promise<{ meta: PostMeta }> {
  const response = await authenticatedFetch(`/api/v1/posts/${postId}/meta`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      meta_key: metaKey,
      meta_value: metaValue,
    }),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || "Failed to set post meta")
  }

  return response.json()
}

export async function deletePostMeta(postId: number, metaKey: string): Promise<void> {
  const response = await authenticatedFetch(`/api/v1/posts/${postId}/meta/${metaKey}`, {
    method: "DELETE",
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || "Failed to delete post meta")
  }
}

// Featured Image specific helpers
export async function getFeaturedImage(postId: number): Promise<number | null> {
  try {
    const meta = await getPostMetaByKey(postId, '_thumbnail_id')
    return meta ? parseInt(meta.meta_value) : null
  } catch (error) {
    console.error('Error getting featured image:', error)
    return null
  }
}

export async function setFeaturedImage(postId: number, mediaId: number, mediaPath?: string): Promise<void> {
  const requestBody: any = {
    media_id: mediaId
  }
  
  if (mediaPath) {
    requestBody.media_path = mediaPath
  }

  const response = await authenticatedFetch(`/api/v1/posts/${postId}/featured-image`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(requestBody),
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || "Failed to set featured image")
  }
}

export async function removeFeaturedImage(postId: number): Promise<void> {
  const response = await authenticatedFetch(`/api/v1/posts/${postId}/featured-image`, {
    method: "DELETE",
  })

  if (!response.ok) {
    const error = await response.json()
    throw new Error(error.error || "Failed to remove featured image")
  }
}

export async function getFeaturedImageQuick(postId: number): Promise<{ url: string } | null> {
  try {
    const response = await apiCall(`/posts/${postId}/featured-image`)
    return response.featured_image || null
  } catch (error) {
    console.error('Error getting featured image URL:', error)
    return null
  }
}

export async function getFeaturedImageFull(postId: number): Promise<any> {
  try {
    const response = await apiCall(`/posts/${postId}/featured-image/full`)
    return response.featured_image || null
  } catch (error) {
    console.error('Error getting featured image details:', error)
    return null
  }
}
