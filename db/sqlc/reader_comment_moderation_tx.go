package db

import (
	"context"
	"database/sql"
	"errors"
	"slices"
	"time"
)

// Moderation of reader comments (#526, docs/design/reader-comments.md 4.1, 4.4, 3.4).

// The moderator's status actions on one comment (PUT /discussion/comments/:id/status and
// the bulk route). Delete permanently is DeleteReaderCommentTx, from spam or trash only.
const (
	ReaderCommentActionApprove   = "approve"
	ReaderCommentActionUnapprove = "unapprove"
	ReaderCommentActionSpam      = "spam"
	ReaderCommentActionNotSpam   = "not_spam"
	ReaderCommentActionTrash     = "trash"
	ReaderCommentActionRestore   = "restore"
)

// The held_reason a moderator's change leaves (16.1): a moderator's Spam is the
// "moderator" spam route, and Not spam sends a comment back to Pending held as
// "previous_spam", never with its old spam route.
const (
	ReaderCommentRouteModerator   = "moderator"
	ReaderCommentHeldPreviousSpam = "previous_spam"
)

// readerCommentTransitions is which statuses each action leaves from (4.1, 16.1: the
// queue's row actions). Not spam goes back to Pending, never straight to the page.
var readerCommentTransitions = map[string][]string{
	ReaderCommentActionApprove:   {ReaderCommentPending},
	ReaderCommentActionUnapprove: {ReaderCommentApproved},
	ReaderCommentActionSpam:      {ReaderCommentPending, ReaderCommentApproved},
	ReaderCommentActionNotSpam:   {ReaderCommentSpam},
	ReaderCommentActionTrash:     {ReaderCommentPending, ReaderCommentApproved, ReaderCommentSpam},
	ReaderCommentActionRestore:   {ReaderCommentTrash},
}

// ReaderCommentActionAllowedFrom reports whether action applies to a comment in status.
func ReaderCommentActionAllowedFrom(action, status string) bool {
	return slices.Contains(readerCommentTransitions[action], status)
}

// IsReaderCommentAction reports whether action is one of the status actions.
func IsReaderCommentAction(action string) bool {
	_, ok := readerCommentTransitions[action]
	return ok
}

// ErrReaderCommentStatusChanged: the comment isn't in a status the action applies to
// (someone else moderated it meanwhile, or it is a tombstone).
var ErrReaderCommentStatusChanged = errors.New("the comment's status changed")

// ModerateReaderCommentTxParams is one moderator's action on one comment.
type ModerateReaderCommentTxParams struct {
	ID          int64
	Action      string
	ModeratorID int64
}

// ModerateReaderCommentTxResult is the comment before and after.
type ModerateReaderCommentTxResult struct {
	Before ReaderComment
	After  ReaderComment
}

// ModerateReaderCommentTx applies a status action (approve, unapprove, spam, not spam,
// trash, restore). The comment's thread (its root and parent) is share-locked first, so
// the retention job (SKIP LOCKED) and a delete (FOR UPDATE) can't cascade a reply away
// while it is approved (api/CLAUDE.md); then the row itself, FOR UPDATE, is checked
// against the action. A moderator's Spam also stamps the commenter's last_spam_at (4.2
// previous_spam). sql.ErrNoRows: no such comment (or unconfirmed: not moderated);
// ErrReaderCommentStatusChanged: not in a status the action leaves from.
func (store *SQLStore) ModerateReaderCommentTx(ctx context.Context, arg ModerateReaderCommentTxParams) (ModerateReaderCommentTxResult, error) {
	var result ModerateReaderCommentTxResult
	from, ok := readerCommentTransitions[arg.Action]
	if !ok {
		return result, ErrReaderCommentStatusChanged
	}
	err := store.execTx(ctx, func(q *Queries) error {
		var err error
		result, err = applyReaderCommentAction(ctx, q, arg.ID, arg.Action, from, arg.ModeratorID)
		return err
	})
	return result, err
}

// applyReaderCommentAction is ModerateReaderCommentTx's body, shared with the member's
// "Approve and reply" (CreateMemberReaderCommentTx), which approves the parent first.
func applyReaderCommentAction(ctx context.Context, q *Queries, id int64, action string, from []string, moderatorID int64) (ModerateReaderCommentTxResult, error) {
	var result ModerateReaderCommentTxResult
	current, err := q.GetReaderComment(ctx, id)
	if err != nil {
		return result, err
	}
	if current.Status == ReaderCommentUnconfirmed {
		return result, sql.ErrNoRows
	}
	if err := shareLockReaderCommentThread(ctx, q, current); err != nil {
		return result, err
	}
	locked, err := q.LockReaderComment(ctx, id)
	if err != nil {
		return result, err
	}
	if locked.RemovedAt.Valid || !slices.Contains(from, locked.Status) {
		return result, ErrReaderCommentStatusChanged
	}
	result.Before = locked
	moderator := sql.NullInt64{Int64: moderatorID, Valid: moderatorID != 0}
	switch action {
	case ReaderCommentActionTrash:
		result.After, err = q.TrashReaderComment(ctx, TrashReaderCommentParams{ID: id, ModeratedBy: moderator})
	case ReaderCommentActionRestore:
		result.After, err = q.RestoreReaderComment(ctx, RestoreReaderCommentParams{ID: id, ModeratedBy: moderator})
	default:
		arg := ModerateReaderCommentParams{ID: id, FromStatuses: from, ModeratedBy: moderator}
		switch action {
		case ReaderCommentActionApprove:
			arg.Status = ReaderCommentApproved
		case ReaderCommentActionUnapprove:
			arg.Status = ReaderCommentPending
		case ReaderCommentActionSpam:
			arg.Status = ReaderCommentSpam
			arg.HeldReason = sql.NullString{String: ReaderCommentRouteModerator, Valid: true}
		case ReaderCommentActionNotSpam:
			arg.Status = ReaderCommentPending
			arg.HeldReason = sql.NullString{String: ReaderCommentHeldPreviousSpam, Valid: true}
		}
		result.After, err = q.ModerateReaderComment(ctx, arg)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return result, ErrReaderCommentStatusChanged
	}
	if err != nil {
		return result, err
	}
	if action == ReaderCommentActionSpam && locked.CommenterID.Valid {
		if err := q.MarkCommenterSpammed(ctx, locked.CommenterID.Int64); err != nil {
			return result, err
		}
	}
	return result, nil
}

