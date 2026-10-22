// Package devModeUtil provides development-only utilities to seed a demo site with
// users, taxonomies, posts, pages, and media content.
//
// # WARNING: NOT FOR PRODUCTION USE
//
// This package is designed exclusively for development environments and creates
// demo content with known weak credentials and sample data. Never enable these
// utilities in production builds.
//
// # Core Functions
//
// The package provides two primary entry points:
//   - CreateDefaultAdminUser: Creates a default admin user with known credentials
//   - CreateDummyData: Seeds the database with comprehensive demo content
//
// # Prerequisites
//
// Both functions require:
//   - A working db.Store connection to the database
//   - A configured util.Config (especially UploadPath for media storage)
//   - Database migrations completed and tables available
//
// # Entry points
//
// They run on API startup in debug mode (api.NewServer) and from the seed
// command (go run ./cmd/seed, make seed), which runs them against the
// configured database explicitly.
//
// # Idempotency and Safety
//
// Functions use simple guards to prevent duplicate data:
//   - CreateDefaultAdminUser: Checks if the admin username exists
//   - CreateDummyData: Skips if CountTotalUsers > 1
//   - RestoreSampleMediaFiles (cmd/seed only): writes back missing sample
//     files that a media row still references
//
// Re-running these functions is generally safe but may result in mixed content
// states. For clean results, use a fresh database.
//
// # Side Effects
//
// These utilities perform several side effects:
//   - Database writes (users, posts, taxonomies, media records)
//   - File system writes to the configured UploadPath directory
//   - Creates directory structure with 0755 permissions
//
// # Performance Characteristics
//
// All operations run synchronously with the following considerations:
//   - Not designed for concurrent invocation
//   - Best-effort error handling (logs errors and continues)
//   - Operations are not transactional across entities
//
// # Determinism
//
// Most creators use gofakeit.Seed(0) for reproducible results. The sample
// images are files embedded in the binary (sampleimages/, see its README for
// source and license), so seeding needs no network access.
//
// # Example Usage
//
//	store := db.NewStore(dbConn)
//	config, err := util.LoadConfig(".")
//	if err != nil {
//		log.Fatal("cannot load config:", err)
//	}
//
//	devModeUtil.CreateDefaultAdminUser(store, devModeUtil.AdminAccount(config))
//	devModeUtil.CreateDummyData(store, config)
//
// # Configuration Notes
//
// Consider these configuration aspects:
//   - Number of users/posts/pages is currently hardcoded
//   - Upload path must be writable by the process running the seed
//   - Media URLs assume the standard /uploads public mapping
package devModeUtil

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/brianvoe/gofakeit/v6"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
)

// generateSlug creates simple URL-friendly slugs from names by converting to lowercase
// and replacing spaces with hyphens. This is a basic ASCII-only implementation that
// does not handle Unicode transliteration or special characters.
//
// For production use with international content, consider a more robust slugification
// library that handles accented characters, special symbols, and character limits.
//
// Example:
//
//	generateSlug("My Great Post") // returns "my-great-post"
func generateSlug(name string) string {
	return strings.ToLower(strings.ReplaceAll(name, " ", "-"))
}

