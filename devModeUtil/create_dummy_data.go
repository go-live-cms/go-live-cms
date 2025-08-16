package devModeUtil

import (
	"context"
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

func CreateDummyData(store db.Store, config util.Config) {
	log.Println("🎭 Creating dummy data...")

	userCount, err := store.CountTotalUsers(context.TODO())
	if err == nil && userCount > 1 {
		log.Println("ℹ️  Dummy data already exists, skipping creation")
		return
	}

	users := createDummyUsers(store)
	log.Printf("✅ Created %d dummy users", len(users))

	taxonomies := createDummyTaxonomies(store)
	log.Printf("✅ Created %d dummy taxonomies", len(taxonomies))

	media := createDummyMedia(store, users, config)
	log.Printf("✅ Created %d dummy media files", len(media))

	posts := createDummyPosts(store, users, taxonomies)
	log.Printf("✅ Created %d dummy posts", len(posts))

	linkMediaToPosts(store, posts, media)
	log.Println("✅ Linked media to posts")

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

func createDummyTaxonomies(store db.Store) []db.Taxonomy {
	var taxonomies []db.Taxonomy
	gofakeit.Seed(0)

	taxonomyNames := []string{
		"Technology", "Programming", "Web Development", "Mobile Apps",
		"Design", "UI/UX", "Lifestyle", "Travel", "Photography",
		"Business", "Marketing", "Health & Fitness",
	}

	descriptions := []string{
		"Latest trends in technology and innovation",
		"Programming tutorials and best practices",
		"Web development tips and frameworks",
		"Mobile application development guides",
		"Design principles and creative inspiration",
		"User interface and experience design",
		"Lifestyle tips and personal development",
		"Travel guides and adventure stories",
		"Photography techniques and inspiration",
		"Business strategies and entrepreneurship",
		"Marketing tactics and growth hacking",
		"Health tips and fitness routines",
	}

	for i, name := range taxonomyNames {
		taxonomy := db.CreateTaxonomyParams{
			Name:        name,
			Description: descriptions[i],
		}

		createdTaxonomy, err := store.CreateTaxonomy(context.TODO(), taxonomy)
		if err != nil {
			log.Printf("❌ Failed to create taxonomy %s: %v", name, err)
			continue
		}

		taxonomies = append(taxonomies, createdTaxonomy)
	}

	return taxonomies
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

func createDummyPosts(store db.Store, users []db.User, taxonomies []db.Taxonomy) []db.Post {
	var posts []db.Post
	gofakeit.Seed(0)

	if len(users) == 0 {
		log.Println("❌ No users available for post creation")
		return posts
	}

	postTitles := []string{
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
		"User Experience Design Principles",
		"Building Real-time Applications",
	}

	for i, title := range postTitles {
		userIndex := i % len(users)

		url := generateSlug(title)

		//counter := 1
		originalURL := url
		for {

			uniqueURL := fmt.Sprintf("%s-%d", originalURL, time.Now().UnixNano())
			url = uniqueURL
			break
		}

		postTxParams := db.CreatePostTxParams{
			CreatePostsParams: db.CreatePostsParams{
				Title:       title,
				Description: gofakeit.Sentence(15),
				Content:     generateDummyContent(),
				Url:         url,
				UserID:      users[userIndex].ID,
				Username:    users[userIndex].Username,
			},
			AuthorIDs: []int64{users[userIndex].ID},
		}

		result, err := store.CreatePostTx(context.TODO(), postTxParams)
		if err != nil {
			log.Printf("❌ Failed to create post '%s': %v", title, err)
			continue
		}

		if len(taxonomies) > 0 {
			numTaxonomies := gofakeit.Number(1, min(3, len(taxonomies)))
			usedTaxonomies := make(map[int64]bool)

			for j := 0; j < numTaxonomies; j++ {
				taxonomyIndex := gofakeit.Number(0, len(taxonomies)-1)
				taxonomyID := taxonomies[taxonomyIndex].ID

				if usedTaxonomies[taxonomyID] {
					continue
				}
				usedTaxonomies[taxonomyID] = true

				linkParams := db.CreatePostTaxonomyParams{
					PostID:     result.Post.ID,
					TaxonomyID: taxonomyID,
				}

				_, err := store.CreatePostTaxonomy(context.TODO(), linkParams)
				if err != nil {
					log.Printf("❌ Failed to link post %s to taxonomy: %v", title, err)
				}
			}
		}

		posts = append(posts, result.Post)
	}

	return posts
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

func generateSlug(title string) string {

	slug := ""
	for _, char := range title {
		if char >= 'A' && char <= 'Z' {
			slug += string(char + 32)
		} else if char >= 'a' && char <= 'z' || char >= '0' && char <= '9' {
			slug += string(char)
		} else if char == ' ' {
			slug += "-"
		}
	}
	return slug
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
