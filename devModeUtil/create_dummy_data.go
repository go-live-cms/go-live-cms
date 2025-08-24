package devModeUtil

import (
	"context"
	"database/sql"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/brianvoe/gofakeit/v6"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/util"
)

var sampleImages = []string{
	"https://picsum.photos/800/600?random=1",
	"https://picsum.photos/800/600?random=2",
	"https://picsum.photos/800/600?random=3",
	"https://picsum.photos/800/600?random=4",
	"https://picsum.photos/800/600?random=5",
	"https://picsum.photos/800/600?random=6",
	"https://picsum.photos/800/600?random=7",
	"https://picsum.photos/800/600?random=8",
	"https://picsum.photos/800/600?random=9",
	"https://picsum.photos/800/600?random=10",
	"https://picsum.photos/800/600?random=11",
	"https://picsum.photos/800/600?random=12",
}

func generateSlug(name string) string {
	return strings.ToLower(strings.ReplaceAll(name, " ", "-"))
}

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
	log.Printf("✅ Created %d taxonomy types and %d taxonomy terms", len(taxonomyTypes), len(taxonomyTerms))

	media := createDummyMedia(store, users, config)
	log.Printf("✅ Created %d dummy media files", len(media))

	posts := createDummyPosts(store, users, taxonomyTerms)
	log.Printf("✅ Created %d dummy posts", len(posts))

	pages := createDummyPages(store, users)
	log.Printf("✅ Created %d dummy pages", len(pages))

	linkMediaToPosts(store, append(posts, pages...), media)
	log.Println("✅ Linked media to posts and pages")

	log.Println("🎉 Dummy data creation completed!")
}