// CreateDummyData orchestrates the creation of comprehensive demo content including
// users, taxonomies, media files, posts, and pages. This function creates a realistic
// content structure suitable for theme development and CMS demonstrations.
//
// # Order of Operations
//
// The function follows a specific sequence where later steps depend on earlier ones:
//  1. Users (required for content ownership)
//  2. Taxonomies (categories, tags, page categories)
//  3. Media (downloads and stores sample images)
//  4. Posts (blog content with taxonomy assignments)
//  5. Pages (static pages with hierarchy)
//  6. Media-Post linking (associates images with content)
//
// # Idempotency Guard
//
// Skips execution if CountTotalUsers > 1, assuming demo data already exists.
// This simple guard prevents duplicate content but doesn't handle partial failures.
// For clean results after partial runs, use a fresh database. Restoring the
// files of media rows seeded earlier is cmd/seed's job (RestoreSampleMediaFiles),
// not this function's, so a debug-mode restart never writes files.
//
// # Error Handling
//
// Uses best-effort error handling - logs failures and continues with remaining
// operations. Individual entity creation failures don't stop the overall process.
// Operations are not transactional across different entity types.
//
// # Example Usage
//
//	store := db.NewStore(dbConnection)
//	config, _ := util.LoadConfig(".")
//
//	// Creates full demo site
//	devModeUtil.CreateDummyData(store, config)
//
//	// Typical output:
//	// 🎭 Creating dummy data...
//	// ✅ Created 4 dummy users
//	// ✅ Created 3 taxonomy types and 45 taxonomy terms
//	// ✅ Created 12 dummy media files
//	// ✅ Created 10 dummy posts
//	// ✅ Created 5 dummy pages
//	// 🎉 Dummy data creation completed!
//
// # Requirements
//
//   - store: Active database connection with completed migrations
//   - config: Must include valid UploadPath for media storage
//   - config.UploadPath: Directory must be writable, created if doesn't exist
func CreateDummyData(store db.Store, config util.Config) {
	log.Println("🎭 Creating dummy data...")

	userCount, err := store.CountTotalUsers(context.TODO())
	if err == nil && userCount > 1 {
		log.Println("ℹ️  Dummy data already exists, skipping creation")
		return
	}

	users := createDummyUsers(store)
	log.Printf("✅ Created %d dummy users", len(users))

	taxonomyTypes, taxonomyTerms := createDummyTaxonomies(store)
	log.Printf("✅ Using %d taxonomy types, created %d taxonomy terms", len(taxonomyTypes), len(taxonomyTerms))

	media := createDummyMedia(store, users, config)
	log.Printf("✅ Created %d dummy media files", len(media))

	imageURLs := seededImageURLs(config.UploadPath, media)
	posts := createDummyPosts(store, users, taxonomyTerms, imageURLs)
	log.Printf("✅ Created %d dummy posts", len(posts))

	pages := createDummyPages(store, users, imageURLs)
	log.Printf("✅ Created %d dummy pages", len(pages))

	linkMediaToPosts(store, append(posts, pages...), media)
	log.Println("✅ Linked media to posts and pages")

	log.Println("🎉 Dummy data creation completed!")
}

// createDummyUsers creates a set of demo users with different roles for testing
// content management features and permissions. All users receive development-only
// passwords that must be changed before any production use.
//
// # Users Created
//
//   - editor: editor role — content management permissions (password: password123)
//   - author: contributor role (password: password123)
//   - contributor: contributor role (password: password123)
//   - moderator: editor role (password: password123)
//
// Roles follow the admin/editor/contributor taxonomy; the legacy usernames are
// kept so other seed code and muscle memory keep working.
//
// # Security Note
//
// All users are created with the weak password "password123" for development
// convenience. These are NOT suitable for production and should be disabled
// or have passwords changed before any public deployment.
//
// # Email Pattern
//
// Emails follow the pattern <username>@golive-cms.local, which are fictional
// addresses suitable for development. Real email addresses should be used
// for production user accounts.
//
// # Deterministic Names
//
// Uses gofakeit.Seed(0) for reproducible full names across runs, making
// testing and screenshots predictable. The usernames and roles are fixed.
//
// # Error Handling
//
// Continues creating remaining users if individual user creation fails.
// Password hashing failures are logged but don't stop the process.
func createDummyUsers(store db.Store) []db.User {
	var users []db.User
	gofakeit.Seed(0)

	for _, dummy := range dummyUsers {
		username := dummy.username
		hashedPassword, err := util.HashPassword(DummyUserPassword)
		if err != nil {
			log.Printf("❌ Failed to hash password for %s: %v", username, err)
			continue
		}

		user := db.CreateUserParams{
			Username:       username,
			Email:          fmt.Sprintf("%s@golive-cms.local", username),
			FullName:       gofakeit.Name(),
			HashedPassword: hashedPassword,
			Role:           dummy.role,
		}

		createdUser, err := store.CreateUser(context.TODO(), user)
		if err != nil {
			log.Printf("❌ Failed to create user %s: %v", username, err)
			continue
		}

		users = append(users, createdUser)
	}

	return users
}

