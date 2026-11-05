package db

import (
	"context"
	"database/sql"
	"errors"
)

// Edit access requests (#321, 000040): post_access_requests.status.
const (
	AccessRequestPending  = "pending"
	AccessRequestGranted  = "granted"
	AccessRequestDeclined = "declined"
)

// ErrAccessRequestAnswered means the request was already granted or declined
// (by someone else, meanwhile): nothing was written.
var ErrAccessRequestAnswered = errors.New("the access request was already answered")

type ReviewPostAccessRequestTxParams struct {
	RequestID int64
	// ReviewerID answers it (reviewed_by; and granted_by on a grant).
	ReviewerID int64
	// Grant: true grants edit access (post_collaborators), false declines.
	Grant bool
}

// ReviewPostAccessRequestTx answers an open request in one transaction: the
// UPDATE claims it (only while pending, so two reviewers answering at once
// can't both win: the second waits on the row lock and then finds it answered,
// ErrAccessRequestAnswered), and a grant adds the requester to the post's
// collaborators. sql.ErrNoRows is never returned: a missing request is
// ErrAccessRequestAnswered too, so the caller looks the request up first.
func (store *SQLStore) ReviewPostAccessRequestTx(ctx context.Context, arg ReviewPostAccessRequestTxParams) (PostAccessRequest, error) {
	var request PostAccessRequest
	err := store.execTx(ctx, func(q *Queries) error {
		status := AccessRequestDeclined
		if arg.Grant {
			status = AccessRequestGranted
		}
		reviewer := sql.NullInt64{Int64: arg.ReviewerID, Valid: arg.ReviewerID > 0}
		var err error
		request, err = q.ReviewPostAccessRequest(ctx, ReviewPostAccessRequestParams{
			ID:         arg.RequestID,
			Status:     status,
			ReviewedBy: reviewer,
		})
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrAccessRequestAnswered
			}
			return err
		}
		if !arg.Grant {
			return nil
		}
		return q.GrantPostCollaborator(ctx, GrantPostCollaboratorParams{
			PostID:    request.PostID,
			UserID:    request.RequesterID,
			GrantedBy: reviewer,
		})
	})
	return request, err
}
