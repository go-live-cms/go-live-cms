package api

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"

	"github.com/sqlc-dev/pqtype"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/importer"
)

// The importer's terms (#150): the export's categories and tags, made once per job before
// its posts (import_worker.go, ensureTerms). A term that already exists in the same
// taxonomy with the same slug is reused, so running a file again makes no new terms.
// Categories nest one level here (#331): a deeper WordPress category goes under its
// top-level ancestor, as 000047 did for older data. Term slugs are unique across every
// taxonomy, so a tag whose slug a category has gets "-2" (and so on); a category slug that
// is another route's first segment gets "-category". Other taxonomies aren't imported.

// maxTermSlugTries bounds the "-2", "-3" … suffixes tried for one term.
const maxTermSlugTries = 20

// importTerms fills ids ("<taxonomy>:<export slug>" → term id) and categorySlugs (category
// id → its slug here).
func (server *Server) importTerms(ctx context.Context, terms []importer.Term, ids map[string]int64, categorySlugs map[int64]string) error {
	types := map[string]db.TaxonomyType{}
	for _, name := range []string{db.CategoryTaxonomy, "tag"} {
		t, err := server.store.GetTaxonomyType(ctx, name)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		types[name] = t
	}
	bySlug := map[string]importer.Term{}
	for _, t := range terms {
		if t.Taxonomy == db.CategoryTaxonomy {
			bySlug[t.Slug] = t
		}
	}
	// A category's top-level ancestor (itself when it has none); a loop ends at the
	// category where it was found.
	topOf := func(t importer.Term) string {
		seen := map[string]bool{t.Slug: true}
		cur := t
		for cur.Parent != "" {
			parent, ok := bySlug[cur.Parent]
			if !ok || seen[parent.Slug] {
				break
			}
			seen[parent.Slug] = true
			cur = parent
		}
		return cur.Slug
	}
	ordered := make([]importer.Term, 0, len(terms))
	for _, t := range terms {
		if t.Taxonomy == db.CategoryTaxonomy && topOf(t) == t.Slug {
			ordered = append(ordered, t)
		}
	}
	for _, t := range terms {
		if t.Taxonomy != db.CategoryTaxonomy || topOf(t) != t.Slug {
			ordered = append(ordered, t)
		}
	}
	for _, t := range ordered {
		taxonomy, ok := types[t.Taxonomy]
		if !ok || t.Slug == "" {
			continue
		}
		key := t.Taxonomy + ":" + t.Slug
		if _, done := ids[key]; done {
			continue
		}
		parent := sql.NullInt64{}
		if t.Taxonomy == db.CategoryTaxonomy {
			if top := topOf(t); top != t.Slug {
				if id, ok := ids[db.CategoryTaxonomy+":"+top]; ok {
					parent = sql.NullInt64{Int64: id, Valid: true}
				}
			}
		}
		term, err := server.importTerm(ctx, taxonomy, t, parent)
		if err != nil {
			return fmt.Errorf("term %q: %w", t.Slug, err)
		}
		ids[key] = term.ID
		if t.Taxonomy == db.CategoryTaxonomy {
			categorySlugs[term.ID] = term.Slug
		}
	}
	return nil
}

// importTerm finds the term (same taxonomy, same slug, a suffix tried when another
// taxonomy has it) or makes it.
func (server *Server) importTerm(ctx context.Context, taxonomy db.TaxonomyType, t importer.Term, parent sql.NullInt64) (db.TaxonomyTerm, error) {
	base := generateSlug(importer.Slugify(t.Slug))
	if base == "" {
		base = generateSlug(importer.Slugify(t.Name))
	}
	if base == "" {
		base = "term"
	}
	if taxonomy.Name == db.CategoryTaxonomy {
		reserved := reservedCategorySlugs[base]
		if !reserved {
			taken, err := server.store.IsPostTypeOrTaxonomyName(ctx, base)
			if err != nil {
				return db.TaxonomyTerm{}, err
			}
			reserved = taken
		}
		if reserved {
			base += "-category"
		}
	}
	name := strings.TrimSpace(t.Name)
	if name == "" {
		name = t.Slug
	}
	name = truncateRunes(name, 200)
	for try := 1; try <= maxTermSlugTries; try++ {
		slug := base
		if try > 1 {
			slug = fmt.Sprintf("%s-%d", base, try)
		}
		existing, err := server.store.GetTaxonomyTermBySlug(ctx, slug)
		if err == nil {
			if existing.TaxonomyTypeName == taxonomy.Name {
				return db.TaxonomyTerm{ID: existing.ID, Slug: existing.Slug, Name: existing.Name}, nil
			}
			continue // another taxonomy has it
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return db.TaxonomyTerm{}, err
		}
		term, err := server.store.CreateTaxonomyTerm(ctx, db.CreateTaxonomyTermParams{
			Name:           name,
			Slug:           slug,
			Description:    sql.NullString{String: truncateRunes(strings.TrimSpace(t.Description), 500), Valid: true},
			ParentID:       parent,
			TaxonomyTypeID: taxonomy.ID,
			SortOrder:      sql.NullInt32{Int32: 0, Valid: true},
			Meta:           pqtype.NullRawMessage{RawMessage: []byte(`{}`), Valid: true},
		})
		if err == nil {
			return term, nil
		}
		if !isUniqueViolation(err) {
			return db.TaxonomyTerm{}, err
		}
		// Taken meanwhile: the same term if it's this taxonomy's, else the next suffix.
		if existing, err := server.store.GetTaxonomyTermBySlug(ctx, slug); err == nil && existing.TaxonomyTypeName == taxonomy.Name {
			return db.TaxonomyTerm{ID: existing.ID, Slug: existing.Slug, Name: existing.Name}, nil
		}
	}
	return db.TaxonomyTerm{}, errors.New("no free slug")
}

// nullJSON is a non-null jsonb value.
func nullJSON(b []byte) pqtype.NullRawMessage {
	return pqtype.NullRawMessage{RawMessage: b, Valid: true}
}