// createDummyTaxonomies creates a comprehensive taxonomy structure including
// taxonomy types and their associated terms. This provides a realistic content
// classification system for theme development and CMS demonstrations.
//
// # Taxonomy Types Used
//
//   - category: Hierarchical categories (Technology, Design, Lifestyle, Business)
//   - tag: Flat tags for content labeling (tutorial, guide, tips, frameworks, etc.)
//   - page_category: Page-specific categories (Company, Legal, Support, Campaigns)
//
// The init migration already inserts all three, so each type is looked up by
// name and only created if missing (ensureTaxonomyType). Terms are attached
// to the type with the matching name, never by position: when the seeder
// created the types itself and two of them already existed, the remaining
// one shifted into slot 0 and the categories were filed under Tags.
//
// # Category Structure (Hierarchical)
//
// Parent categories with child subcategories:
//   - Technology → Programming, Web Development, Mobile Apps
//   - Design → UI/UX, Graphic Design, Photography
//   - Lifestyle → Travel, Health & Fitness, Food & Cooking
//   - Business → Marketing, Entrepreneurship, Finance
//
// # Tags Created (Flat)
//
// Popular development and content tags including: tutorial, guide, tips,
// best-practices, review, news, beginner, advanced, coding, ui-design, productivity,
// tools, framework, library, api, database, security, performance, and various
// technology-specific tags (javascript, react, vue, angular, nodejs, python, golang, etc.)
//
// # Page Categories (Hierarchical)
//
// Organizational categories for static pages: Company, Legal, Support, Campaigns
//
// # Slugging Strategy
//
// All terms receive URL-safe slugs via seedSlug() ("UI/UX" -> "ui-ux").
// taxonomy_terms.slug is unique across all types, so no two seeded terms may
// share a slug (hence the "ui-design" tag and the "Campaigns" page category,
// which would otherwise clash with the Design and Marketing categories).
// Sort order is populated for predictable listing in admin interfaces.
//
// # Deterministic Creation
//
// Uses gofakeit.Seed(0) for consistent results across runs, making the
// taxonomy structure predictable for development and testing.
//
// Returns both the created taxonomy types and all terms for use in content creation.
func createDummyTaxonomies(store db.Store) ([]db.TaxonomyType, []db.TaxonomyTerm) {
	var taxonomyTypes []db.TaxonomyType
	var taxonomyTerms []db.TaxonomyTerm
	gofakeit.Seed(0)

	typeDefinitions := []struct {
		name         string
		label        string
		description  string
		hierarchical bool
	}{
		{"category", "Categories", "Hierarchical categories for organizing content", true},
		{"tag", "Tags", "Post tags for labeling content", false},
		{"page_category", "Page Categories", "Categories specifically for pages", true},
	}

	typesByName := map[string]db.TaxonomyType{}
	for _, typeDef := range typeDefinitions {
		typeParams := db.CreateTaxonomyTypeParams{
			Name:         typeDef.name,
			Label:        typeDef.label,
			Description:  sql.NullString{String: typeDef.description, Valid: true},
			Hierarchical: typeDef.hierarchical,
			Public:       true,
			ShowUi:       true,
			ShowInMenu:   true,
		}

		taxonomyType, err := ensureTaxonomyType(store, typeParams)
		if err != nil {
			log.Printf("❌ Failed to get or create taxonomy type %s: %v", typeDef.name, err)
			continue
		}

		taxonomyTypes = append(taxonomyTypes, taxonomyType)
		typesByName[typeDef.name] = taxonomyType
	}
	if categoryType, ok := typesByName["category"]; ok {

		parentCategories := []struct {
			name        string
			description string
		}{
			{"Technology", "Latest trends in technology and innovation"},
			{"Design", "Design principles and creative inspiration"},
			{"Lifestyle", "Lifestyle tips and personal development"},
			{"Business", "Business strategies and entrepreneurship"},
		}

		var parentTerms []db.TaxonomyTerm
		for _, cat := range parentCategories {
			termParams := db.CreateTaxonomyTermParams{
				Name:           cat.name,
				Slug:           seedSlug(cat.name),
				Description:    sql.NullString{String: cat.description, Valid: true},
				TaxonomyTypeID: categoryType.ID,
				SortOrder:      sql.NullInt32{Int32: int32(len(parentTerms) + 1), Valid: true},
			}

			createdTerm, err := store.CreateTaxonomyTerm(context.TODO(), termParams)
			if err != nil {
				log.Printf("❌ Failed to create category %s: %v", cat.name, err)
				continue
			}

			parentTerms = append(parentTerms, createdTerm)
			taxonomyTerms = append(taxonomyTerms, createdTerm)
		}

		childCategories := map[string][]struct {
			name        string
			description string
		}{
			"Technology": {
				{"Programming", "Programming tutorials and best practices"},
				{"Web Development", "Web development tips and frameworks"},
				{"Mobile Apps", "Mobile application development guides"},
			},
			"Design": {
				{"UI/UX", "User interface and experience design"},
				{"Graphic Design", "Visual design and branding"},
				{"Photography", "Photography techniques and inspiration"},
			},
			"Lifestyle": {
				{"Travel", "Travel guides and adventure stories"},
				{"Health & Fitness", "Health tips and fitness routines"},
				{"Food & Cooking", "Recipes and culinary adventures"},
			},
			"Business": {
				{"Marketing", "Marketing tactics and growth strategies"},
				{"Entrepreneurship", "Startup tips and business building"},
				{"Finance", "Personal and business finance advice"},
			},
		}

		for _, parentTerm := range parentTerms {
			if children, exists := childCategories[parentTerm.Name]; exists {
				for _, child := range children {
					childParams := db.CreateTaxonomyTermParams{
						Name:           child.name,
						Slug:           seedSlug(child.name),
						Description:    sql.NullString{String: child.description, Valid: true},
						ParentID:       sql.NullInt64{Int64: parentTerm.ID, Valid: true},
						TaxonomyTypeID: categoryType.ID,
						SortOrder:      sql.NullInt32{Int32: int32(len(taxonomyTerms) + 1), Valid: true},
					}

					createdChild, err := store.CreateTaxonomyTerm(context.TODO(), childParams)
					if err != nil {
						log.Printf("❌ Failed to create child category %s: %v", child.name, err)
						continue
					}

					taxonomyTerms = append(taxonomyTerms, createdChild)
				}
			}
		}
	}

	if tagType, ok := typesByName["tag"]; ok {

		tags := []string{
			"tutorial", "guide", "tips", "best-practices", "review", "news",
			"beginner", "advanced", "coding", "ui-design", "productivity", "tools",
			"framework", "library", "api", "database", "security", "performance",
			"mobile", "responsive", "javascript", "react", "vue", "angular",
			"nodejs", "python", "golang", "java", "css", "html",
		}

		for i, tagName := range tags {
			tagParams := db.CreateTaxonomyTermParams{
				Name:           tagName,
				Slug:           seedSlug(tagName),
				Description:    sql.NullString{String: fmt.Sprintf("Posts tagged with %s", tagName), Valid: true},
				TaxonomyTypeID: tagType.ID,
				SortOrder:      sql.NullInt32{Int32: int32(i + 1), Valid: true},
			}

			createdTag, err := store.CreateTaxonomyTerm(context.TODO(), tagParams)
			if err != nil {
				log.Printf("❌ Failed to create tag %s: %v", tagName, err)
				continue
			}

			taxonomyTerms = append(taxonomyTerms, createdTag)
		}
	}

	if pageCategoryType, ok := typesByName["page_category"]; ok {

		pageCategories := []struct {
			name        string
			description string
		}{
			{"Company", "Company information and about pages"},
			{"Legal", "Legal documents and policies"},
			{"Support", "Help and support documentation"},
			{"Campaigns", "Marketing and promotional pages"},
		}

		for i, cat := range pageCategories {
			pageCatParams := db.CreateTaxonomyTermParams{
				Name:           cat.name,
				Slug:           seedSlug(cat.name),
				Description:    sql.NullString{String: cat.description, Valid: true},
				TaxonomyTypeID: pageCategoryType.ID,
				SortOrder:      sql.NullInt32{Int32: int32(i + 1), Valid: true},
			}

			createdPageCat, err := store.CreateTaxonomyTerm(context.TODO(), pageCatParams)
			if err != nil {
				log.Printf("❌ Failed to create page category %s: %v", cat.name, err)
				continue
			}

			taxonomyTerms = append(taxonomyTerms, createdPageCat)
		}
	}

	return taxonomyTypes, taxonomyTerms
}