func createDummyUsers(store db.Store) []db.User {
	var users []db.User
	gofakeit.Seed(0)

	usernames := []string{"editor", "author", "contributor", "moderator"}
	roles := []string{"editor", "author", "author", "moderator"}

	for i, username := range usernames {
		hashedPassword, err := util.HashPassword("password123")
		if err != nil {
			log.Printf("❌ Failed to hash password for %s: %v", username, err)
			continue
		}

		user := db.CreateUserParams{
			Username:       username,
			Email:          fmt.Sprintf("%s@golive-cms.local", username),
			FullName:       gofakeit.Name(),
			HashedPassword: hashedPassword,
			Role:           roles[i],
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
		{"post_tag", "Tags", "Non-hierarchical tags for content", false},
		{"page_category", "Page Categories", "Categories specifically for pages", true},
	}

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

		createdType, err := store.CreateTaxonomyType(context.TODO(), typeParams)
		if err != nil {
			log.Printf("❌ Failed to create taxonomy type %s: %v", typeDef.name, err)
			continue
		}

		taxonomyTypes = append(taxonomyTypes, createdType)
		log.Printf("✅ Created taxonomy type: %s", typeDef.label)
	}

	if len(taxonomyTypes) > 0 {
		categoryType := taxonomyTypes[0]

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
				Slug:           generateSlug(cat.name),
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
						Slug:           generateSlug(child.name),
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

	if len(taxonomyTypes) > 1 {
		tagType := taxonomyTypes[1]

		tags := []string{
			"tutorial", "guide", "tips", "best-practices", "review", "news",
			"beginner", "advanced", "coding", "design", "productivity", "tools",
			"framework", "library", "api", "database", "security", "performance",
			"mobile", "responsive", "javascript", "react", "vue", "angular",
			"nodejs", "python", "golang", "java", "css", "html",
		}

		for i, tagName := range tags {
			tagParams := db.CreateTaxonomyTermParams{
				Name:           tagName,
				Slug:           generateSlug(tagName),
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

	if len(taxonomyTypes) > 2 {
		pageCategoryType := taxonomyTypes[2]

		pageCategories := []struct {
			name        string
			description string
		}{
			{"Company", "Company information and about pages"},
			{"Legal", "Legal documents and policies"},
			{"Support", "Help and support documentation"},
			{"Marketing", "Marketing and promotional pages"},
		}

		for i, cat := range pageCategories {
			pageCatParams := db.CreateTaxonomyTermParams{
				Name:           cat.name,
				Slug:           generateSlug(cat.name),
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

func createDummyMedia(store db.Store, users []db.User, config util.Config) []db.Medium {
	var media []db.Medium
	gofakeit.Seed(0)

	uploadsDir := filepath.Join(".", config.UploadPath)
	if err := os.MkdirAll(uploadsDir, 0755); err != nil {
		log.Printf("❌ Failed to create uploads directory: %v", err)
		return media
	}

	for i, imageURL := range sampleImages {
		filename := fmt.Sprintf("sample-image-%d.jpg", i+1)
		filePath := filepath.Join(uploadsDir, filename)

		if err := downloadImage(imageURL, filePath); err != nil {
			log.Printf("❌ Failed to download image %d: %v", i+1, err)
			continue
		}

		userIndex := i % len(users)
		if len(users) == 0 {
			log.Println("❌ No users available for media creation")
			break
		}

		fileInfo, err := os.Stat(filePath)
		if err != nil {
			log.Printf("❌ Failed to get file info for image %d: %v", i+1, err)
			continue
		}

		var width, height int32 = 0, 0
		if imageFile, err := os.Open(filePath); err == nil {
			if config, _, err := image.DecodeConfig(imageFile); err == nil {
				width = int32(config.Width)
				height = int32(config.Height)
			}
			imageFile.Close()
		}

		mediaParams := db.CreateMediaParams{
			Name:             filename,
			Description:      gofakeit.Sentence(8),
			Alt:              fmt.Sprintf("Beautiful sample image number %d", i+1),
			MediaPath:        fmt.Sprintf("%s/%s", config.UploadPath, filename),
			UserID:           users[userIndex].ID,
			FileSize:         fileInfo.Size(),
			MimeType:         "image/jpeg",
			Width:            width,
			Height:           height,
			Duration:         0,
			OriginalFilename: filename,
		}

		createdMedia, err := store.CreateMedia(context.TODO(), mediaParams)
		if err != nil {
			log.Printf("❌ Failed to create media record %d: %v", i+1, err)
			os.Remove(filePath)
			continue
		}

		media = append(media, createdMedia)
	}

	return media
}

func createDummyPosts(store db.Store, users []db.User, taxonomyTerms []db.TaxonomyTerm) []db.Post {
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
			Content:     generateDummyContent(),
			Url:         uniqueURL,
			UserID:      users[userIndex].ID,
			Username:    users[userIndex].Username,
			PostType:    "post",
			PostStatus:  "published",
			PostParent:  sql.NullInt64{Valid: false},
			MenuOrder:   0,
		}

		createdPost, err := store.CreatePosts(context.TODO(), postParams)
		if err != nil {
			log.Printf("❌ Failed to create post '%s': %v", title, err)
			continue
		}

		blogMeta := map[string]string{
			"featured_image":   fmt.Sprintf("/uploads/sample-image-%d.jpg", (i%12)+1),
			"reading_time":     fmt.Sprintf("%d", gofakeit.Number(2, 15)),
			"seo_title":        title + " - Complete Guide",
			"seo_description":  gofakeit.Sentence(20),
			"author_bio":       gofakeit.Sentence(25),
			"social_image":     fmt.Sprintf("/uploads/sample-image-%d.jpg", (i%12)+1),
			"enable_comments":  "true",
			"post_views":       fmt.Sprintf("%d", gofakeit.Number(100, 5000)),
			"difficulty_level": []string{"beginner", "intermediate", "advanced"}[i%3],
			"estimated_time":   fmt.Sprintf("%d minutes", gofakeit.Number(5, 30)),
		}

		for key, value := range blogMeta {
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

func createDummyPages(store db.Store, users []db.User) []db.Post {
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
				"header_image":       "/uploads/sample-image-1.jpg",
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
				"header_image":       "/uploads/sample-image-2.jpg",
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
			Content:     pageData.content,
			Url:         url,
			UserID:      users[userIndex].ID,
			Username:    users[userIndex].Username,
			PostType:    "page",
			PostStatus:  "published",
			PostParent:  sql.NullInt64{Valid: false},
			MenuOrder:   int32(i + 1),
		}

		createdPage, err := store.CreatePosts(context.TODO(), pageParams)
		if err != nil {
			log.Printf("❌ Failed to create page '%s': %v", pageData.title, err)
			continue
		}

		for key, value := range pageData.meta {
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
					Content:     childData.content,
					Url:         childURL,
					UserID:      users[userIndex].ID,
					Username:    users[userIndex].Username,
					PostType:    "page",
					PostStatus:  "published",
					PostParent:  sql.NullInt64{Int64: createdPage.ID, Valid: true},
					MenuOrder:   int32(j + 1),
				}

				createdChild, err := store.CreatePosts(context.TODO(), childParams)
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

func downloadImage(url, filepath string) error {
	client := &http.Client{
		Timeout: 30 * time.Second,
	}

	resp, err := client.Get(url)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("bad status: %s", resp.Status)
	}

	out, err := os.Create(filepath)
	if err != nil {
		return err
	}
	defer out.Close()

	_, err = io.Copy(out, resp.Body)
	return err
}

func generateDummyContent() string {
	gofakeit.Seed(time.Now().UnixNano())

	content := fmt.Sprintf("# %s\n\n", gofakeit.Sentence(5))
	content += fmt.Sprintf("%s\n\n", gofakeit.Paragraph(3, 5, 8, " "))
	content += "## Key Points\n\n"

	for i := 0; i < 3; i++ {
		content += fmt.Sprintf("- %s\n", gofakeit.Sentence(8))
	}

	content += "\n" + gofakeit.Paragraph(4, 6, 10, " ") + "\n\n"
	content += "## Conclusion\n\n"
	content += gofakeit.Paragraph(2, 4, 8, " ")

	return content
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
