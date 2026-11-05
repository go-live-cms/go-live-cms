package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
)

// Review requests (#323) through the real router against the test database
// (skipped without one): who may ask, one open request per post, every way a
// request resolves (publish by each path, dismiss, changes requested), the emails
// and who gets them, the activity events, Home's Needs attention and the posts
// list's indicator and filter.

// reviewServer is a server on the test database with a recording mailer and the
// background work (emails) run inline.
func reviewServer(t *testing.T) (*sql.DB, db.Store, *Server, *recordingMailer) {
	t.Helper()
	conn, store := scheduleTestDB(t)
	server := scheduleServer(t, store, newStubCollab(t, 0))
	rec := &recordingMailer{}
	server.mailer = rec
	server.runInBackground = func(_, _ string, f func()) { f() }
	return conn, store, server, rec
}

type reviewRequestBody struct {
	ReviewRequest *ReviewRequestResponse `json:"review_request"`
	Code          string                 `json:"code"`
}

func decodeReview(t *testing.T, recorder *httptest.ResponseRecorder) reviewRequestBody {
	t.Helper()
	var body reviewRequestBody
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body), recorder.Body.String())
	return body
}

func reviewPath(postID int64) string {
	return fmt.Sprintf("/api/v1/posts/%d/review-request", postID)
}

// requestReviewAs asks for a review of postID as caller and returns the request.
func requestReviewAs(t *testing.T, server *Server, caller db.User, postID int64, body any) ReviewRequestResponse {
	t.Helper()
	recorder := as(t, server, caller, http.MethodPost, reviewPath(postID), body)
	requireStatus(t, recorder, http.StatusCreated)
	rsp := decodeReview(t, recorder)
	require.NotNil(t, rsp.ReviewRequest)
	return *rsp.ReviewRequest
}

type reviewRow struct {
	Status     string
	ResolvedBy sql.NullInt64
	Note       string
}

func loadReviewRow(t *testing.T, conn *sql.DB, id int64) reviewRow {
	t.Helper()
	var row reviewRow
	require.NoError(t, conn.QueryRow(`SELECT status, resolved_by, resolution_note FROM review_requests WHERE id = $1`, id).
		Scan(&row.Status, &row.ResolvedBy, &row.Note))
	return row
}

func openReviewCount(t *testing.T, conn *sql.DB, postID int64) int {
	t.Helper()
	var n int
	require.NoError(t, conn.QueryRow(`SELECT count(*) FROM review_requests WHERE post_id = $1 AND status = 'open'`, postID).Scan(&n))
	return n
}

func mailsTo(msgs []mailer.Message, address string) []mailer.Message {
	var out []mailer.Message
	for _, m := range msgs {
		if m.To == address {
			out = append(out, m)
		}
	}
	return out
}