// ensureTaxonomyType returns the taxonomy type named params.Name, creating it
// from params only if it doesn't exist yet.
func ensureTaxonomyType(store db.Store, params db.CreateTaxonomyTypeParams) (db.TaxonomyType, error) {
	existing, err := store.GetTaxonomyType(context.TODO(), params.Name)
	if err == nil {
		log.Printf("ℹ️  Using existing taxonomy type: %s", existing.Label)
		return existing, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return db.TaxonomyType{}, err
	}

	created, err := store.CreateTaxonomyType(context.TODO(), params)
	if err != nil {
		return db.TaxonomyType{}, err
	}
	log.Printf("✅ Created taxonomy type: %s", created.Label)
	return created, nil
}

// createDummyMedia stores the sample images (embedded, see sampleimages/) in
// config.UploadPath and creates a media record for each.
//
// # File System Operations
//
//   - Creates UploadPath (0755) if needed and writes sample-image-1.jpg
//     through sample-image-12.jpg into it (storeSampleImage). A file that
//     already holds the same image is reused; a different file with that
//     name is left alone and the image goes to sample-image-N_1.jpg etc.
//   - media_path has the same form as a real upload's: UploadPath + "/" +
//     filename, so /uploads serves it and media DELETE/replace treat it as
//     inside the upload directory
//
// The files are JPEGs whose bytes match their extension, so they pass the
// same content checks as uploads (api.allowedMediaTypes). Width and height
// come from the image header.
//
// # User Assignment
//
// Media ownership assigned to users in round-robin fashion. Requires at least
// one user to exist - logs error and returns if no users available.
func createDummyMedia(store db.Store, users []db.User, config util.Config) []db.Medium {
	var media []db.Medium
	gofakeit.Seed(0)

	if len(users) == 0 {
		log.Println("❌ No users available for media creation")
		return media
	}

	for i := 0; i < sampleImageCount; i++ {
		n := i + 1

		_, imgConfig, err := sampleImage(n)
		if err != nil {
			log.Printf("❌ Failed to read sample image %d: %v", n, err)
			continue
		}
		filename, err := storeSampleImage(config.UploadPath, n)
		if err != nil {
			log.Printf("❌ Failed to store sample image %d: %v", n, err)
			continue
		}
		fileInfo, err := os.Stat(filepath.Join(config.UploadPath, filename))
		if err != nil {
			log.Printf("❌ Failed to get file info for image %d: %v", n, err)
			continue
		}

		mediaParams := db.CreateMediaParams{
			Name:             filename,
			Description:      gofakeit.Sentence(8),
			Alt:              fmt.Sprintf("Abstract sample image number %d", n),
			MediaPath:        sampleMediaPath(config.UploadPath, filename),
			UserID:           users[i%len(users)].ID,
			FileSize:         fileInfo.Size(),
			MimeType:         "image/jpeg",
			Width:            int32(imgConfig.Width),
			Height:           int32(imgConfig.Height),
			Duration:         0,
			OriginalFilename: filename,
		}

		createdMedia, err := store.CreateMedia(context.TODO(), mediaParams)
		if err != nil {
			log.Printf("❌ Failed to create media record %d: %v", n, err)
			continue
		}

		media = append(media, createdMedia)
	}

	return media
}

