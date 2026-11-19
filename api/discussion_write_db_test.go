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
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The public write path of reader comments (#524) against the test database (skipped
// without one): the whole flow from the form's POST to the confirmation and the browser
// key, a link confirming only its own comment, single use, expiry, keys for another
// address, the confirm page's Publish and Discard, replies and refusals, and the
// transactions' re-checks. The settings are the site's, restored after each test.

type commentFlow struct {
	discussionFixture
	mail *recordingMailer
}

func newCommentFlow(t *testing.T, moderation string) commentFlow {
	t.Helper()
	f := newDiscussionFixture(t)
	restoreDiscussionSettings(t, f)
	_, err := f.conn.Exec(`UPDATE settings SET comments_enabled = true, comments_moderation = $1, comments_max_links = 1,
		comments_hold_words = '{}', comments_spam_words = '{}', comments_close_after_days = 0`, moderation)
	require.NoError(t, err)
	mail := &recordingMailer{}
	f.server.mailer = mail
	f.server.runInBackground = func(_, _ string, fn func()) { fn() }
	f.server.rateLimits.commentMail = newIntervalLimiter("comment-mail", readerCommentMailCooldown, true)
	return commentFlow{discussionFixture: f, mail: mail}
}

func uniqueAddress() string {
	return "Reader." + strings.ReplaceAll(uuid.NewString(), "-", "")[:12] + "@Example.test"
}

func (f commentFlow) post(t *testing.T, postID int64, body gin.H, keys ...string) *httptest.ResponseRecorder {
	t.Helper()
	var configure func(*http.Request)
	if len(keys) > 0 {
		configure = withKeys(keys...)
	}
	return doJSON(t, f.server, http.MethodPost, fmt.Sprintf("/public/posts/%d/comments", postID), body, configure)
}

func (f commentFlow) confirm(t *testing.T, token string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	recorder := doJSON(t, f.server, http.MethodPost, "/public/discussion/confirm", gin.H{"token": token}, nil)
	var body map[string]any
	_ = json.Unmarshal(recorder.Body.Bytes(), &body)
	return recorder, body
}

// lastToken is the token of the last confirmation mailed to address.
func (f commentFlow) lastToken(t *testing.T, address string) string {
	t.Helper()
	msgs := f.mail.messages()
	for i := len(msgs) - 1; i >= 0; i-- {
		if msgs[i].To == address {
			return tokenFromMail(t, msgs[i], readerCommentConfirmPath)
		}
	}
	t.Fatalf("no confirmation mailed")
	return ""
}

func (f commentFlow) commentsOf(t *testing.T, postID int64) []db.ReaderComment {
	t.Helper()
	rows, err := f.conn.Query(`SELECT id FROM reader_comments WHERE post_id = $1 ORDER BY id`, postID)
	require.NoError(t, err)
	defer rows.Close()
	var out []db.ReaderComment
	for rows.Next() {
		var id int64
		require.NoError(t, rows.Scan(&id))
		out = append(out, f.reload(t, id))
	}
	return out
}

func TestReaderCommentFlowToTheBrowserKey(t *testing.T) {
	f := newCommentFlow(t, discussionModerationNone)
	post := f.publishedPost(t)
	address := uniqueAddress()
	body := func(text string) gin.H {
		return gin.H{"name": "Maya Rivers", "email": address, "body": text, "notify_replies": true}
	}

	// 1. No key: the usual answer, an unconfirmed comment, one mail.
	recorder := f.post(t, post.ID, body("First thoughts on this."))
	require.Equal(t, http.StatusAccepted, recorder.Code, recorder.Body.String())
	require.Contains(t, recorder.Body.String(), `"outcome":"confirm_email"`)
	comments := f.commentsOf(t, post.ID)
	require.Len(t, comments, 1)
	first := comments[0]
	require.Equal(t, db.ReaderCommentUnconfirmed, first.Status)
	require.Len(t, first.ConfirmTokenHash, 32)
	require.Len(t, first.NetworkHash, 32)
	commenter, err := f.store.GetCommenter(context.Background(), first.CommenterID.Int64)
	require.NoError(t, err)
	require.Equal(t, strings.ToLower(address), commenter.EmailLower)
	require.False(t, commenter.VerifiedAt.Valid)
	token := f.lastToken(t, address)

	// 2. The link's button publishes it (mode none) and keys the browser.
	recorder, answer := f.confirm(t, token)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Equal(t, readerCommentOutcomePublished, answer["outcome"])
	key, _ := answer["set_key"].(string)
	require.Len(t, key, accountTokenLen)
	first = f.reload(t, first.ID)
	require.Equal(t, db.ReaderCommentApproved, first.Status)
	require.True(t, first.ApprovedAt.Valid)
	require.Empty(t, first.ConfirmTokenHash, "the token is spent")
	commenter, err = f.store.GetCommenter(context.Background(), commenter.ID)
	require.NoError(t, err)
	require.True(t, commenter.VerifiedAt.Valid)
	var stored []byte
	require.NoError(t, f.conn.QueryRow(`SELECT key_hash FROM commenter_keys WHERE commenter_id = $1`, commenter.ID).Scan(&stored))
	require.Equal(t, hashAccountToken(key), stored, "only the key's hash is stored")

	// 3. Single use.
	recorder, _ = f.confirm(t, token)
	requireErrorCode(t, recorder, http.StatusBadRequest, "invalid_token")

	// 4. With the key, the next comment needs no mail.
	mails := len(f.mail.messages())
	recorder = f.post(t, post.ID, body("A follow-up."), key)
	require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
	require.Equal(t, mails, len(f.mail.messages()))
	require.Contains(t, recorder.Body.String(), `"outcome":"published"`)

	// 5. A reply to it, with the key.
	replyBody := body("Replying to myself.")
	replyBody["parent_id"] = first.ID
	recorder = f.post(t, post.ID, replyBody, key)
	require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
	comments = f.commentsOf(t, post.ID)
	reply := comments[len(comments)-1]
	require.Equal(t, sql.NullInt64{Int64: first.ID, Valid: true}, reply.ParentID)
	require.Equal(t, sql.NullInt64{Int64: first.ID, Valid: true}, reply.RootID)

	// 6. The key for another address is no key: that address gets a mail.
	other := uniqueAddress()
	recorder = f.post(t, post.ID, gin.H{"name": "Maya Rivers", "email": other, "body": "Not my address."}, key)
	require.Contains(t, recorder.Body.String(), `"outcome":"confirm_email"`)
	require.Equal(t, other, f.mail.messages()[len(f.mail.messages())-1].To)

	// 7. An expired key is no key either.
	_, err = f.conn.Exec(`UPDATE commenter_keys SET expires_at = now() - interval '1 second' WHERE commenter_id = $1`, commenter.ID)
	require.NoError(t, err)
	recorder = f.post(t, post.ID, body("After the key expired."), key)
	require.Contains(t, recorder.Body.String(), `"outcome":"confirm_email"`)

	// Nothing in any answer names the address.
	for _, c := range f.commentsOf(t, post.ID) {
		require.NotContains(t, c.DisplayName, "@")
	}
}

func TestReaderCommentLinkConfirmsOnlyItsOwn(t *testing.T) {
	f := newCommentFlow(t, discussionModerationNone)
	post := f.publishedPost(t)
	address := uniqueAddress()

	// The owner's comment, then one someone else wrote with the same address (in the
	// cooldown: stored, no second mail).
	require.Equal(t, http.StatusAccepted, f.post(t, post.ID, gin.H{"name": "Owner", "email": address, "body": "Mine."}).Code)
	require.Equal(t, http.StatusAccepted, f.post(t, post.ID, gin.H{"name": "Owner", "email": address, "body": "Forged words to pass as the owner."}).Code)
	require.Equal(t, http.StatusAccepted, f.post(t, post.ID, gin.H{"name": "Owner", "email": address, "body": "Another forged one."}).Code)
	require.Len(t, f.mail.messages(), 1)
	comments := f.commentsOf(t, post.ID)
	require.Len(t, comments, 3)
	mine, forged, another := comments[0], comments[1], comments[2]
	require.Empty(t, forged.ConfirmTokenHash, "no link was mailed for it")

	recorder, answer := f.confirm(t, f.lastToken(t, address))
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Equal(t, db.ReaderCommentApproved, f.reload(t, mine.ID).Status)
	require.Equal(t, db.ReaderCommentUnconfirmed, f.reload(t, forged.ID).Status, "the link confirms its own comment only")
	require.Equal(t, db.ReaderCommentUnconfirmed, f.reload(t, another.ID).Status)
	others, _ := answer["others"].([]any)
	require.Len(t, others, 2, "listed for the person holding the link")
	key := answer["set_key"].(string)

	// Published or discarded one by one, with the key.
	act := func(id int64, action string, keys ...string) *httptest.ResponseRecorder {
		var configure func(*http.Request)
		if len(keys) > 0 {
			configure = withKeys(keys...)
		}
		return doJSON(t, f.server, http.MethodPost, fmt.Sprintf("/public/discussion/unconfirmed/%d", id), gin.H{"action": action}, configure)
	}
	requireErrorCode(t, act(forged.ID, "publish"), http.StatusNotFound, "not_found")
	recorder = act(another.ID, "publish", key)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Equal(t, db.ReaderCommentApproved, f.reload(t, another.ID).Status)
	require.Equal(t, http.StatusNoContent, act(forged.ID, "discard", key).Code)
	require.False(t, f.exists(t, forged.ID))
	// Done: neither can be acted on again.
	requireErrorCode(t, act(forged.ID, "discard", key), http.StatusNotFound, "not_found")
	requireErrorCode(t, act(another.ID, "publish", key), http.StatusNotFound, "not_found")

	// Someone else's key can't touch this address's comments.
	stranger := uniqueAddress()
	require.Equal(t, http.StatusAccepted, f.post(t, post.ID, gin.H{"name": "Stranger", "email": stranger, "body": "Hello there."}).Code)
	_, strangerAnswer := f.confirm(t, f.lastToken(t, stranger))
	strangerKey := strangerAnswer["set_key"].(string)
	require.Equal(t, http.StatusAccepted, f.post(t, post.ID, gin.H{"name": "Owner", "email": address, "body": "Later, without the key."}).Code)
	comments = f.commentsOf(t, post.ID)
	late := comments[len(comments)-1]
	require.Equal(t, db.ReaderCommentUnconfirmed, late.Status)
	requireErrorCode(t, act(late.ID, "publish", strangerKey), http.StatusNotFound, "not_found")
	requireErrorCode(t, act(late.ID, "discard", strangerKey), http.StatusNotFound, "not_found")
	require.True(t, f.exists(t, late.ID))
}

func TestReaderCommentConfirmationHoldsAndExpires(t *testing.T) {
	f := newCommentFlow(t, discussionModerationFirst)
	post := f.publishedPost(t)
	address := uniqueAddress()

	require.Equal(t, http.StatusAccepted, f.post(t, post.ID, gin.H{"name": "New Reader", "email": address, "body": "My first comment."}).Code)
	token := f.lastToken(t, address)

	// Past 48 hours the link is like any bad link, and nothing changes.
	comments := f.commentsOf(t, post.ID)
	f.age(t, comments[0].ID, readerCommentConfirmTTL+time.Minute)
	recorder, _ := f.confirm(t, token)
	requireErrorCode(t, recorder, http.StatusBadRequest, "invalid_token")
	require.Equal(t, db.ReaderCommentUnconfirmed, f.reload(t, comments[0].ID).Status)

	// A fresh one is held as a first comment.
	f.server.rateLimits.commentMail = newIntervalLimiter("comment-mail", readerCommentMailCooldown, true)
	require.Equal(t, http.StatusAccepted, f.post(t, post.ID, gin.H{"name": "New Reader", "email": address, "body": "Trying again."}).Code)
	recorder, answer := f.confirm(t, f.lastToken(t, address))
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	require.Equal(t, readerCommentOutcomePending, answer["outcome"])
	comments = f.commentsOf(t, post.ID)
	held := comments[len(comments)-1]
	require.Equal(t, db.ReaderCommentPending, held.Status)
	require.Equal(t, heldFirstComment, held.HeldReason.String)
	require.False(t, held.ApprovedAt.Valid)
}

func TestReaderCommentRefusalsOnTheDatabase(t *testing.T) {
	f := newCommentFlow(t, discussionModerationNone)
	post := f.publishedPost(t)
	otherPost := f.publishedPost(t)
	commenter := f.commenter(t)
	approved := f.comment(t, post, commenter, nil, db.ReaderCommentApproved)
	pending := f.comment(t, post, commenter, nil, db.ReaderCommentPending)
	elsewhere := f.comment(t, otherPost, commenter, nil, db.ReaderCommentApproved)
	body := func(parent int64) gin.H {
		return gin.H{"name": "Maya", "email": uniqueAddress(), "body": "A reply.", "parent_id": parent}
	}

	require.Equal(t, http.StatusAccepted, f.post(t, post.ID, body(approved.ID)).Code)
	requireErrorCode(t, f.post(t, post.ID, body(pending.ID)), http.StatusNotFound, "parent_not_found")
	requireErrorCode(t, f.post(t, post.ID, body(elsewhere.ID)), http.StatusNotFound, "parent_not_found")
	requireErrorCode(t, f.post(t, post.ID, body(999999999)), http.StatusNotFound, "parent_not_found")

	for discussion, code := range map[string]string{postDiscussionClosed: "comments_closed", postDiscussionOff: "comments_off"} {
		_, err := f.store.UpdatePostDiscussion(context.Background(), db.UpdatePostDiscussionParams{ID: post.ID, Discussion: discussion})
		require.NoError(t, err)
		requireErrorCode(t, f.post(t, post.ID, gin.H{"name": "Maya", "email": uniqueAddress(), "body": "Hello."}), http.StatusConflict, code)
	}
	draft := scheduleDraft(t, f.store, f.editor, scheduleWord())
	requireErrorCode(t, f.post(t, draft.ID, gin.H{"name": "Maya", "email": uniqueAddress(), "body": "Hello."}), http.StatusNotFound, "not_found")

	_, err := f.conn.Exec(`UPDATE settings SET comments_enabled = false`)
	require.NoError(t, err)
	requireErrorCode(t, f.post(t, otherPost.ID, gin.H{"name": "Maya", "email": uniqueAddress(), "body": "Hello."}), http.StatusConflict, "comments_off")
}

// The transactions re-check what the handler checked: a parent unapproved, or a token
// spent, between the two.
func TestReaderCommentTransactionsRecheck(t *testing.T) {
	f := newDiscussionFixture(t)
	ctx := context.Background()
	post := f.publishedPost(t)
	commenter := f.commenter(t)
	parent := f.comment(t, post, commenter, nil, db.ReaderCommentPending)

	_, err := f.store.CreateReaderCommentTx(ctx, db.CreateReaderCommentTxParams{Comment: db.CreateReaderCommentParams{
		PostID: post.ID, ParentID: sql.NullInt64{Int64: parent.ID, Valid: true}, RootID: sql.NullInt64{Int64: parent.ID, Valid: true},
		CommenterID: sql.NullInt64{Int64: commenter.ID, Valid: true}, DisplayName: "Maya", Body: "A reply.", Status: db.ReaderCommentApproved,
	}})
	require.ErrorIs(t, err, db.ErrReaderCommentParentGone)

	// A verified comment updates the commenter's name.
	approvedParent := f.comment(t, post, commenter, nil, db.ReaderCommentApproved)
	_, err = f.store.CreateReaderCommentTx(ctx, db.CreateReaderCommentTxParams{VerifiedCommenter: true, Comment: db.CreateReaderCommentParams{
		PostID: post.ID, ParentID: sql.NullInt64{Int64: approvedParent.ID, Valid: true}, RootID: sql.NullInt64{Int64: approvedParent.ID, Valid: true},
		CommenterID: sql.NullInt64{Int64: commenter.ID, Valid: true}, DisplayName: "Maya Renamed", Body: "A reply.", Status: db.ReaderCommentApproved,
	}})
	require.NoError(t, err)
	reread, err := f.store.GetCommenter(ctx, commenter.ID)
	require.NoError(t, err)
	require.Equal(t, "Maya Renamed", reread.DisplayName)
	require.True(t, reread.VerifiedAt.Valid)

	// Typing an address never renames its commenter.
	ensured, err := f.store.EnsureCommenter(ctx, db.EnsureCommenterParams{Email: "x" + commenter.Email, EmailLower: commenter.EmailLower, DisplayName: "Impostor"})
	require.NoError(t, err)
	require.Equal(t, commenter.ID, ensured.ID)
	require.Equal(t, "Maya Renamed", ensured.DisplayName)
	require.Equal(t, commenter.Email, ensured.Email)

	// A token that isn't the comment's (spent, replaced) publishes nothing.
	unconfirmed := f.comment(t, post, commenter, nil, db.ReaderCommentUnconfirmed)
	_, err = f.store.PublishReaderCommentTx(ctx, db.PublishReaderCommentTxParams{
		ID: unconfirmed.ID, TokenHash: hashAccountToken("not-the-token"), CreatedAfter: time.Now().Add(-time.Hour), Status: db.ReaderCommentApproved,
	})
	require.ErrorIs(t, err, db.ErrTokenInvalid)
	require.Equal(t, db.ReaderCommentUnconfirmed, f.reload(t, unconfirmed.ID).Status)
	// An approved comment isn't unconfirmed any more.
	_, err = f.store.PublishReaderCommentTx(ctx, db.PublishReaderCommentTxParams{
		ID: approvedParent.ID, CreatedAfter: time.Now().Add(-time.Hour), Status: db.ReaderCommentApproved,
	})
	require.ErrorIs(t, err, db.ErrTokenInvalid)

	// An unconfirmed reply whose parent was unapproved since isn't published, and keeps its token.
	reply := f.comment(t, post, commenter, &approvedParent, db.ReaderCommentUnconfirmed)
	_, err = f.conn.Exec(`UPDATE reader_comments SET status = 'pending', approved_at = NULL WHERE id = $1`, approvedParent.ID)
	require.NoError(t, err)
	_, err = f.store.PublishReaderCommentTx(ctx, db.PublishReaderCommentTxParams{
		ID: reply.ID, TokenHash: reply.ConfirmTokenHash, CreatedAfter: time.Now().Add(-time.Hour), Status: db.ReaderCommentApproved,
	})
	require.ErrorIs(t, err, db.ErrReaderCommentParentGone)
	require.Equal(t, reply.ConfirmTokenHash, f.reload(t, reply.ID).ConfirmTokenHash)
}

// No /public write answer holds the address, a hash, a token, or a key's hash.
func TestReaderCommentAnswersHoldNoAddress(t *testing.T) {
	f := newCommentFlow(t, discussionModerationNone)
	post := f.publishedPost(t)
	address := uniqueAddress()
	var answers []string
	recorder := f.post(t, post.ID, gin.H{"name": "Maya", "email": address, "body": "Hello."})
	answers = append(answers, recorder.Body.String())
	recorder, answer := f.confirm(t, f.lastToken(t, address))
	answers = append(answers, recorder.Body.String())
	recorder = f.post(t, post.ID, gin.H{"name": "Maya", "email": address, "body": "Again."}, answer["set_key"].(string))
	answers = append(answers, recorder.Body.String())
	for _, a := range answers {
		require.NotContains(t, strings.ToLower(a), strings.ToLower(address))
		require.NotContains(t, a, "network_hash")
		require.NotContains(t, a, "commenter_id")
		require.NotContains(t, a, "confirm_token")
	}
}
