package api

import (
	"database/sql"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"unicode"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// maxMenuItems caps a menu's items in total (top level and children).
const maxMenuItems = 200

// Menu item visibility, as the admin shows it. Readers only get visible items.
const (
	menuItemVisible     = "visible"
	menuItemUnpublished = "unpublished" // the post isn't published
	menuItemNotPublic   = "not_public"  // its post type or taxonomy isn't public (or active)
	menuItemMissing     = "missing"     // the target is gone
)

// validMenuURL reports whether a custom item's URL is safe to put in an href:
// an absolute http(s) URL with a host, or a site-relative path ("/about").
// Everything else is refused: javascript:, data: and other schemes,
// protocol-relative "//host" (and "/\host", which browsers read the same way),
// and anything with whitespace or control characters.
func validMenuURL(raw string) bool {
	if raw == "" || len(raw) > 2048 {
		return false
	}
	for _, r := range raw {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			return false
		}
	}
	if strings.HasPrefix(raw, "/") {
		if strings.HasPrefix(raw, "//") || strings.HasPrefix(raw, "/\\") {
			return false
		}
		_, err := url.Parse(raw)
		return err == nil
	}
	u, err := url.Parse(raw)
	if err != nil {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	return (scheme == "http" || scheme == "https") && u.Host != ""
}

// menuPostPath is a post's public path, the same rule as the web's postPath
// (web/src/lib/seo.ts): /{type}/{slug} when the site uses slug URLs and the
// post has a slug that isn't all digits (it would read as an id), else
// /{type}/{id}.
func menuPostPath(postType, slug string, id int64, urlStructure string) string {
	segment := strconv.FormatInt(id, 10)
	if urlStructure == "slug" && slug != "" && !allDigits(slug) {
		segment = slug
	}
	return "/" + url.PathEscape(postType) + "/" + url.PathEscape(segment)
}

func allDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return s != ""
}

// resolvedMenuItem is a stored item with what readers see: the title (its
// label, or the target's current title), the URL built from the target's
// current slug, and whether it's shown at all.
type resolvedMenuItem struct {
	Row    db.ListMenuItemsWithTargetsRow
	Title  string
	URL    string
	Status string
}

// resolveMenuItem builds an item's URL and visibility at read time, so items
// follow their target's slug and disappear when it's unpublished or gone.
func resolveMenuItem(row db.ListMenuItemsWithTargetsRow, urlStructure string) resolvedMenuItem {
	item := resolvedMenuItem{Row: row, Title: strings.TrimSpace(row.Label), Status: menuItemVisible}
	fallback := ""

	switch row.ItemType {
	case "post":
		if !row.PostSlug.Valid && !row.PostTitle.Valid {
			item.Status = menuItemMissing
			break
		}
		fallback = row.PostTitle.String
		item.URL = menuPostPath(row.PostPostType.String, row.PostSlug.String, row.PostID.Int64, urlStructure)
		switch {
		case !row.PostTypePublic.Bool || !row.PostTypeActive.Bool:
			item.Status = menuItemNotPublic
		case row.PostStatus.String != "published":
			item.Status = menuItemUnpublished
		}
	case "term":
		if !row.TermSlug.Valid {
			item.Status = menuItemMissing
			break
		}
		fallback = row.TermName.String
		// The term archive route of #348: /{taxonomy}/{slug}.
		item.URL = "/" + url.PathEscape(row.TaxonomyName.String) + "/" + url.PathEscape(row.TermSlug.String)
		if !row.TaxonomyPublic.Bool {
			item.Status = menuItemNotPublic
		}
	case "archive":
		if !row.ArchiveLabel.Valid {
			item.Status = menuItemMissing
			break
		}
		fallback = row.ArchiveLabel.String
		item.URL = "/" + url.PathEscape(row.PostType.String)
		if !row.ArchivePublic.Bool || !row.ArchiveActive.Bool {
			item.Status = menuItemNotPublic
		}
	case "custom":
		item.URL = row.Url
		// Stored before validation existed or written around the API: never
		// hand an unsafe URL to a theme.
		if !validMenuURL(row.Url) {
			item.Status = menuItemMissing
		}
	default:
		item.Status = menuItemMissing
	}

	if item.Title == "" {
		item.Title = fallback
	}
	return item
}

// flattenMenuItems checks a requested tree and turns it into the reading-order
// list ReplaceMenuItemsTx stores. Errors are messages for a 400.
func flattenMenuItems(items []MenuItemRequest) ([]db.MenuItemInput, error) {
	out := make([]db.MenuItemInput, 0, len(items))
	for i, item := range items {
		input, err := menuItemInput(item, fmt.Sprintf("items[%d]", i))
		if err != nil {
			return nil, err
		}
		input.ParentIndex = -1
		parent := len(out)
		out = append(out, input)

		for j, child := range item.Children {
			field := fmt.Sprintf("items[%d].children[%d]", i, j)
			if len(child.Children) > 0 {
				return nil, fmt.Errorf("%s: menus nest one level deep", field)
			}
			childInput, err := menuItemInput(child, field)
			if err != nil {
				return nil, err
			}
			childInput.ParentIndex = parent
			out = append(out, childInput)
		}
		if len(out) > maxMenuItems {
			return nil, fmt.Errorf("a menu holds at most %d items", maxMenuItems)
		}
	}
	return out, nil
}

func menuItemInput(item MenuItemRequest, field string) (db.MenuItemInput, error) {
	input := db.MenuItemInput{ItemType: item.Type, Label: strings.TrimSpace(item.Label)}
	targetOnly := func(want string) error {
		fields := []struct {
			name string
			set  bool
		}{{"target_id", item.TargetID != 0}, {"post_type", item.PostType != ""}, {"url", item.URL != ""}}
		found := false
		for _, f := range fields {
			if f.set && f.name != want {
				return fmt.Errorf("%s.%s: not used by a %s item", field, f.name, item.Type)
			}
			found = found || (f.set && f.name == want)
		}
		if !found {
			return fmt.Errorf("%s.%s is required for a %s item", field, want, item.Type)
		}
		return nil
	}

	switch item.Type {
	case "post":
		if err := targetOnly("target_id"); err != nil {
			return input, err
		}
		input.PostID = sql.NullInt64{Int64: item.TargetID, Valid: true}
	case "term":
		if err := targetOnly("target_id"); err != nil {
			return input, err
		}
		input.TermID = sql.NullInt64{Int64: item.TargetID, Valid: true}
	case "archive":
		if err := targetOnly("post_type"); err != nil {
			return input, err
		}
		input.PostType = sql.NullString{String: item.PostType, Valid: true}
	case "custom":
		if err := targetOnly("url"); err != nil {
			return input, err
		}
		if !validMenuURL(item.URL) {
			return input, fmt.Errorf("%s.url must be an http(s) URL or a path starting with /", field)
		}
		if input.Label == "" {
			return input, fmt.Errorf("%s.label is required for a custom link", field)
		}
		input.Url = item.URL
	default:
		return input, fmt.Errorf("%s.type is not a menu item type", field)
	}
	return input, nil
}

func isForeignKeyViolation(err error) bool {
	return err != nil && strings.Contains(err.Error(), "violates foreign key constraint")
}