// seededImageURLs returns the public URLs of the seeded media, in order, for
// post and page meta (featured_image, header_image).
func seededImageURLs(uploadPath string, media []db.Medium) []string {
	urls := make([]string, 0, len(media))
	for _, m := range media {
		urls = append(urls, sampleMediaURL(uploadPath, filepath.Base(m.MediaPath)))
	}
	return urls
}

// pickImageURL returns urls[i], wrapping around, or "" if there are none.
func pickImageURL(urls []string, i int) string {
	if len(urls) == 0 {
		return ""
	}
	return urls[i%len(urls)]
}

// createDummyPosts generates a collection of sample blog posts with realistic
// titles, content, and metadata. These posts demonstrate various content management
// features and provide material for theme development and CMS testing.
//
// # Posts Created
//
// Creates 10 blog posts with technology and development-focused titles:
//   - Getting Started with Go Programming
//   - The Future of Web Development
//   - Mobile App Design Best Practices
//   - Understanding Microservices Architecture
//   - CSS Grid vs Flexbox: When to Use What
//   - Building Scalable APIs with Go
//   - The Art of Code Reviews
//   - Database Optimization Techniques
//   - Modern JavaScript Frameworks Comparison
//   - DevOps Best Practices for Small Teams
//
// # Content Generation
//
// Each post receives:
//   - Unique URL slug with timestamp suffix to prevent conflicts
//   - Generated Block Spec v1 content via generateDummyBlockDoc()
//   - Realistic descriptions using gofakeit sentences
//   - Round-robin user assignment for diverse authorship
//   - Post status set to "published" and type set to "post"
//
// # Metadata Fields
//
// Each post includes comprehensive metadata suitable for theme demonstrations:
//   - featured_image: Reference to sample media files
//   - reading_time: Random 2-15 minute estimate
//   - seo_title: Enhanced title for search optimization
//   - seo_description: Generated SEO description
//   - author_bio: Fake author biography
//   - social_image: Social media preview image
//   - enable_comments: Boolean flag for comment system
//   - post_views: Random view count (100-5000)
//   - difficulty_level: beginner/intermediate/advanced rotation
//   - estimated_time: Reading time in minutes
//
// # Taxonomy Assignment
//
// Posts are linked to 1-3 random taxonomy terms when available, avoiding
// duplicate term assignments per post. This demonstrates content classification
// and filtering capabilities.
//
// # URL Generation
//
// URLs use generateSlug() with timestamp suffixes for uniqueness. Re-running
// this function will create posts with different URLs rather than conflicting.
//
// # Dependencies
//
//   - users: Requires at least one user for authorship assignment
//   - taxonomyTerms: Optional but recommended for realistic content classification
func createDummyPosts(store db.Store, users []db.User, taxonomyTerms []db.TaxonomyTerm, imageURLs []string) []db.Post {
	var posts []db.Post
	gofakeit.Seed(0)

	if len(users) == 0 {
		log.Println("❌ No users available for post creation")
		return posts
	}

	blogPostTitles := []string{
		"Getting Started with Go Programming",
		"The Future of Web Development",
		"Mobile App Design Best Practices",
		"Understanding Microservices Architecture",
		"CSS Grid vs Flexbox: When to Use What",
		"Building Scalable APIs with Go",
		"The Art of Code Reviews",
		"Database Optimization Techniques",
		"Modern JavaScript Frameworks Comparison",
		"DevOps Best Practices for Small Teams",
	}

	for i, title := range blogPostTitles {
		userIndex := i % len(users)
		url := generateSlug(title)
		uniqueURL := fmt.Sprintf("%s-%d", url, time.Now().UnixNano()+int64(i))

		postParams := db.CreatePostsParams{
			Title:       title,
			Description: gofakeit.Sentence(15),
			Url:         uniqueURL,
			UserID:      users[userIndex].ID,
			Username:    users[userIndex].Username,
			PostType:    "post",
			PostStatus:  "published",
			PostParent:  sql.NullInt64{Valid: false},
			MenuOrder:   0,
			Slug:        seedSlug(title),
			BlockDoc:    generateDummyBlockDoc(title),
		}

		createdPost, err := createSeedPost(store, postParams)
		if err != nil {
			log.Printf("❌ Failed to create post '%s': %v", title, err)
			continue
		}

		blogMeta := map[string]string{
			"featured_image":   pickImageURL(imageURLs, i),
			"reading_time":     fmt.Sprintf("%d", gofakeit.Number(2, 15)),
			"seo_title":        title + " - Complete Guide",
			"seo_description":  gofakeit.Sentence(20),
			"author_bio":       gofakeit.Sentence(25),
			"social_image":     pickImageURL(imageURLs, i),
			"enable_comments":  "true",
			"post_views":       fmt.Sprintf("%d", gofakeit.Number(100, 5000)),
			"difficulty_level": []string{"beginner", "intermediate", "advanced"}[i%3],
			"estimated_time":   fmt.Sprintf("%d minutes", gofakeit.Number(5, 30)),
		}

		for key, value := range blogMeta {
			if value == "" { // no seeded media to point at
				continue
			}
			_, err := store.UpsertPostMeta(context.TODO(), db.UpsertPostMetaParams{
				PostID:    createdPost.ID,
				MetaKey:   key,
				MetaValue: sql.NullString{String: value, Valid: true},
			})
			if err != nil {
				log.Printf("❌ Failed to create meta %s for post %s: %v", key, title, err)
			}
		}

		if len(taxonomyTerms) > 0 {
			numTerms := gofakeit.Number(1, min(3, len(taxonomyTerms)))
			usedTerms := make(map[int64]bool)

			for j := 0; j < numTerms; j++ {
				termIndex := gofakeit.Number(0, len(taxonomyTerms)-1)
				termID := taxonomyTerms[termIndex].ID

				if usedTerms[termID] {
					continue
				}
				usedTerms[termID] = true

				linkParams := db.AddPostToTaxonomyTermParams{
					PostID:         createdPost.ID,
					TaxonomyTermID: termID,
				}

				_, err := store.AddPostToTaxonomyTerm(context.TODO(), linkParams)
				if err != nil {
					log.Printf("❌ Failed to link post %s to taxonomy term: %v", title, err)
				}
			}
		}

		posts = append(posts, createdPost)
	}

	return posts
}

