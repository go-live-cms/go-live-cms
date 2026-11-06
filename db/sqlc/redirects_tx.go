package db

import (
	"context"
	"database/sql"
	"errors"
)

// Redirects (#331, 000047). One row per old site path (from_path); to_path is a site
// path or an absolute http(s) URL. The public site asks for a path only when it would
// otherwise answer 404, so a redirect never hides a live page.
//
// The table is kept collapsed: no row's to_path is another row's from_path, so every
// redirect is one hop and there are no loops. addRedirect keeps it so:
//   - rows pointing at the new from_path follow it to the new target (A→B, then B→C
//     makes A→C);
//   - an automatic redirect (a slug change) points at a URL that is live again, so a
//     row from that URL is dropped (renaming a post back and forth leaves one row);
//   - a manual redirect to a path that itself redirects goes to that path's target,
//     and one that would end where it starts is ErrRedirectLoop.
// Writes take one advisory lock, so two can't build a chain between them.

// Who made a redirect (redirects.source).
const (
	RedirectSourceManual = "manual"
	RedirectSourcePost   = "post"
	RedirectSourceTerm   = "term"
	RedirectSourceMerge  = "merge"
)

var (
	// ErrRedirectLoop: the redirect would lead back to its own path.
	ErrRedirectLoop = errors.New("redirect would loop")
	// ErrRedirectExists: a manual redirect from a path that already redirects.
	ErrRedirectExists = errors.New("path already redirects")
)

// AddRedirectParams is one redirect to add. Paths are already normalized by the API.
type AddRedirectParams struct {
	FromPath   string
	ToPath     string
	StatusCode int32
	Source     string
	// CreatedBy is the member who made it; 0 = nobody (the system).
	CreatedBy int64
}

// AddRedirectTx adds one redirect (Settings › URLs & redirects).
func (store *SQLStore) AddRedirectTx(ctx context.Context, arg AddRedirectParams) (Redirect, error) {
	var redirect Redirect
	err := store.execTx(ctx, func(q *Queries) error {
		var err error
		redirect, err = addRedirect(ctx, q, arg)
		return err
	})
	return redirect, err
}

// addRedirect adds arg inside the caller's transaction; see the header.
func addRedirect(ctx context.Context, q *Queries, arg AddRedirectParams) (Redirect, error) {
	if err := q.LockRedirects(ctx); err != nil {
		return Redirect{}, err
	}
	if arg.StatusCode == 0 {
		arg.StatusCode = 301
	}
	manual := arg.Source == RedirectSourceManual
	to := arg.ToPath
	if manual {
		if _, err := q.GetRedirectByFromPath(ctx, arg.FromPath); err == nil {
			return Redirect{}, ErrRedirectExists
		} else if !errors.Is(err, sql.ErrNoRows) {
			return Redirect{}, err
		}
		// One hop: a target that redirects is replaced by where it goes.
		next, err := q.GetRedirectByFromPath(ctx, to)
		if err == nil {
			to = next.ToPath
		} else if !errors.Is(err, sql.ErrNoRows) {
			return Redirect{}, err
		}
	} else if _, err := q.DeleteRedirectFromPath(ctx, to); err != nil {
		// The new URL is live: an old redirect from it is stale.
		return Redirect{}, err
	}
	if to == arg.FromPath {
		return Redirect{}, ErrRedirectLoop
	}
	if _, err := q.RetargetRedirects(ctx, RetargetRedirectsParams{NewTo: to, OldTo: arg.FromPath}); err != nil {
		return Redirect{}, err
	}
	createdBy := sql.NullInt64{Int64: arg.CreatedBy, Valid: arg.CreatedBy != 0}
	if manual {
		return q.InsertRedirect(ctx, InsertRedirectParams{
			FromPath: arg.FromPath, ToPath: to, StatusCode: arg.StatusCode, Source: arg.Source, CreatedBy: createdBy,
		})
	}
	return q.UpsertRedirect(ctx, UpsertRedirectParams{
		FromPath: arg.FromPath, ToPath: to, StatusCode: arg.StatusCode, Source: arg.Source, CreatedBy: createdBy,
	})
}

// addRedirects adds each of redirects (nil ones skipped).
func addRedirects(ctx context.Context, q *Queries, redirects []*AddRedirectParams) ([]Redirect, error) {
	var added []Redirect
	for _, r := range redirects {
		if r == nil {
			continue
		}
		redirect, err := addRedirect(ctx, q, *r)
		if err != nil {
			return nil, err
		}
		added = append(added, redirect)
	}
	return added, nil
}