func TestReviewRequestPermissions(t *testing.T) {
	conn, store, server, _ := reviewServer(t)
	owner := scheduleUser(t, store, RoleContributor)
	other := scheduleUser(t, store, RoleContributor)
	editor := scheduleUser(t, store, RoleEditor)
	reviewer := scheduleUser(t, store, RoleEditor)
	word := scheduleWord()

	draft := scheduleDraft(t, store, owner, word)
	// Someone else's draft: the contributor can't even read it.
	requireStatus(t, as(t, server, other, http.MethodPost, reviewPath(draft.ID), nil), http.StatusForbidden)

	// The named reviewer must be another editor or admin; an unknown id answers the same.
	for _, id := range []int64{other.ID, owner.ID, 1 << 50} {
		recorder := as(t, server, owner, http.MethodPost, reviewPath(draft.ID), gin.H{"reviewer_id": id})
		requireStatus(t, recorder, http.StatusBadRequest)
		require.Equal(t, codeInvalidReviewer, decodeReview(t, recorder).Code)
	}
	selfReview := as(t, server, editor, http.MethodPost, reviewPath(draft.ID), gin.H{"reviewer_id": editor.ID})
	requireStatus(t, selfReview, http.StatusBadRequest)
	require.Equal(t, 0, openReviewCount(t, conn, draft.ID))
	// Unknown fields and an overlong message are refused.
	requireStatus(t, as(t, server, owner, http.MethodPost, reviewPath(draft.ID), gin.H{"reviewer": 1}), http.StatusBadRequest)
	requireStatus(t, as(t, server, owner, http.MethodPost, reviewPath(draft.ID), gin.H{"message": strings.Repeat("x", 1001)}), http.StatusBadRequest)
	// The limit counts the trimmed note.
	padded := scheduleDraft(t, store, owner, scheduleWord())
	requestReviewAs(t, server, owner, padded.ID, gin.H{"message": "  " + strings.Repeat("é", 1000) + "\n\n"})

	// The owner asks, naming a reviewer, with a note.
	created := requestReviewAs(t, server, owner, draft.ID, gin.H{"reviewer_id": reviewer.ID, "message": "  Ready for a look  "})
	require.Equal(t, db.ReviewStatusOpen, created.Status)
	require.Equal(t, "Ready for a look", created.Message)
	require.Equal(t, owner.ID, created.RequestedBy.ID)
	require.Equal(t, owner.Username, created.RequestedBy.Username)
	require.Equal(t, reviewer.ID, created.Reviewer.ID)
	require.Nil(t, created.ResolvedAt)

	// Who sees it: the owner and reviewers; another contributor never (not even on a published post).
	for _, caller := range []db.User{owner, editor, reviewer} {
		recorder := as(t, server, caller, http.MethodGet, reviewPath(draft.ID), nil)
		requireStatus(t, recorder, http.StatusOK)
		require.Equal(t, created.ID, decodeReview(t, recorder).ReviewRequest.ID)
	}
	requireStatus(t, as(t, server, other, http.MethodGet, reviewPath(draft.ID), nil), http.StatusForbidden)

	published := publishedPost(t, store, owner)
	// A contributor edits their published post's working copy, so they may ask too.
	onPublished := requestReviewAs(t, server, owner, published.ID, nil)
	require.Nil(t, onPublished.Reviewer, "no reviewer named = any editor or admin")
	recorder := as(t, server, other, http.MethodGet, reviewPath(published.ID), nil)
	requireStatus(t, recorder, http.StatusOK)
	require.Nil(t, decodeReview(t, recorder).ReviewRequest, "another contributor doesn't see it")
	requireStatus(t, as(t, server, other, http.MethodPost, reviewPath(published.ID), nil), http.StatusForbidden)
	requireStatus(t, as(t, server, other, http.MethodPost, fmt.Sprintf("/api/v1/review-requests/%d/dismiss", onPublished.ID), nil), http.StatusNotFound)

	// A contributor's scheduled post is read-only to them (#147), so no request.
	scheduled := schedulePostAt(t, store, scheduleDraft(t, store, owner, scheduleWord()), editor, time.Now().Add(time.Hour))
	requireStatus(t, as(t, server, owner, http.MethodPost, reviewPath(scheduled.ID), nil), http.StatusForbidden)
	// Editors may ask too (for another editor's look).
	requestReviewAs(t, server, editor, scheduled.ID, gin.H{"reviewer_id": reviewer.ID})

	// Nobody asks for a review of a post in the trash.
	trashed := scheduleDraft(t, store, owner, scheduleWord())
	requireStatus(t, as(t, server, owner, http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d", trashed.ID), nil), http.StatusOK)
	trashedRsp := as(t, server, editor, http.MethodPost, reviewPath(trashed.ID), nil)
	requireStatus(t, trashedRsp, http.StatusConflict)
	require.Equal(t, codePostTrashed, decodeReview(t, trashedRsp).Code)

	requireStatus(t, as(t, server, owner, http.MethodPost, reviewPath(1<<50), nil), http.StatusNotFound)

	// Every route needs a sign-in.
	for _, r := range []struct{ method, path string }{
		{http.MethodGet, reviewPath(draft.ID)},
		{http.MethodPost, reviewPath(draft.ID)},
		{http.MethodGet, "/api/v1/posts/reviewers"},
		{http.MethodPost, fmt.Sprintf("/api/v1/review-requests/%d/dismiss", created.ID)},
		{http.MethodPost, fmt.Sprintf("/api/v1/review-requests/%d/request-changes", created.ID)},
	} {
		requireStatus(t, doJSON(t, server, r.method, r.path, nil, nil), http.StatusUnauthorized)
	}
}

func TestReviewRequestOneOpenPerPost(t *testing.T) {
	conn, store, server, rec := reviewServer(t)
	owner := scheduleUser(t, store, RoleContributor)
	reviewer := scheduleUser(t, store, RoleEditor)
	other := scheduleUser(t, store, RoleEditor)
	post := scheduleDraft(t, store, owner, scheduleWord())

	first := requestReviewAs(t, server, owner, post.ID, gin.H{"reviewer_id": reviewer.ID})
	before := len(rec.messages())

	// A second request while it's open: 409 with the open one, no new row, no email.
	again := as(t, server, owner, http.MethodPost, reviewPath(post.ID), gin.H{"reviewer_id": other.ID})
	requireStatus(t, again, http.StatusConflict)
	body := decodeReview(t, again)
	require.Equal(t, codeReviewAlreadyRequested, body.Code)
	require.Equal(t, first.ID, body.ReviewRequest.ID)
	require.Equal(t, reviewer.ID, body.ReviewRequest.Reviewer.ID, "the open request is unchanged")
	require.Equal(t, 1, openReviewCount(t, conn, post.ID))
	require.Len(t, rec.messages(), before, "nobody is emailed again")

	// Even two at once: the unique index lets one in.
	_, err := store.CreateReviewRequest(context.Background(), db.CreateReviewRequestParams{
		PostID: post.ID, RequestedBy: sql.NullInt64{Int64: owner.ID, Valid: true},
	})
	require.ErrorIs(t, err, sql.ErrNoRows)

	// Withdrawn, a new request (to another reviewer) is fine.
	requireStatus(t, as(t, server, owner, http.MethodPost, fmt.Sprintf("/api/v1/review-requests/%d/dismiss", first.ID), nil), http.StatusOK)
	second := requestReviewAs(t, server, owner, post.ID, gin.H{"reviewer_id": other.ID})
	require.NotEqual(t, first.ID, second.ID)
	require.Equal(t, 1, openReviewCount(t, conn, post.ID))
}

// TestReviewRequestResolvedByEveryPublishPath: the Publish button, Update, bulk
// publish, the scheduler, a scheduled update and a status set through PUT each
// resolve the open request, credited to whoever the version is, with a
// review_resolved event.
func TestReviewRequestResolvedByEveryPublishPath(t *testing.T) {
	conn, store, server, _ := reviewServer(t)
	owner := scheduleUser(t, store, RoleContributor)
	editor := scheduleUser(t, store, RoleEditor)
	scheduler := scheduleUser(t, store, RoleEditor)
	ctx := context.Background()

	requireResolved := func(t *testing.T, requestID, postID int64, by sql.NullInt64) {
		t.Helper()
		row := loadReviewRow(t, conn, requestID)
		require.Equal(t, db.ReviewStatusPublished, row.Status)
		require.Equal(t, by, row.ResolvedBy)
		events := objectEvents(t, conn, db.ActivityObjectPost, postID)
		last := events[len(events)-1]
		for _, e := range events {
			if e.Verb == db.ActivityReviewResolved {
				last = e
			}
		}
		require.Equal(t, db.ActivityReviewResolved, last.Verb, eventVerbs(events))
		require.Equal(t, by, last.Actor)
		require.JSONEq(t, fmt.Sprintf(`{"request_id":%d,"resolution":"published"}`, requestID), last.Payload)
		// The editor's notice is gone.
		recorder := as(t, server, owner, http.MethodGet, reviewPath(postID), nil)
		requireStatus(t, recorder, http.StatusOK)
		require.Nil(t, decodeReview(t, recorder).ReviewRequest)
	}
	byEditor := sql.NullInt64{Int64: editor.ID, Valid: true}

	t.Run("publish button", func(t *testing.T) {
		post := scheduleDraft(t, store, owner, scheduleWord())
		rr := requestReviewAs(t, server, owner, post.ID, nil)
		requireStatus(t, as(t, server, editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", post.ID), nil), http.StatusOK)
		requireResolved(t, rr.ID, post.ID, byEditor)
	})

	t.Run("update of a published post", func(t *testing.T) {
		post := publishedPost(t, store, owner)
		editWorkingCopy(t, conn, post.ID, scheduleWord())
		rr := requestReviewAs(t, server, owner, post.ID, nil)
		requireStatus(t, as(t, server, editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", post.ID), nil), http.StatusOK)
		requireResolved(t, rr.ID, post.ID, byEditor)
	})

	t.Run("bulk publish", func(t *testing.T) {
		post := scheduleDraft(t, store, owner, scheduleWord())
		untouched := scheduleDraft(t, store, owner, scheduleWord())
		rr := requestReviewAs(t, server, owner, post.ID, nil)
		other := requestReviewAs(t, server, owner, untouched.ID, nil)
		recorder := as(t, server, editor, http.MethodPost, "/api/v1/posts/bulk", gin.H{"action": "publish", "ids": []int64{post.ID}})
		requireStatus(t, recorder, http.StatusOK)
		requireResolved(t, rr.ID, post.ID, byEditor)
		require.Equal(t, db.ReviewStatusOpen, loadReviewRow(t, conn, other.ID).Status, "only the published post's request")
	})

	t.Run("scheduled publish", func(t *testing.T) {
		post := scheduleDraft(t, store, owner, scheduleWord())
		rr := requestReviewAs(t, server, owner, post.ID, nil)
		schedulePostAt(t, store, post, scheduler, time.Now().Add(-time.Minute))
		require.GreaterOrEqual(t, server.publishDueScheduledPosts(ctx), 1)
		require.Equal(t, postStatusPublished, reloadPost(t, store, post.ID).PostStatus)
		requireResolved(t, rr.ID, post.ID, sql.NullInt64{Int64: scheduler.ID, Valid: true})
	})

	t.Run("scheduled update", func(t *testing.T) {
		post := publishedPost(t, store, owner)
		editWorkingCopy(t, conn, post.ID, scheduleWord())
		rr := requestReviewAs(t, server, owner, post.ID, nil)
		scheduleUpdateAt(t, store, post.ID, scheduler, time.Now().Add(-time.Second))
		require.GreaterOrEqual(t, server.applyDueScheduledUpdates(ctx), 1)
		requireResolved(t, rr.ID, post.ID, sql.NullInt64{Int64: scheduler.ID, Valid: true})
	})

	t.Run("status set through PUT", func(t *testing.T) {
		post := scheduleDraft(t, store, owner, scheduleWord())
		rr := requestReviewAs(t, server, owner, post.ID, nil)
		requireStatus(t, as(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d", post.ID), gin.H{"post_status": "published"}), http.StatusOK)
		// No new version, so nobody to credit.
		requireResolved(t, rr.ID, post.ID, sql.NullInt64{})
	})

	t.Run("restoring a published post from the trash leaves it open", func(t *testing.T) {
		post := publishedPost(t, store, owner)
		editWorkingCopy(t, conn, post.ID, scheduleWord())
		rr := requestReviewAs(t, server, owner, post.ID, nil)
		path := fmt.Sprintf("/api/v1/posts/%d", post.ID)
		requireStatus(t, as(t, server, editor, http.MethodDelete, path, nil), http.StatusOK)
		requireStatus(t, as(t, server, editor, http.MethodPost, path+"/restore", nil), http.StatusOK)
		require.Equal(t, postStatusPublished, reloadPost(t, store, post.ID).PostStatus)
		require.Equal(t, db.ReviewStatusOpen, loadReviewRow(t, conn, rr.ID).Status, "the old live version came back, not the reviewed changes")
	})

	t.Run("unpublish and other statuses leave it open", func(t *testing.T) {
		post := publishedPost(t, store, owner)
		rr := requestReviewAs(t, server, owner, post.ID, nil)
		requireStatus(t, as(t, server, editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/unpublish", post.ID), nil), http.StatusOK)
		requireStatus(t, as(t, server, editor, http.MethodPut, fmt.Sprintf("/api/v1/posts/%d", post.ID), gin.H{"post_status": "archived"}), http.StatusOK)
		require.Equal(t, db.ReviewStatusOpen, loadReviewRow(t, conn, rr.ID).Status)
	})
}

func TestReviewRequestDismissAndChangesRequested(t *testing.T) {
	conn, store, server, rec := reviewServer(t)
	owner := scheduleUser(t, store, RoleContributor)
	editor := scheduleUser(t, store, RoleEditor)
	reviewer := scheduleUser(t, store, RoleEditor)
	word := scheduleWord()

	post := scheduleDraft(t, store, owner, word)
	dismissPath := func(id int64) string { return fmt.Sprintf("/api/v1/review-requests/%d/dismiss", id) }
	changesPath := func(id int64) string { return fmt.Sprintf("/api/v1/review-requests/%d/request-changes", id) }

	// The requester withdraws.
	withdrawn := requestReviewAs(t, server, owner, post.ID, nil)
	recorder := as(t, server, owner, http.MethodPost, dismissPath(withdrawn.ID), nil)
	requireStatus(t, recorder, http.StatusOK)
	dismissed := decodeReview(t, recorder).ReviewRequest
	require.Equal(t, db.ReviewStatusDismissed, dismissed.Status)
	// The answer names people like every other one.
	require.Equal(t, owner.Username, dismissed.RequestedBy.Username)
	require.Equal(t, owner.Username, dismissed.ResolvedBy.Username)
	require.Equal(t, sql.NullInt64{Int64: owner.ID, Valid: true}, loadReviewRow(t, conn, withdrawn.ID).ResolvedBy)
	// Resolved: dismissing or asking for changes again is a 409.
	again := as(t, server, editor, http.MethodPost, dismissPath(withdrawn.ID), nil)
	requireStatus(t, again, http.StatusConflict)
	require.Equal(t, codeReviewNotOpen, decodeReview(t, again).Code)
	requireStatus(t, as(t, server, editor, http.MethodPost, changesPath(withdrawn.ID), gin.H{"note": "Too late"}), http.StatusConflict)

	// A reviewer dismisses one; a contributor can't dismiss an editor's request.
	byEditor := requestReviewAs(t, server, editor, post.ID, gin.H{"reviewer_id": reviewer.ID})
	requireStatus(t, as(t, server, owner, http.MethodPost, dismissPath(byEditor.ID), nil), http.StatusForbidden)
	requireStatus(t, as(t, server, reviewer, http.MethodPost, dismissPath(byEditor.ID), nil), http.StatusOK)

	// Changes requested: reviewers only, with a note that isn't blank.
	rr := requestReviewAs(t, server, owner, post.ID, gin.H{"reviewer_id": reviewer.ID})
	before := len(rec.messages())
	requireStatus(t, as(t, server, owner, http.MethodPost, changesPath(rr.ID), gin.H{"note": "Mine"}), http.StatusForbidden)
	requireStatus(t, as(t, server, reviewer, http.MethodPost, changesPath(rr.ID), gin.H{"note": "   "}), http.StatusBadRequest)
	requireStatus(t, as(t, server, reviewer, http.MethodPost, changesPath(rr.ID), gin.H{}), http.StatusBadRequest)
	requireStatus(t, as(t, server, reviewer, http.MethodPost, changesPath(rr.ID), gin.H{"note": strings.Repeat("n", 2001)}), http.StatusBadRequest)
	requireStatus(t, as(t, server, reviewer, http.MethodPost, changesPath(1<<50), gin.H{"note": "x"}), http.StatusNotFound)
	requireStatus(t, as(t, server, reviewer, http.MethodPost, "/api/v1/review-requests/abc/request-changes", gin.H{"note": "x"}), http.StatusBadRequest)

	note := "Tighten the intro " + word + " <b>and</b> fix the title."
	recorder = as(t, server, reviewer, http.MethodPost, changesPath(rr.ID), gin.H{"note": note})
	requireStatus(t, recorder, http.StatusOK)
	got := decodeReview(t, recorder).ReviewRequest
	require.Equal(t, db.ReviewStatusChangesRequested, got.Status)
	require.Equal(t, note, got.ResolutionNote)
	require.Equal(t, reviewer.ID, got.ResolvedBy.ID)

	// The requester is emailed the note, with a link to the post on the real site address.
	msgs := mailsTo(rec.messages()[before:], owner.Email)
	require.Len(t, msgs, 1)
	require.Equal(t, mailer.TemplateReviewChangesRequested, msgs[0].Template)
	require.Contains(t, msgs[0].Text, note)
	require.Contains(t, msgs[0].Text, fmt.Sprintf("%s/gl-admin/content/edit/%d", testPublicBaseURL, post.ID))
	require.Contains(t, msgs[0].HTML, "&lt;b&gt;and&lt;/b&gt;", "the HTML escapes the note")
	require.Len(t, rec.messages(), before+1, "only the requester")

	// The editor's notice keeps showing it until a new request or a publish.
	current := as(t, server, owner, http.MethodGet, reviewPath(post.ID), nil)
	requireStatus(t, current, http.StatusOK)
	shown := decodeReview(t, current).ReviewRequest
	require.Equal(t, rr.ID, shown.ID)
	require.Equal(t, note, shown.ResolutionNote)
	requireStatus(t, as(t, server, editor, http.MethodPost, fmt.Sprintf("/api/v1/posts/%d/publish", post.ID), nil), http.StatusOK)
	current = as(t, server, owner, http.MethodGet, reviewPath(post.ID), nil)
	require.Nil(t, decodeReview(t, current).ReviewRequest)
	require.Equal(t, db.ReviewStatusChangesRequested, loadReviewRow(t, conn, rr.ID).Status, "publishing doesn't rewrite a resolved request")

	// An editor asking for changes on their own request emails nobody.
	self := requestReviewAs(t, server, editor, post.ID, nil)
	before = len(rec.messages())
	requireStatus(t, as(t, server, editor, http.MethodPost, changesPath(self.ID), gin.H{"note": "Note to self"}), http.StatusOK)
	require.Len(t, rec.messages(), before)

	// The events: request, dismissals, changes; ids only, never the notes.
	events := objectEvents(t, conn, db.ActivityObjectPost, post.ID)
	var verbs []string
	for _, e := range events {
		if strings.HasPrefix(e.Verb, "review_") {
			verbs = append(verbs, e.Verb)
			require.NotContains(t, e.Payload, word)
		}
	}
	require.Equal(t, []string{
		"review_requested", "review_dismissed",
		"review_requested", "review_dismissed",
		"review_requested", "review_changes_requested",
		"review_requested", "review_changes_requested",
	}, verbs)
	for _, e := range events {
		switch e.Verb {
		case db.ActivityReviewDismissed:
			if e.Actor.Int64 == owner.ID {
				require.JSONEq(t, fmt.Sprintf(`{"request_id":%d,"withdrawn":true}`, withdrawn.ID), e.Payload)
			} else {
				require.JSONEq(t, fmt.Sprintf(`{"request_id":%d,"withdrawn":false}`, byEditor.ID), e.Payload)
			}
		case db.ActivityReviewChangesRequested:
			if e.Actor.Int64 == reviewer.ID {
				require.JSONEq(t, fmt.Sprintf(`{"request_id":%d}`, rr.ID), e.Payload)
			}
		}
	}
}

func TestReviewRequestEmails(t *testing.T) {
	_, store, server, rec := reviewServer(t)
	owner := scheduleUser(t, store, RoleContributor)
	contributor := scheduleUser(t, store, RoleContributor)
	named := scheduleUser(t, store, RoleEditor)
	editor := scheduleUser(t, store, RoleEditor)
	admin := scheduleUser(t, store, RoleAdmin)
	word := scheduleWord()

	// A named reviewer: one email, to them.
	post := scheduleDraft(t, store, owner, word)
	before := len(rec.messages())
	recorder := as(t, server, owner, http.MethodPost, reviewPath(post.ID), gin.H{"reviewer_id": named.ID, "message": "Please check " + word})
	requireStatus(t, recorder, http.StatusCreated)
	msgs := rec.messages()[before:]
	require.Len(t, msgs, 1)
	require.Equal(t, named.Email, msgs[0].To)
	require.Equal(t, mailer.TemplateReviewRequested, msgs[0].Template)
	require.Contains(t, msgs[0].Subject, "Schedule Tester asked for a review")
	require.Contains(t, msgs[0].Text, "asked you to review")
	require.Contains(t, msgs[0].Text, "Please check "+word)
	link := fmt.Sprintf("%s/gl-admin/content/edit/%d", testPublicBaseURL, post.ID)
	require.Contains(t, msgs[0].Text, link)
	require.Contains(t, msgs[0].HTML, link)
	// The answer names nobody's address.
	for _, u := range []db.User{named, editor, admin} {
		require.NotContains(t, recorder.Body.String(), u.Email)
	}

	// No reviewer named: every editor and admin but the requester, each on their own;
	// never a contributor.
	unnamed := scheduleDraft(t, store, editor, scheduleWord())
	before = len(rec.messages())
	recorder = as(t, server, editor, http.MethodPost, reviewPath(unnamed.ID), nil)
	requireStatus(t, recorder, http.StatusCreated)
	msgs = rec.messages()[before:]
	require.Len(t, mailsTo(msgs, named.Email), 1)
	require.Len(t, mailsTo(msgs, admin.Email), 1)
	require.Empty(t, mailsTo(msgs, editor.Email), "not the requester")
	require.Empty(t, mailsTo(msgs, owner.Email))
	require.Empty(t, mailsTo(msgs, contributor.Email))
	for _, m := range msgs {
		require.NotContains(t, m.To, ",", "one recipient per message")
		require.Contains(t, m.Text, "asked an editor to review")
	}
	for _, u := range []db.User{named, editor, admin} {
		require.NotContains(t, recorder.Body.String(), u.Email)
	}

	// Mail failing changes nothing for the requester: same answer, request stored.
	rec.err = fmt.Errorf("smtp down")
	failing := scheduleDraft(t, store, owner, scheduleWord())
	recorder = as(t, server, owner, http.MethodPost, reviewPath(failing.ID), gin.H{"reviewer_id": named.ID})
	requireStatus(t, recorder, http.StatusCreated)
	require.NotNil(t, decodeReview(t, recorder).ReviewRequest)
	rec.err = nil

	// GET /posts/reviewers lists editors and admins (public fields only) for anyone.
	list := as(t, server, contributor, http.MethodGet, "/api/v1/posts/reviewers", nil)
	requireStatus(t, list, http.StatusOK)
	require.Contains(t, list.Body.String(), named.Username)
	require.Contains(t, list.Body.String(), admin.Username)
	require.NotContains(t, list.Body.String(), contributor.Username)
	require.NotContains(t, list.Body.String(), named.Email)
}

func TestReviewRequestsInNeedsAttention(t *testing.T) {
	conn, store, server, _ := reviewServer(t)
	owner := scheduleUser(t, store, RoleContributor)
	reviewer := scheduleUser(t, store, RoleEditor)
	other := scheduleUser(t, store, RoleEditor)
	demoted := scheduleUser(t, store, RoleEditor)

	assigned := scheduleDraft(t, store, owner, scheduleWord())
	toReviewer := requestReviewAs(t, server, owner, assigned.ID, gin.H{"reviewer_id": reviewer.ID})
	open := scheduleDraft(t, store, owner, scheduleWord())
	toAnyone := requestReviewAs(t, server, owner, open.ID, nil)
	orphan := scheduleDraft(t, store, owner, scheduleWord())
	toDemoted := requestReviewAs(t, server, owner, orphan.ID, gin.H{"reviewer_id": demoted.ID})
	_, err := conn.Exec(`UPDATE users SET role = 'contributor' WHERE id = $1`, demoted.ID)
	require.NoError(t, err)
	mine := scheduleDraft(t, store, reviewer, scheduleWord())
	ownRequest := requestReviewAs(t, server, reviewer, mine.ID, gin.H{"reviewer_id": other.ID})
	trashed := scheduleDraft(t, store, owner, scheduleWord())
	inTrash := requestReviewAs(t, server, owner, trashed.ID, nil)
	requireStatus(t, as(t, server, owner, http.MethodDelete, fmt.Sprintf("/api/v1/posts/%d", trashed.ID), nil), http.StatusOK)

	get := func(caller db.User) (NeedsAttentionResponse, string) {
		t.Helper()
		recorder := as(t, server, caller, http.MethodGet, "/api/v1/home/needs-attention", nil)
		requireStatus(t, recorder, http.StatusOK)
		var rsp NeedsAttentionResponse
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
		return rsp, recorder.Body.String()
	}
	// Needs attention shows five at most, theirs first then the oldest: shared test
	// data may push unassigned ones off, so look at the query's rows directly too.
	ids := func(caller db.User) map[int64]bool {
		t.Helper()
		rows, err := store.ListReviewRequestsForReviewer(context.Background(), db.ListReviewRequestsForReviewerParams{
			ViewerID: caller.ID, ReviewerRoles: reviewerRoles, RowLimit: 10000,
		})
		require.NoError(t, err)
		seen := map[int64]bool{}
		for _, row := range rows {
			seen[row.ID] = true
		}
		return seen
	}

	rsp, body := get(reviewer)
	require.NotNil(t, rsp.ReviewRequests, body)
	require.NotEmpty(t, rsp.ReviewRequests.Posts)
	first := rsp.ReviewRequests.Posts[0]
	require.Equal(t, toReviewer.ID, first.ID, "the one naming them comes first")
	require.True(t, first.Assigned)
	require.Equal(t, assigned.ID, first.PostID)
	require.Equal(t, assigned.Title, first.Title)
	require.Equal(t, owner.ID, first.RequestedBy.ID)
	require.Equal(t, owner.FullName, first.RequestedBy.FullName)
	require.GreaterOrEqual(t, rsp.ReviewRequests.Total, int64(3))

	seen := ids(reviewer)
	require.True(t, seen[toAnyone.ID], "a request naming nobody")
	require.True(t, seen[toDemoted.ID], "a request naming someone who can't review any more")
	require.False(t, seen[ownRequest.ID], "never their own")
	require.False(t, seen[inTrash.ID], "never a post in the trash")

	seen = ids(other)
	require.False(t, seen[toReviewer.ID], "not a request naming another editor")
	require.True(t, seen[ownRequest.ID])
	require.True(t, seen[toAnyone.ID])

	// Contributors can't review.
	rsp, body = get(owner)
	require.Nil(t, rsp.ReviewRequests)
	require.Contains(t, body, `"review_requests":null`)

	// Resolved, it's gone.
	requireStatus(t, as(t, server, reviewer, http.MethodPost, fmt.Sprintf("/api/v1/review-requests/%d/dismiss", toReviewer.ID), nil), http.StatusOK)
	require.False(t, ids(reviewer)[toReviewer.ID])
}

func TestReviewRequestListIndicatorAndFilter(t *testing.T) {
	_, store, server, _ := reviewServer(t)
	owner := scheduleUser(t, store, RoleContributor)
	other := scheduleUser(t, store, RoleContributor)
	editor := scheduleUser(t, store, RoleEditor)
	word := scheduleWord()

	pending := publishedPost(t, store, owner)
	rr := requestReviewAs(t, server, owner, pending.ID, gin.H{"reviewer_id": editor.ID})
	quiet := scheduleDraft(t, store, owner, word)

	type listBody struct {
		Posts []PostWithMetaResponse `json:"posts"`
		Meta  struct {
			Total int64 `json:"total"`
		} `json:"meta"`
	}
	list := func(caller db.User, path string) listBody {
		t.Helper()
		recorder := as(t, server, caller, http.MethodGet, path, nil)
		requireStatus(t, recorder, http.StatusOK)
		var body listBody
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		return body
	}
	find := func(body listBody, id int64) *PostWithMetaResponse {
		for i := range body.Posts {
			if body.Posts[i].ID == id {
				return &body.Posts[i]
			}
		}
		return nil
	}

	mineURL := fmt.Sprintf("/api/v1/posts?with_meta=true&user_id=%d&limit=100", owner.ID)
	for _, caller := range []db.User{owner, editor} {
		body := list(caller, mineURL)
		row := find(body, pending.ID)
		require.NotNil(t, row)
		require.NotNil(t, row.ReviewRequest, "the indicator")
		require.Equal(t, rr.ID, row.ReviewRequest.ID)
		require.Equal(t, editor.ID, row.ReviewRequest.Reviewer.ID)
		require.Equal(t, owner.ID, row.ReviewRequest.RequestedBy.ID)
		require.Nil(t, find(body, quiet.ID).ReviewRequest)
	}
	// Another contributor sees the published post, not its request.
	row := find(list(other, mineURL), pending.ID)
	require.NotNil(t, row)
	require.Nil(t, row.ReviewRequest)

	// The filter: posts with an open request (a contributor: only their own).
	filtered := list(editor, mineURL+"&review=pending")
	require.NotNil(t, find(filtered, pending.ID))
	require.Nil(t, find(filtered, quiet.ID))
	require.EqualValues(t, 1, filtered.Meta.Total)
	byType := list(editor, fmt.Sprintf("/api/v1/posts/type/post?with_meta=true&review=pending&limit=100&author_id=%d", owner.ID))
	require.NotNil(t, find(byType, pending.ID))
	require.NotNil(t, find(byType, pending.ID).ReviewRequest)
	require.Nil(t, find(byType, quiet.ID))
	require.Empty(t, list(other, mineURL+"&review=pending").Posts)
	require.NotEmpty(t, list(owner, mineURL+"&review=pending").Posts)
	searched := list(editor, fmt.Sprintf("/api/v1/posts/search?q=%s&review=pending", strings.TrimPrefix(pending.Title, "Scheduled ")))
	require.NotNil(t, find(searched, pending.ID))
	require.NotNil(t, find(searched, pending.ID).ReviewRequest)

	requireStatus(t, as(t, server, editor, http.MethodGet, "/api/v1/posts?review=maybe", nil), http.StatusBadRequest)

	// The activity log follows the same rule: another contributor may read the published
	// post's events, but not its review requests.
	verbsFor := func(caller db.User) []string {
		t.Helper()
		page := getActivity(t, server, caller, fmt.Sprintf("?post_id=%d&limit=50", pending.ID))
		var verbs []string
		for _, e := range page.Activity {
			verbs = append(verbs, e.Verb)
		}
		return verbs
	}
	require.Contains(t, verbsFor(owner), db.ActivityReviewRequested)
	require.Contains(t, verbsFor(editor), db.ActivityReviewRequested)
	require.NotContains(t, verbsFor(other), db.ActivityReviewRequested)
}

func TestReviewRequestEmailTemplates(t *testing.T) {
	msg, err := mailer.RenderReviewRequested("r@example.test", mailer.ReviewRequested{
		SiteTitle:     "Site",
		RequesterName: "Kenji\r\nBcc: x@evil.test",
		PostTitle:     "How we <cut> load time",
		Note:          "<script>alert(1)</script>",
		Link:          "https://cms.test.invalid/gl-admin/content/edit/7",
		Assigned:      true,
	})
	require.NoError(t, err)
	require.NotContains(t, msg.Subject, "\n")
	require.Equal(t, "Kenji Bcc: x@evil.test asked for a review: How we <cut> load time", msg.Subject)
	require.Contains(t, msg.HTML, "&lt;script&gt;")
	require.NotContains(t, msg.HTML, "<script>")
	require.Contains(t, msg.Text, "asked you to review")

	msg, err = mailer.RenderReviewRequested("r@example.test", mailer.ReviewRequested{Link: "https://x.test/l"})
	require.NoError(t, err)
	require.Equal(t, "Someone asked for a review: Untitled", msg.Subject)
	require.NotContains(t, msg.Text, "Their note")

	msg, err = mailer.RenderReviewChangesRequested("c@example.test", mailer.ReviewChangesRequested{
		SiteTitle: "Site", ReviewerName: "Ana", PostTitle: "Post", Note: "Fix it", Link: "https://x.test/l",
	})
	require.NoError(t, err)
	require.Equal(t, "Changes requested: Post", msg.Subject)
	require.Contains(t, msg.Text, "Ana reviewed")
	require.Contains(t, msg.Text, "Fix it")
}

// allowReviewLookups lets a mock-store list test make the posts list's review
// indicator lookup (#323), answering no open requests.
func allowReviewLookups(store *mockdb.MockStore) {
	store.EXPECT().ListOpenReviewRequestsForPosts(gomock.Any(), gomock.Any()).AnyTimes().Return([]db.ListOpenReviewRequestsForPostsRow{}, nil)
}

// A failed indicator lookup leaves the indicator out; the list still answers.
func TestReviewIndicatorLookupFailureKeepsTheList(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t))
	store.EXPECT().CountFilteredPosts(gomock.Any(), gomock.Any()).Return(int64(1), nil)
	store.EXPECT().ListPostsWithMeta(gomock.Any(), gomock.Any()).DoAndReturn(func(_ any, arg db.ListPostsWithMetaParams) ([]db.ListPostsWithMetaRow, error) {
		require.True(t, arg.ReviewPending)
		return []db.ListPostsWithMetaRow{{ID: 1, PostStatus: "draft"}}, nil
	})
	store.EXPECT().ListOpenReviewRequestsForPosts(gomock.Any(), []int64{1}).Return(nil, fmt.Errorf("db down"))
	recorder := serveGet(t, store, "/api/v1/posts?with_meta=true&review=pending")
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.NotContains(t, recorder.Body.String(), "review_request")
}