// createDummyPages generates static pages with hierarchical structure and
// comprehensive metadata. These pages demonstrate CMS page management features
// and provide realistic content for theme development.
//
// # Parent Pages Created
//
//   - About Us: Company information with full-width layout
//   - Services: Service offerings with sidebar layout
//   - Contact: Contact information with form integration metadata
//
// # Child Pages (Under About Us)
//
//   - Our Team: Team member information and department structure
//   - Company History: Timeline and milestone information
//
// # Page-Specific Metadata
//
// Each page includes specialized metadata fields:
//
// About Us:
//   - page_template: Template identifier for theme rendering
//   - header_image: Featured header image reference
//   - show_in_navigation: Navigation visibility control
//   - navigation_order: Menu ordering (1, 2, 3...)
//   - page_layout: Layout type (full-width, sidebar-right, etc.)
//   - custom_css: Page-specific styling
//   - meta_description: SEO description
//
// Services:
//   - service_categories: Comma-separated service types
//   - All navigation and layout metadata
//
// Contact:
//   - contact_form_id: Form integration reference
//   - office_address: Physical address information
//   - phone_number: Contact phone number
//   - email_address: Contact email
//   - business_hours: Operating hours information
//
// Child Pages:
//   - team_size: Number of team members
//   - departments: Comma-separated department list
//   - founded_year: Company founding date
//   - milestones: Timeline events
//
// # URL Structure
//
// URLs use simple slugs without timestamp suffixes (unlike posts). Re-running
// may create URL conflicts unless the idempotency guard prevents re-execution.
//
// # Page Hierarchy
//
// Demonstrates parent-child relationships via PostParent field. Child pages
// are created under "About Us" to show hierarchical page structure.
//
// # Content Format
//
// Page content is a Block Spec v1 document (headings, paragraphs, quote). Content
// is minimal but structured to show proper page formatting.
//
// # Dependencies
//
//   - users: Requires at least one user for page ownership
func createDummyPages(store db.Store, users []db.User, imageURLs []string) []db.Post {
	var pages []db.Post
	gofakeit.Seed(0)

	if len(users) == 0 {
		log.Println("❌ No users available for page creation")
		return pages
	}

	parentPages := []struct {
		title   string
		content string
		meta    map[string]string
	}{
		{
			title:   "About Us",
			content: "# About Our Company\n\nWe are a leading technology company...",
			meta: map[string]string{
				"page_template":      "about-template",
				"header_image":       pickImageURL(imageURLs, 0),
				"show_in_navigation": "true",
				"navigation_order":   "1",
				"page_layout":        "full-width",
				"custom_css":         ".about-page { background: #f8f9fa; }",
				"meta_description":   "Learn more about our company, mission, and values.",
			},
		},
		{
			title:   "Services",
			content: "# Our Services\n\nWe offer a wide range of services...",
			meta: map[string]string{
				"page_template":      "services-template",
				"header_image":       pickImageURL(imageURLs, 1),
				"show_in_navigation": "true",
				"navigation_order":   "2",
				"page_layout":        "sidebar-right",
				"service_categories": "web-development,mobile-apps,consulting",
			},
		},
		{
			title:   "Contact",
			content: "# Contact Us\n\nGet in touch with our team...",
			meta: map[string]string{
				"page_template":      "contact-template",
				"show_in_navigation": "true",
				"navigation_order":   "3",
				"contact_form_id":    "1",
				"office_address":     "123 Tech Street, San Francisco, CA 94105",
				"phone_number":       "+1 (555) 123-4567",
				"email_address":      "contact@example.com",
				"business_hours":     "Mon-Fri 9AM-6PM PST",
			},
		},
	}

	for i, pageData := range parentPages {
		userIndex := i % len(users)
		url := generateSlug(pageData.title)

		pageParams := db.CreatePostsParams{
			Title:       pageData.title,
			Description: fmt.Sprintf("Learn more about %s", pageData.title),
			Url:         url,
			UserID:      users[userIndex].ID,
			Username:    users[userIndex].Username,
			PostType:    "page",
			PostStatus:  "published",
			PostParent:  sql.NullInt64{Valid: false},
			MenuOrder:   int32(i + 1),
			Slug:        seedSlug(pageData.title),
			BlockDoc:    generateDummyBlockDoc(pageData.title),
		}

		createdPage, err := createSeedPost(store, pageParams)
		if err != nil {
			log.Printf("❌ Failed to create page '%s': %v", pageData.title, err)
			continue
		}

		for key, value := range pageData.meta {
			if value == "" { // no seeded media to point at
				continue
			}
			_, err := store.UpsertPostMeta(context.TODO(), db.UpsertPostMetaParams{
				PostID:    createdPage.ID,
				MetaKey:   key,
				MetaValue: sql.NullString{String: value, Valid: true},
			})
			if err != nil {
				log.Printf("❌ Failed to create meta %s for page %s: %v", key, pageData.title, err)
			}
		}

		pages = append(pages, createdPage)

		if pageData.title == "About Us" {
			childPages := []struct {
				title   string
				content string
				meta    map[string]string
			}{
				{
					title:   "Our Team",
					content: "# Meet Our Team\n\nOur talented team members...",
					meta: map[string]string{
						"page_template":      "team-template",
						"show_in_navigation": "false",
						"team_size":          "25",
						"departments":        "engineering,design,marketing,sales",
					},
				},
				{
					title:   "Company History",
					content: "# Our Story\n\nFounded in 2020, we started with a vision...",
					meta: map[string]string{
						"page_template":      "history-template",
						"show_in_navigation": "false",
						"founded_year":       "2020",
						"milestones":         "2020-founding,2021-first-product,2023-series-a",
					},
				},
			}

			for j, childData := range childPages {
				childURL := generateSlug(childData.title)

				childParams := db.CreatePostsParams{
					Title:       childData.title,
					Description: fmt.Sprintf("Learn more about %s", childData.title),
					Url:         childURL,
					UserID:      users[userIndex].ID,
					Username:    users[userIndex].Username,
					PostType:    "page",
					PostStatus:  "published",
					PostParent:  sql.NullInt64{Int64: createdPage.ID, Valid: true},
					MenuOrder:   int32(j + 1),
					Slug:        seedSlug(childData.title),
					BlockDoc:    generateDummyBlockDoc(childData.title),
				}

				createdChild, err := createSeedPost(store, childParams)
				if err != nil {
					log.Printf("❌ Failed to create child page '%s': %v", childData.title, err)
					continue
				}

				for key, value := range childData.meta {
					_, err := store.UpsertPostMeta(context.TODO(), db.UpsertPostMetaParams{
						PostID:    createdChild.ID,
						MetaKey:   key,
						MetaValue: sql.NullString{String: value, Valid: true},
					})
					if err != nil {
						log.Printf("❌ Failed to create meta %s for child page %s: %v", key, childData.title, err)
					}
				}

				pages = append(pages, createdChild)
			}
		}
	}

	return pages
}