// shareLockReaderCommentThread takes a reply's root and parent FOR SHARE (whatever their
// status), before the reply's own row: the order DeleteReaderCommentTx uses, so the two
// never deadlock. A parent already gone (ON DELETE SET NULL) is fine.
func shareLockReaderCommentThread(ctx context.Context, q *Queries, c ReaderComment) error {
	ids := []sql.NullInt64{c.RootID}
	if c.ParentID != c.RootID {
		ids = append(ids, c.ParentID)
	}
	for _, id := range ids {
		if !id.Valid {
			continue
		}
		if _, err := q.LockReaderCommentForShare(ctx, id.Int64); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
	}
	return nil
}

// CreateMemberReaderCommentTxParams is a member's comment or reply from Discussion (3.4).
type CreateMemberReaderCommentTxParams struct {
	PostID   int64
	ParentID sql.NullInt64
	AuthorID int64
	// DisplayName is the member's name as posted (a removed member's comment keeps it).
	DisplayName string
	Body        string
}

// CreateMemberReaderCommentTxResult is the new comment, and the parent when replying
// approved it first (ParentApproved: it was pending).
type CreateMemberReaderCommentTxResult struct {
	Comment        ReaderComment
	Parent         *ReaderComment
	ParentApproved bool
}

// CreateMemberReaderCommentTx stores a member's comment, approved at once (members are
// moderators). A reply goes under a comment of the same post that is approved or
// pending; a pending one is approved first, in the same transaction (4.4: a reply under
// a hidden comment would show alone). Anything else (spam, trash, a tombstone, another
// post's, gone) is ErrReaderCommentParentGone, and nothing is written.
func (store *SQLStore) CreateMemberReaderCommentTx(ctx context.Context, arg CreateMemberReaderCommentTxParams) (CreateMemberReaderCommentTxResult, error) {
	var result CreateMemberReaderCommentTxResult
	err := store.execTx(ctx, func(q *Queries) error {
		var rootID sql.NullInt64
		if arg.ParentID.Valid {
			parent, err := q.GetReaderComment(ctx, arg.ParentID.Int64)
			if errors.Is(err, sql.ErrNoRows) {
				return ErrReaderCommentParentGone
			}
			if err != nil {
				return err
			}
			if parent.PostID != arg.PostID || parent.RemovedAt.Valid {
				return ErrReaderCommentParentGone
			}
			switch parent.Status {
			case ReaderCommentPending:
				approved, err := applyReaderCommentAction(ctx, q, parent.ID, ReaderCommentActionApprove, readerCommentTransitions[ReaderCommentActionApprove], arg.AuthorID)
				if errors.Is(err, ErrReaderCommentStatusChanged) || errors.Is(err, sql.ErrNoRows) {
					return ErrReaderCommentParentGone
				}
				if err != nil {
					return err
				}
				parent = approved.After
				result.ParentApproved = true
			case ReaderCommentApproved:
				if err := shareLockReaderCommentThread(ctx, q, parent); err != nil {
					return err
				}
				locked, err := q.LockReaderCommentForShare(ctx, parent.ID)
				if errors.Is(err, sql.ErrNoRows) {
					return ErrReaderCommentParentGone
				}
				if err != nil {
					return err
				}
				if locked.Status != ReaderCommentApproved || locked.RemovedAt.Valid {
					return ErrReaderCommentParentGone
				}
				parent = locked
			default:
				return ErrReaderCommentParentGone
			}
			result.Parent = &parent
			rootID = parent.RootID
			if !rootID.Valid {
				rootID = sql.NullInt64{Int64: parent.ID, Valid: true}
			}
		}
		comment, err := q.CreateReaderComment(ctx, CreateReaderCommentParams{
			PostID:       arg.PostID,
			ParentID:     arg.ParentID,
			RootID:       rootID,
			AuthorUserID: sql.NullInt64{Int64: arg.AuthorID, Valid: true},
			DisplayName:  arg.DisplayName,
			Body:         arg.Body,
			Status:       ReaderCommentApproved,
			ApprovedAt:   sql.NullTime{Time: time.Now(), Valid: true},
		})
		result.Comment = comment
		return err
	})
	return result, err
}
