// Examples of how to use the new API structure

import { posts, users, media, taxonomyTypes, taxonomyTerms } from "./api"

// Example: Get posts with sorting and pagination
async function getPostsExample() {
  const response = await posts.getAll({
    limit: 20,
    offset: 0,
    sort: "created_at_desc",
    search: "typescript",
    type: "article",
  })

  console.log(`Found ${response.meta.total} posts`)
  response.data.forEach((post) => {
    console.log(`- ${post.title} by ${post.username}`)
  })
}

// Example: Get media with advanced filtering
async function getMediaExample() {
  const response = await media.getAll({
    limit: 10,
    type: "image",
    sort: "size_desc",
    user_id: 1,
  })

  console.log(`Found ${response.data.length} images`)
}

// Example: Search taxonomy terms
async function searchCategoriesExample() {
  const response = await taxonomyTerms.search({
    type: "category",
    q: "technology",
    limit: 5,
  })

  console.log(`Found ${response.data.length} categories matching "technology"`)
}

// Example: Get popular tags
async function getPopularTagsExample() {
  const response = await taxonomyTerms.getPopular({
    type: "tag",
    limit: 10,
  })

  console.log("Popular tags:")
  response.data.forEach((tag) => {
    console.log(`- ${tag.name} (${tag.post_count} posts)`)
  })
}

// Example: Get hierarchical categories
async function getCategoriesExample() {
  const response = await taxonomyTerms.getAll({
    type: "category",
    sort: "name_asc",
    parent_id: null, // Get top-level categories only
  })

  console.log("Top-level categories:")
  response.data.forEach((category) => {
    console.log(`- ${category.name}`)
  })
}

// Example: Get posts by category
async function getPostsByCategoryExample() {
  const categoryResponse = await taxonomyTerms.getBySlug("technology")
  const category = categoryResponse.taxonomy_term

  const postsResponse = await taxonomyTerms.getPosts(category.id, {
    limit: 10,
    sort: "created_at_desc",
  })

  console.log(`Posts in ${category.name}:`)
  postsResponse.data.forEach((post) => {
    console.log(`- ${post.title}`)
  })
}

// Example: Create a new taxonomy term
async function createCategoryExample() {
  try {
    const typesResponse = await taxonomyTypes.getByName("category")
    const categoryType = typesResponse.taxonomy_type

    const newCategory = await taxonomyTerms.create(
      {
        name: "Web Development",
        slug: "web-development",
        description: "All about web development",
        taxonomy_type_id: categoryType.id,
        meta: {
          color: "#3498db",
          icon: "🌐",
        },
      },
      "your-auth-token"
    )

    console.log("Created new category:", newCategory)
  } catch (error) {
    console.error("Failed to create category:", error)
  }
}

export {
  getPostsExample,
  getMediaExample,
  searchCategoriesExample,
  getPopularTagsExample,
  getCategoriesExample,
  getPostsByCategoryExample,
  createCategoryExample,
}
/* 
import {
  getPostsExample,
  getMediaExample,
  searchCategoriesExample,
  getPopularTagsExample,
  getCategoriesExample,
  getPostsByCategoryExample,
  createCategoryExample,
} from "@gl-admin/lib/api-examples"

getPostsExample()
getMediaExample()
searchCategoriesExample()
getPopularTagsExample()
getCategoriesExample()
getPostsByCategoryExample()
createCategoryExample()
*/
