package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/go-live-cms/go-live-cms/customhtml"
)

// Custom HTML (#428). The working markup is post_html_snippets; these are the writes that
// move it around inside the transactions of publish, duplicate, template and restore. The
// sanitizer is called here, not by the caller, so no path can leave it out.

// postHTMLMarkup is a post's own working markup by snippet id.
func postHTMLMarkup(ctx context.Context, q *Queries, postID int64) (map[string]string, error) {
	rows, err := q.ListPostHTMLSnippets(ctx, postID)
	if err != nil {
		return nil, fmt.Errorf("list html snippets: %w", err)
	}
	markup := make(map[string]string, len(rows))
	for _, row := range rows {
		markup[row.SnippetID] = row.Html
	}
	return markup, nil
}

// materializeHTML returns blockDoc with the post's sanitized markup in its html blocks. A
// row the sanitizer would now change (its rules are newer than the row) is rewritten, so
// the working copy and the site stay equal. With no html block it reads nothing.
func materializeHTML(ctx context.Context, q *Queries, postID int64, blockDoc json.RawMessage) (json.RawMessage, error) {
	if len(customhtml.SnippetIDs(blockDoc)) == 0 {
		// Still through Materialize: a block with no id must not keep inline markup.
		return customhtml.Materialize(blockDoc, nil)
	}
	markup, err := postHTMLMarkup(ctx, q, postID)
	if err != nil {
		return nil, err
	}
	for id, html := range markup {
		clean := customhtml.Sanitize(html)
		if clean == html {
			continue
		}
		if _, err := q.UpdatePostHTMLSnippet(ctx, UpdatePostHTMLSnippetParams{PostID: postID, SnippetID: id, Html: clean}); err != nil {
			return nil, fmt.Errorf("rewrite html snippet: %w", err)
		}
		markup[id] = clean
	}
	return customhtml.Materialize(blockDoc, markup)
}

// recordPublishedHTML notes what the site now shows (the version just published), for
// "Changes not published": each snippet's published_html, NULL for the rest.
func recordPublishedHTML(ctx context.Context, q *Queries, postID int64, blockDoc json.RawMessage) error {
	markup := customhtml.Markup(blockDoc)
	ids := make([]string, 0, len(markup))
	for id, html := range markup {
		ids = append(ids, id)
		if err := q.SetPostHTMLSnippetPublished(ctx, SetPostHTMLSnippetPublishedParams{
			PostID: postID, SnippetID: id, PublishedHtml: sql.NullString{String: html, Valid: true},
		}); err != nil {
			return fmt.Errorf("set published html: %w", err)
		}
	}
	return q.ClearPublishedHTMLSnippetsExcept(ctx, ClearPublishedHTMLSnippetsExceptParams{PostID: postID, SnippetIds: ids})
}

// copyHTMLSnippets gives a new post its own copy of the markup in source (by snippet id):
// arg's block_doc gets new ids and the rows are written once the post exists. The returned
// function writes them.
func copyHTMLSnippets(ctx context.Context, q *Queries, arg *CreatePostsParams, source map[string]string) (func(postID int64) error, error) {
	blockDoc, snippets, err := customhtml.Rekey(arg.BlockDoc, source, uuid.NewString)
	if err != nil {
		return nil, fmt.Errorf("copy html snippets: %w", err)
	}
	arg.BlockDoc = blockDoc
	return func(postID int64) error {
		for _, snippet := range snippets {
			if _, err := q.CreatePostHTMLSnippet(ctx, CreatePostHTMLSnippetParams{PostID: postID, SnippetID: snippet.ID, Html: snippet.HTML}); err != nil {
				return fmt.Errorf("copy html snippet: %w", err)
			}
		}
		return nil
	}, nil
}
