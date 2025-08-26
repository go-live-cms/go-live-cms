import {
  getMedia,
  getPosts,
  getUsers,
  getSessions,
  getTaxonomyTypes,
  getPostTypes,
  buildUrl,
  buildQueryString,
  type MediaQueryParams,
  type PostQueryParams,
  type MediaSortOption,
  type PostSortOption,
} from "./index"

// Example: Get media with strict typing
async function fetchMediaExample() {
  // All query parameters are strictly typed
  const mediaParams: MediaQueryParams = {
    limit: 20,
    offset: 0,
    sort: "date_desc", // TypeScript will only allow valid sort options
    search: "profile",
    type: "image",
    user_id: 1,
    with_counts: true,
  }

  try {
    const mediaResponse = await getMedia(mediaParams)
    console.log("Media:", mediaResponse.data)
    console.log("Total media items:", mediaResponse.meta.total)
  } catch (error) {
    console.error("Failed to fetch media:", error)
  }
}

// Example: Get posts with different sort options
async function fetchPostsExample() {
  const postsParams: PostQueryParams = {
    limit: 10,
    sort: "title_asc", // Strictly typed - only valid post sort options allowed
    type: "blog-post",
    status: "published",
    with_meta: true,
  }

  const postsResponse = await getPosts(postsParams)
  console.log("Posts:", postsResponse.data)
}

// Example: Demonstrate utility functions
async function demonstrateUtilities() {
  // Use buildQueryString utility
  const queryString = buildQueryString({
    limit: 10,
    sort: "date_desc",
    search: "", // This will be filtered out
    type: undefined, // This will be filtered out
  })
  console.log("Query string:", queryString) // "limit=10&sort=date_desc"

  // Use buildUrl utility
  const url = buildUrl("/posts", { limit: 5, sort: "title_asc" })
  console.log("Complete URL:", url) // "/posts?limit=5&sort=title_asc"
}

// Example: Demonstrate type safety
async function demonstrateTypeSafety() {
  // This would cause a TypeScript error:
  // const invalidSort: MediaSortOption = 'invalid_sort'; // ❌ Type error

  // This is valid:
  const validSort: MediaSortOption = "name_asc" // ✅ Valid

  // TypeScript autocomplete will show only valid options:
  const mediaParams: MediaQueryParams = {
    sort: validSort, // Autocomplete shows: date_asc, date_desc, name_asc, etc.
  }

  await getMedia(mediaParams)
}

// Example: Get all post types (no parameters needed)
async function fetchPostTypesExample() {
  const postTypesResponse = await getPostTypes()
  console.log("Available post types:", postTypesResponse.data)
}

// Example: Get users with sorting
async function fetchUsersExample() {
  const usersResponse = await getUsers({
    limit: 50,
    sort: "username_asc",
    search: "admin",
  })

  console.log("Users:", usersResponse.data)
}

// Example: Error handling is the same across all methods
async function handleApiErrors() {
  try {
    await getMedia({ limit: -1 }) // This might cause a server error
  } catch (error) {
    if (error instanceof Error) {
      console.error("API Error:", error.message)
    }
  }
}

export {
  fetchMediaExample,
  fetchPostsExample,
  demonstrateUtilities,
  demonstrateTypeSafety,
  fetchPostTypesExample,
  fetchUsersExample,
  handleApiErrors,
}
