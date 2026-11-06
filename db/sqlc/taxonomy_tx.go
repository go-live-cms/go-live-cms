package db

import (
	"context"
	"errors"
	"fmt"
)

// One category per post, the default category and merges (#331, 000047).

// CategoryTaxonomy is the taxonomy whose terms are a post's one category, in its URL
// under the category structure, with a default term.
const CategoryTaxonomy = "category"

var (
	// ErrDefaultTerm: the taxonomy's default term can't be deleted or merged away.
	ErrDefaultTerm = errors.New("the default term can't be removed")
	// ErrMergeSource: a merge source isn't a term of the target's taxonomy, or is the
	// target itself.
	ErrMergeSource = errors.New("invalid merge source")
)

type SetPostTermTxParams struct {
	PostID int64
	TermID int64
}

// SetPostTermTxResult says which categories the new one replaced.
type SetPostTermTxResult struct {
	ReplacedTermIDs []int64
}

// SetPostTermTx links a term to a post (idempotent). A category replaces the post's
// other category: a post has one.
func (store *SQLStore) SetPostTermTx(ctx context.Context, arg SetPostTermTxParams) (SetPostTermTxResult, error) {
	var result SetPostTermTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		if _, err := q.LockPostForTerms(ctx, arg.PostID); err != nil {
			return err
		}
		replaced, err := q.RemovePostCategoriesExcept(ctx, RemovePostCategoriesExceptParams{PostID: arg.PostID, KeepTermID: arg.TermID})
		if err != nil {
			return err
		}
		result.ReplacedTermIDs = replaced
		return q.LinkPostTerm(ctx, LinkPostTermParams{PostID: arg.PostID, TaxonomyTermID: arg.TermID})
	})
	if result.ReplacedTermIDs == nil {
		result.ReplacedTermIDs = []int64{}
	}
	return result, err
}

// RemovePostTermTx unlinks a term from a post (idempotent). A post of type "post"
// left without a category gets the default one back: removing its category means
// "no particular category". Returns the default category's id when it was put back.
func (store *SQLStore) RemovePostTermTx(ctx context.Context, arg SetPostTermTxParams) (int64, error) {
	var defaultID int64
	err := store.execTx(ctx, func(q *Queries) error {
		if _, err := q.LockPostForTerms(ctx, arg.PostID); err != nil {
			return err
		}
		if err := q.RemovePostFromTaxonomyTerm(ctx, RemovePostFromTaxonomyTermParams{PostID: arg.PostID, TaxonomyTermID: arg.TermID}); err != nil {
			return err
		}
		added, err := q.EnsureDefaultCategory(ctx, []int64{arg.PostID})
		if err != nil {
			return err
		}
		if added > 0 {
			category, err := q.GetTaxonomyType(ctx, CategoryTaxonomy)
			if err != nil {
				return err
			}
			defaultID = category.DefaultTermID.Int64
		}
		return nil
	})
	return defaultID, err
}

type UpdateTaxonomyTermTxParams struct {
	UpdateTaxonomyTermParams
	// Redirect is the old archive URL to the new one, when the slug changed; nil for
	// none.
	Redirect *AddRedirectParams
}

// UpdateTaxonomyTermTx saves a term and, with its slug change, the redirect from its
// old URL, together.
func (store *SQLStore) UpdateTaxonomyTermTx(ctx context.Context, arg UpdateTaxonomyTermTxParams) (TaxonomyTerm, error) {
	var term TaxonomyTerm
	err := store.execTx(ctx, func(q *Queries) error {
		var err error
		if term, err = q.UpdateTaxonomyTerm(ctx, arg.UpdateTaxonomyTermParams); err != nil {
			return err
		}
		_, err = addRedirects(ctx, q, []*AddRedirectParams{arg.Redirect})
		return err
	})
	return term, err
}

type MergeTaxonomyTermsTxParams struct {
	TargetID  int64
	SourceIDs []int64
	// Redirects from each source's archive URL to the target's (nil entries: none, a
	// taxonomy without public pages).
	Redirects []*AddRedirectParams
}

type MergeTaxonomyTermsTxResult struct {
	Target     TaxonomyTerm
	MergedIDs  []int64
	MovedPosts int64
	Redirects  []Redirect
}

// MergeTaxonomyTermsTx merges sources into target: every post with a source gets the
// target (the working set; and the published set and pending scheduled updates, so
// the site follows at once), the sources are deleted, and each source's URL
// redirects to the target's. Sources must be other terms of the target's taxonomy
// (ErrMergeSource) and not its default term (ErrDefaultTerm).
func (store *SQLStore) MergeTaxonomyTermsTx(ctx context.Context, arg MergeTaxonomyTermsTxParams) (MergeTaxonomyTermsTxResult, error) {
	var result MergeTaxonomyTermsTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		target, err := q.GetTaxonomyTerm(ctx, arg.TargetID)
		if err != nil {
			return err
		}
		taxonomy, err := q.GetTaxonomyTypeByID(ctx, target.TaxonomyTypeID)
		if err != nil {
			return err
		}
		result.Target = target
		seen := map[int64]bool{}
		for _, sourceID := range arg.SourceIDs {
			if seen[sourceID] {
				continue
			}
			seen[sourceID] = true
			source, err := q.GetTaxonomyTerm(ctx, sourceID)
			if err != nil {
				return fmt.Errorf("merge source %d: %w", sourceID, err)
			}
			if source.ID == target.ID || source.TaxonomyTypeID != target.TaxonomyTypeID {
				return ErrMergeSource
			}
			if taxonomy.DefaultTermID.Valid && taxonomy.DefaultTermID.Int64 == source.ID {
				return ErrDefaultTerm
			}
			moved, err := q.CountPostsByTaxonomyTerm(ctx, source.ID)
			if err != nil {
				return err
			}
			if _, err := q.ReassignTermPosts(ctx, ReassignTermPostsParams{TargetID: target.ID, SourceID: source.ID}); err != nil {
				return err
			}
			replace := ReplaceTermInPublishedSettingsParams{SourceID: source.ID, TargetID: target.ID}
			if _, err := q.ReplaceTermInPublishedSettings(ctx, replace); err != nil {
				return err
			}
			if _, err := q.ReplaceTermInScheduledUpdates(ctx, ReplaceTermInScheduledUpdatesParams(replace)); err != nil {
				return err
			}
			// Links left are posts that had both: they keep the target.
			if err := q.RemoveAllPostTaxonomiesByTerm(ctx, source.ID); err != nil {
				return err
			}
			if err := q.DeleteTaxonomyTerm(ctx, source.ID); err != nil {
				return err
			}
			result.MergedIDs = append(result.MergedIDs, source.ID)
			result.MovedPosts += moved
		}
		result.Redirects, err = addRedirects(ctx, q, arg.Redirects)
		return err
	})
	return result, err
}
