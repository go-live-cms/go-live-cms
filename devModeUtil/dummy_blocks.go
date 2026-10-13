package devModeUtil

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/brianvoe/gofakeit/v6"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/lib/pq"
	"github.com/sqlc-dev/pqtype"
)

const maxSlugAttempts = 5

var nonSlugChars = regexp.MustCompile(`[^a-z0-9]+`)

// seedSlug turns a title into a URL-safe slug: lowercase alphanumerics
// separated by single hyphens (e.g. "CSS Grid vs Flexbox: When" -> "css-grid-vs-flexbox-when").
func seedSlug(title string) string {
	return strings.Trim(nonSlugChars.ReplaceAllString(strings.ToLower(title), "-"), "-")
}

// generateDummyBlockDoc builds a readable Block Spec v1 document (headings,
// paragraphs and a quote) for seeded posts and pages.
func generateDummyBlockDoc(title string) json.RawMessage {
	blocks := map[string]interface{}{}
	order := []string{}
	prefix := "seed-block-" + seedSlug(title)
	add := func(blockType string, attrs map[string]interface{}) {
		id := fmt.Sprintf("%s-%02d", prefix, len(order)+1)
		blocks[id] = map[string]interface{}{"id": id, "type": blockType, "version": 1, "attrs": attrs}
		order = append(order, id)
	}

	add("heading", map[string]interface{}{"level": 1, "text": title})
	add("paragraph", map[string]interface{}{"text": gofakeit.Paragraph(2, 4, 10, " ")})
	add("heading", map[string]interface{}{"level": 2, "text": "Key Points"})
	for i := 0; i < 3; i++ {
		add("paragraph", map[string]interface{}{"text": gofakeit.Sentence(10)})
	}
	add("blockquote", map[string]interface{}{"text": gofakeit.Sentence(12)})
	add("heading", map[string]interface{}{"level": 2, "text": "Conclusion"})
	add("paragraph", map[string]interface{}{"text": gofakeit.Paragraph(2, 3, 10, " ")})

	// Only strings and ints are marshalled, so this cannot fail.
	doc, _ := json.Marshal(map[string]interface{}{"doc_version": 1, "blocks_order": order, "blocks": blocks})
	return doc
}

// createSeedPost creates a post/page and copies its draft block document into
// published_block_doc so the public site renders it. If the slug is already
// taken (e.g. re-seeding after a partial run) it retries with a numeric suffix.
func createSeedPost(store db.Store, params db.CreatePostsParams) (db.Post, error) {
	baseSlug := params.Slug
	var post db.Post
	var err error
	for attempt := 1; attempt <= maxSlugAttempts; attempt++ {
		if attempt > 1 {
			params.Slug = fmt.Sprintf("%s-%d", baseSlug, attempt)
		}
		post, err = store.CreatePosts(context.TODO(), params)
		var pqErr *pq.Error
		if err == nil || !errors.As(err, &pqErr) || pqErr.Code != "23505" || !strings.Contains(pqErr.Constraint, "slug") {
			break
		}
	}
	if err != nil {
		return post, err
	}

	err = store.SetPublishedVersionOnPost(context.TODO(), db.SetPublishedVersionOnPostParams{
		ID:                 post.ID,
		PublishedVersionID: sql.NullInt64{Valid: false},
		PublishedBlockDoc:  pqtype.NullRawMessage{RawMessage: params.BlockDoc, Valid: true},
	})
	if err != nil {
		return post, fmt.Errorf("publish seeded doc for post %d: %w", post.ID, err)
	}
	return post, nil
}
