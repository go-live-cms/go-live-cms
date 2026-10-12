package devModeUtil

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"

	"github.com/brianvoe/gofakeit/v6"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/sqlc-dev/pqtype"
)

// generateDummyBlockDoc builds a readable Block Spec v1 document (headings,
// paragraphs and a quote) for seeded posts and pages.
func generateDummyBlockDoc(title string) json.RawMessage {
	blocks := map[string]interface{}{}
	order := []string{}
	add := func(blockType string, attrs map[string]interface{}) {
		id := fmt.Sprintf("seed-block-%s-%02d", generateSlug(title), len(order)+1)
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

	doc, err := json.Marshal(map[string]interface{}{"doc_version": 1, "blocks_order": order, "blocks": blocks})
	if err != nil {
		return json.RawMessage(`{"doc_version":1,"blocks_order":[],"blocks":{}}`)
	}
	return doc
}

// publishDummyDoc copies the draft block document into published_block_doc so
// the public site renders the seeded content.
func publishDummyDoc(store db.Store, postID int64, doc json.RawMessage) {
	err := store.SetPublishedVersionOnPost(context.TODO(), db.SetPublishedVersionOnPostParams{
		ID:                 postID,
		PublishedVersionID: sql.NullInt64{Valid: false},
		PublishedBlockDoc:  pqtype.NullRawMessage{RawMessage: doc, Valid: true},
	})
	if err != nil {
		log.Printf("❌ Failed to publish seeded doc for post %d: %v", postID, err)
	}
}
