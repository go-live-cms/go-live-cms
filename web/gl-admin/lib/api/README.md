# API Client Documentation

This is the modular, strictly-typed API client for the Go Live CMS frontend. All API methods are organized by resource type with full TypeScript support.

## Structure

The API client is organized into separate modules by resource:

- `types.ts` - All TypeScript interfaces and type definitions
- `media.ts` - Media-related API methods
- `posts.ts` - Post-related API methods
- `users.ts` - User-related API methods
- `sessions.ts` - Session management API methods
- `taxonomies.ts` - Taxonomy and taxonomy term API methods
- `postTypes.ts` - Post type API methods
- `index.ts` - Re-exports all modules for easy importing

## Features

- **Strict TypeScript typing** - All parameters and responses are strictly typed
- **Sort options as enums** - Only valid sort options are allowed for each resource
- **Query parameter interfaces** - All query parameters are defined with proper types
- **Modular organization** - Each resource has its own file for better maintainability
- **Backward compatibility** - Legacy API object is still available

## Usage

### Basic Import

```typescript
import { getMedia, getPosts, getUsers } from "./lib/api"
```

### Import with Types

```typescript
import { getMedia, type MediaQueryParams, type MediaSortOption } from "./lib/api"
```

### Sort Options

Each resource has strictly typed sort options that match the Go backend:

```typescript
// Media sort options
type MediaSortOption =
  | "date_asc"
  | "date_desc"
  | "name_asc"
  | "name_desc"
  | "size_asc"
  | "size_desc"
  | "type_asc"
  | "type_desc"
  | "posts_asc"
  | "posts_desc"

// Post sort options
type PostSortOption =
  | "date_asc"
  | "date_desc"
  | "title_asc"
  | "title_desc"
  | "menu_order_asc"
  | "menu_order_desc"
  | "id_asc"
  | "id_desc"

// User sort options
type UserSortOption =
  | "date_asc"
  | "date_desc"
  | "username_asc"
  | "username_desc"
  | "email_asc"
  | "email_desc"
  | "role_asc"
  | "role_desc"
  | "id_asc"
  | "id_desc"

// Taxonomy sort options
type TaxonomySortOption = "name_asc" | "name_desc" | "id_asc" | "id_desc" | "order_asc" | "order_desc"
```

## Examples

### Media API

```typescript
import { getMedia, type MediaQueryParams } from "./lib/api"

const params: MediaQueryParams = {
  limit: 20,
  offset: 0,
  sort: "date_desc",
  search: "profile",
  type: "image",
  user_id: 1,
  with_counts: true,
}

const response = await getMedia(params)
console.log(response.data) // Media[]
console.log(response.meta) // Pagination info
```

### Posts API

```typescript
import { getPosts, type PostQueryParams } from "./lib/api"

const params: PostQueryParams = {
  limit: 10,
  sort: "title_asc",
  type: "blog-post",
  status: "published",
  with_meta: true,
}

const response = await getPosts(params)
```

### Users API

```typescript
import { getUsers, getUserById, createUser } from "./lib/api"

// Get all users with pagination
const users = await getUsers({
  limit: 50,
  sort: "username_asc",
})

// Get specific user
const user = await getUserById(123)

// Create new user (requires authentication token)
const newUser = await createUser(
  {
    username: "johndoe",
    email: "john@example.com",
    full_name: "John Doe",
    role: "user",
  },
  "auth-token"
)
```

### Taxonomies API

```typescript
import { getTaxonomyTypes, getTaxonomyTerms, type TaxonomyTermQueryParams } from "./lib/api"

// Get all taxonomy types
const types = await getTaxonomyTypes()

// Get taxonomy terms with filtering
const termsParams: TaxonomyTermQueryParams = {
  limit: 25,
  sort: "name_asc",
  type: "category",
  q: "tech", // search query
}

const terms = await getTaxonomyTerms(termsParams)
```

## Query Parameters

All list methods accept query parameters with the following common options:

- `limit?: number` - Number of items to return (default: 10)
- `offset?: number` - Number of items to skip (default: 0)
- `sort?: SortOption` - Sort order (strictly typed per resource)

Additional parameters vary by resource:

### Media

- `search?: string` - Search in media names/descriptions
- `type?: string` - Filter by file type (image, video, etc.)
- `user_id?: number` - Filter by uploader
- `with_counts?: boolean` - Include post counts

### Posts

- `type?: string` - Filter by post type name
- `status?: string` - Filter by post status
- `with_meta?: boolean` - Include post metadata

### Users

- `search?: string` - Search in usernames/emails

### Taxonomy Terms

- `type?: string` - Filter by taxonomy type name
- `q?: string` - Search query
- `status?: string` - Filter by status

## Response Format

All list methods return a consistent response format:

```typescript
interface ApiResponse<T> {
  data: T[]
  meta: {
    count: number // Items in current response
    limit: number // Requested limit
    offset: number // Requested offset
    total: number // Total items available
  }
}
```

## Authentication

Methods that require authentication accept a `token` parameter:

```typescript
// Create, update, delete operations require authentication
await createPost(postData, "auth-token")
await updateUser(userId, userData, "auth-token")
await deleteMedia(mediaId, "auth-token")
```

## Error Handling

All methods throw errors that can be caught with try/catch:

```typescript
try {
  const media = await getMedia({ limit: 20 })
} catch (error) {
  console.error("API Error:", error.message)
}
```

## Backward Compatibility

The legacy API object is still available for existing code:

```typescript
import { legacyApi } from "./lib/api"

// Old way still works
const response = await legacyApi.media.getAll()
```

## Migration Guide

To migrate from the old API structure:

### Old way:

```typescript
import api from "./lib/api"
const media = await api.media.getAll()
```

### New way:

```typescript
import { getMedia } from "./lib/api"
const response = await getMedia()
const media = response.data
```

The new way provides better TypeScript support, autocomplete, and type safety.