// linkMediaToPosts creates associations between media files and content (posts/pages)
// to demonstrate gallery features, featured images, and media management capabilities.
// This provides realistic content-media relationships for theme development.
//
// # Linking Strategy
//
// Each media item is randomly linked to 1-2 different posts or pages, creating
// varied content associations without overwhelming any single piece of content.
//
// # Duplicate Prevention
//
// Uses a tracking map to prevent linking the same media item multiple times
// to the same post within a single execution. However, media can be shared
// across different posts.
//
// # Order Preservation
//
// Links include an order field (0, 1, 2...) to maintain consistent media
// ordering within content. This supports gallery features and media sequencing.
//
// # Error Handling
//
// Individual link creation failures are logged and skipped, allowing the
// process to continue with remaining associations.
//
// # Safety Checks
//
// Returns early if either posts or media collections are empty, preventing
// unnecessary processing and potential errors.
//
// # Deterministic Selection
//
// Uses gofakeit.Seed(0) for reproducible media-post associations across runs,
// making development and testing predictable.
//
// # Use Cases
//
// The created associations support:
//   - Featured image displays
//   - Content galleries
//   - Media library demonstrations
//   - Theme media integration testing
//
// # Dependencies
//
//   - posts: Collection of posts and/or pages to link media to
//   - media: Collection of media items to associate with content
func linkMediaToPosts(store db.Store, posts []db.Post, media []db.Medium) {
	if len(posts) == 0 || len(media) == 0 {
		log.Println("❌ No posts or media available for linking")
		return
	}

	gofakeit.Seed(0)

	for _, mediaItem := range media {
		numPosts := gofakeit.Number(1, min(2, len(posts)))
		usedPosts := make(map[int64]bool)

		for i := 0; i < numPosts; i++ {
			postIndex := gofakeit.Number(0, len(posts)-1)
			postID := posts[postIndex].ID

			if usedPosts[postID] {
				continue
			}
			usedPosts[postID] = true

			linkParams := db.CreatePostMediaParams{
				PostID:  postID,
				MediaID: mediaItem.ID,
				Order:   int32(i),
			}

			_, err := store.CreatePostMedia(context.TODO(), linkParams)
			if err != nil {
				log.Printf("❌ Failed to link media %s to post: %v", mediaItem.Name, err)
			}
		}
	}
}

// min returns the smaller of two integers. This utility function is used
// internally for bounds checking and preventing array access errors in
// random selection operations.
//
// Standard library equivalent: math.Min() exists for float64, but this
// provides type-safe integer comparison without conversion overhead.
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
