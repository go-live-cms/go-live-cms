package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
	"github.com/go-live-cms/go-live-cms/util"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

// The public write path of reader comments (#524) on a mock store: no address
// enumeration (as signup's test, the calls before the answer included), the mail, the
// browser key, the rules' routes, the refusals and the limits. discussion_write_db_test.go
// runs the flows against the database.

const (
	rcPostID   = int64(42)
	rcPostPath = "/post/hello-world"
	rcName     = "Maya Rivers"
	rcBody     = "A distinctive sentence nobody else would type."
)

func rcSettings() db.Setting {
	return db.Setting{
		CommentsEnabled: true, CommentsModeration: discussionModerationFirst, CommentsMaxLinks: 1,
		PostUrlStructure: urlStructureSlug, SiteTitle: sql.NullString{String: "Field Notes", Valid: true},
	}
}

func rcPost() db.GetReaderCommentPostRow {
	return db.GetReaderCommentPostRow{
		ID: rcPostID, PostType: "post", Slug: "hello-world", PostStatus: postStatusPublished,
		Discussion: postDiscussionDefault, Title: "Hello world",
		FirstPublishedAt: sql.NullTime{Time: time.Now().Add(-time.Hour), Valid: true},
	}
}

func rcPostType() db.PostType {
	return db.PostType{Name: "post", Public: true, IsActive: true, Supports: json.RawMessage(`["title","content","comments"]`)}
}

// expectCommentTarget stubs the calls every comment makes before its answer: they read
// the post, never the address.
func expectCommentTarget(store *mockdb.MockStore, settings db.Setting) {
	store.EXPECT().GetSettings(gomock.Any()).Return(settings, nil)
	store.EXPECT().GetReaderCommentPost(gomock.Any(), rcPostID).Return(rcPost(), nil)
	store.EXPECT().GetPostType(gomock.Any(), "post").Return(rcPostType(), nil)
	store.EXPECT().CountPendingReaderCommentsForPost(gomock.Any(), rcPostID).Return(int64(0), nil)
}

func commentBody(email string) gin.H {
	return gin.H{"name": rcName, "email": email, "body": rcBody, "notify_replies": true, "website": ""}
}

func postComment(t *testing.T, server *Server, body any, configure func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	return doJSON(t, server, http.MethodPost, "/public/posts/42/comments", body, configure)
}

func withKeys(keys ...string) func(*http.Request) {
	return func(r *http.Request) { r.Header.Set(commenterKeyHeader, strings.Join(keys, ", ")) }
}

// storedComment captures what CreateReaderCommentTx stored.
func storedComment(store *mockdb.MockStore, id int64) *db.CreateReaderCommentTxParams {
	stored := &db.CreateReaderCommentTxParams{}
	store.EXPECT().CreateReaderCommentTx(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, arg db.CreateReaderCommentTxParams) (db.ReaderComment, error) {
			*stored = arg
			c := arg.Comment
			return db.ReaderComment{ID: id, PostID: c.PostID, CommenterID: c.CommenterID, DisplayName: c.DisplayName, Body: c.Body, Status: c.Status,
				HeldReason: c.HeldReason, ConfirmTokenHash: c.ConfirmTokenHash}, nil
		})
	return stored
}

// newCommentTestServer has the mail cooldown on (its limiter only), a recording mailer,
// and logs into a buffer, so tests can check no address or text is logged.
func newCommentTestServer(t *testing.T, store *mockdb.MockStore) (*Server, *recordingMailer, *bytes.Buffer) {
	server, rec := newAccountTestServer(t, store)
	server.rateLimits.commentMail = newIntervalLimiter("comment-mail", readerCommentMailCooldown, true)
	logs := &bytes.Buffer{}
	server.logger = slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	return server, rec, logs
}

func requireNoPersonalData(t *testing.T, text string, values ...string) {
	t.Helper()
	for _, v := range values {
		require.NotContains(t, strings.ToLower(text), strings.ToLower(v))
	}
}

func TestReaderCommentNoAddressEnumeration(t *testing.T) {
	const email = "Reader@Example.com"
	otherKey, _, err := newAccountToken()
	require.NoError(t, err)
	verifiedAt := sql.NullTime{Time: time.Now().Add(-48 * time.Hour), Valid: true}

	// Each case: what the address is, and the background calls that follow from it. The
	// answer must be the same, and the calls before it the same, for every one.
	type state struct {
		name       string
		key        bool // a key for another address is sent
		background func(t *testing.T, store *mockdb.MockStore, server *Server)
		mails      int
	}
	commenter := db.Commenter{ID: 9, Email: "reader@example.com", EmailLower: "reader@example.com", DisplayName: "Owner"}
	ensure := func(store *mockdb.MockStore, c db.Commenter, waiting int64) {
		store.EXPECT().EnsureCommenter(gomock.Any(), db.EnsureCommenterParams{Email: email, EmailLower: "reader@example.com", DisplayName: rcName}).Return(c, nil)
		store.EXPECT().CountUnconfirmedReaderComments(gomock.Any(), gomock.Any()).Return(waiting, nil)
	}
	states := []state{
		{name: "unknown", mails: 1, background: func(t *testing.T, store *mockdb.MockStore, _ *Server) {
			ensure(store, db.Commenter{ID: 10, Email: email, EmailLower: "reader@example.com", DisplayName: rcName}, 0)
			storedComment(store, 100)
		}},
		{name: "known, never verified", mails: 1, background: func(t *testing.T, store *mockdb.MockStore, _ *Server) {
			ensure(store, commenter, 1)
			storedComment(store, 101)
		}},
		{name: "verified", mails: 1, background: func(t *testing.T, store *mockdb.MockStore, _ *Server) {
			c := commenter
			c.VerifiedAt = verifiedAt
			ensure(store, c, 0)
			storedComment(store, 102)
		}},
		{name: "in its mail cooldown", mails: 0, background: func(t *testing.T, store *mockdb.MockStore, server *Server) {
			require.True(t, server.rateLimits.commentMail.allowSilently(t.Context(), "reader@example.com"))
			ensure(store, commenter, 1)
			stored := storedComment(store, 103)
			t.Cleanup(func() {
				require.NotEmpty(t, stored.Comment.ConfirmTokenHash, "stored with a token that is never mailed")
			})
		}},
		{name: "blocked", mails: 0, background: func(t *testing.T, store *mockdb.MockStore, _ *Server) {
			c := commenter
			c.BlockedAt = verifiedAt
			ensure(store, c, 0)
			stored := storedComment(store, 104)
			t.Cleanup(func() { require.Equal(t, db.ReaderCommentSpam, stored.Comment.Status) })
		}},
		{name: "over its unconfirmed cap", mails: 0, background: func(t *testing.T, store *mockdb.MockStore, _ *Server) {
			ensure(store, commenter, readerCommentUnconfirmedCap)
		}},
		{name: "a key for another address", key: true, mails: 1, background: func(t *testing.T, store *mockdb.MockStore, _ *Server) {
			c := commenter
			c.VerifiedAt = verifiedAt
			ensure(store, c, 0)
			storedComment(store, 105)
		}},
	}

	var first *httptest.ResponseRecorder
	for _, s := range states {
		t.Run(s.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			// Before the answer: the post only, and the key lookup when a key is sent
			// (which, for any address but the key's own, finds nothing).
			expectCommentTarget(store, rcSettings())
			var configure func(*http.Request)
			if s.key {
				store.EXPECT().GetCommenterByKeys(gomock.Any(), gomock.Any()).Return(db.Commenter{}, sql.ErrNoRows)
				configure = withKeys(otherKey)
			}
			server, rec, logs := newCommentTestServer(t, store)
			var deferred func()
			server.runInBackground = func(_, _ string, f func()) { deferred = f }

			recorder := postComment(t, server, commentBody(email), configure)
			require.NotNil(t, deferred, "the address's work must run after the response")
			require.Equal(t, http.StatusAccepted, recorder.Code, recorder.Body.String())
			require.JSONEq(t, `{"outcome":"confirm_email","post_url":"/post/hello-world"}`, recorder.Body.String())
			require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
			if first == nil {
				first = recorder
			} else {
				require.Equal(t, first.Code, recorder.Code)
				require.Equal(t, first.Body.String(), recorder.Body.String())
				for _, name := range []string{"Content-Type", "Cache-Control", "Set-Cookie", "Retry-After"} {
					require.Equal(t, first.Header().Values(name), recorder.Header().Values(name), name)
				}
				require.Equal(t, len(first.Header()), len(recorder.Header()))
			}

			s.background(t, store, server)
			store.EXPECT().ListMemberNames(gomock.Any()).Times(0)
			deferred()
			require.Len(t, rec.messages(), s.mails)
			requireNoPersonalData(t, logs.String(), email, rcName, rcBody, otherKey)
		})
	}
}

func TestReaderCommentConfirmationMailHoldsNothingTyped(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	expectCommentTarget(store, rcSettings())
	store.EXPECT().EnsureCommenter(gomock.Any(), gomock.Any()).Return(db.Commenter{ID: 10, Email: "reader@example.com", EmailLower: "reader@example.com"}, nil)
	store.EXPECT().CountUnconfirmedReaderComments(gomock.Any(), gomock.Any()).Return(int64(0), nil)
	stored := storedComment(store, 100)
	server, rec, logs := newCommentTestServer(t, store)

	recorder := postComment(t, server, commentBody("reader@example.com"), nil)
	require.Equal(t, http.StatusAccepted, recorder.Code, recorder.Body.String())

	msgs := rec.messages()
	require.Len(t, msgs, 1)
	msg := msgs[0]
	require.Equal(t, "reader@example.com", msg.To)
	require.Equal(t, mailer.TemplateReaderCommentConfirm, msg.Template)
	require.Contains(t, msg.Subject, "Field Notes")
	// Nothing the sender typed: not the name, not the text, not a word of either.
	for _, part := range []string{msg.Subject, msg.Text, msg.HTML} {
		requireNoPersonalData(t, part, rcName, "Maya", "Rivers", rcBody, "distinctive")
	}
	require.Contains(t, msg.Text, "Hello world")
	require.Contains(t, msg.Text, testPublicBaseURL+rcPostPath)
	raw := tokenFromMail(t, msg, readerCommentConfirmPath)

	c := stored.Comment
	require.Equal(t, db.ReaderCommentUnconfirmed, c.Status)
	require.Equal(t, hashAccountToken(raw), c.ConfirmTokenHash, "only the hash is stored")
	require.Equal(t, rcName, c.DisplayName)
	require.Equal(t, rcBody, c.Body)
	require.True(t, c.NotifyReplies, "stored while confirmation is pending (9.2)")
	require.Len(t, c.NetworkHash, 32, "a keyed network hash")
	require.False(t, stored.VerifiedCommenter, "typing an address proves nothing")
	requireNoPersonalData(t, logs.String(), "reader@example.com", rcName, rcBody, raw)
}

func TestReaderCommentMailCooldown(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	commenter := db.Commenter{ID: 10, Email: "reader@example.com", EmailLower: "reader@example.com"}
	for range 2 {
		expectCommentTarget(store, rcSettings())
		store.EXPECT().EnsureCommenter(gomock.Any(), gomock.Any()).Return(commenter, nil)
		store.EXPECT().CountUnconfirmedReaderComments(gomock.Any(), gomock.Any()).Return(int64(0), nil)
	}
	firstStored, secondStored := storedComment(store, 100), &db.CreateReaderCommentTxParams{}
	store.EXPECT().CreateReaderCommentTx(gomock.Any(), gomock.Any()).
		DoAndReturn(func(_ context.Context, arg db.CreateReaderCommentTxParams) (db.ReaderComment, error) {
			*secondStored = arg
			return db.ReaderComment{ID: 101, Status: arg.Comment.Status}, nil
		})
	server, rec, _ := newCommentTestServer(t, store)

	a := postComment(t, server, commentBody("reader@example.com"), nil)
	b := postComment(t, server, commentBody("READER@example.com"), nil)
	require.Equal(t, a.Body.String(), b.Body.String())
	require.Len(t, rec.messages(), 1, "one mail per address per 10 minutes")
	require.NotEmpty(t, firstStored.Comment.ConfirmTokenHash)
	require.Equal(t, db.ReaderCommentUnconfirmed, secondStored.Comment.Status, "the second is stored")
	require.NotEqual(t, firstStored.Comment.ConfirmTokenHash, secondStored.Comment.ConfirmTokenHash, "its own token, never mailed: it is published from the first link's page")
}

func TestReaderCommentSpamRoutesMailNothing(t *testing.T) {
	cases := []struct {
		name     string
		body     gin.H
		settings func(*db.Setting)
		reason   string
	}{
		{"honeypot", gin.H{"name": rcName, "email": "bot@example.com", "body": rcBody, "website": "https://spam.example"}, nil, spamHoneypot},
		{"spam word", gin.H{"name": rcName, "email": "bot@example.com", "body": "Cheap CASINO chips"}, func(s *db.Setting) { s.CommentsSpamWords = []string{"casino"} }, spamWord},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			settings := rcSettings()
			if tc.settings != nil {
				tc.settings(&settings)
			}
			expectCommentTarget(store, settings)
			store.EXPECT().EnsureCommenter(gomock.Any(), gomock.Any()).Return(db.Commenter{ID: 10}, nil)
			store.EXPECT().CountUnconfirmedReaderComments(gomock.Any(), gomock.Any()).Return(int64(0), nil)
			stored := storedComment(store, 100)
			server, rec, _ := newCommentTestServer(t, store)

			recorder := postComment(t, server, tc.body, nil)
			require.Equal(t, http.StatusAccepted, recorder.Code, recorder.Body.String())
			require.JSONEq(t, `{"outcome":"confirm_email","post_url":"/post/hello-world"}`, recorder.Body.String(), "the usual answer")
			require.Empty(t, rec.messages(), "a bot's comment mails no one")
			require.Equal(t, db.ReaderCommentSpam, stored.Comment.Status)
			require.Equal(t, tc.reason, stored.Comment.HeldReason.String)
			require.Empty(t, stored.Comment.ConfirmTokenHash)
		})
	}
}

func TestReaderCommentGuardOnTheUnconfirmedPath(t *testing.T) {
	for name, tc := range map[string]struct {
		verdict readerCommentGuardVerdict
		status  string
		reason  string
		mails   int
	}{
		"hold is kept for the confirmation": {readerCommentGuardVerdict{Action: readerCommentGuardHold, Reason: "Check this"}, db.ReaderCommentUnconfirmed, heldPlugin, 1},
		"spam mails nothing":                {readerCommentGuardVerdict{Action: readerCommentGuardSpam, Reason: "Bad"}, db.ReaderCommentSpam, spamPlugin, 0},
	} {
		t.Run(name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			expectCommentTarget(store, rcSettings())
			store.EXPECT().EnsureCommenter(gomock.Any(), gomock.Any()).Return(db.Commenter{ID: 10, Email: "reader@example.com"}, nil)
			store.EXPECT().CountUnconfirmedReaderComments(gomock.Any(), gomock.Any()).Return(int64(0), nil)
			stored := storedComment(store, 100)
			server, rec, _ := newCommentTestServer(t, store)
			var seen readerCommentCandidate
			server.readerCommentGuard = func(_ context.Context, _ *slog.Logger, c readerCommentCandidate) readerCommentGuardVerdict {
				seen = c
				return tc.verdict
			}

			require.Equal(t, http.StatusAccepted, postComment(t, server, commentBody("reader@example.com"), nil).Code)
			require.Equal(t, tc.status, stored.Comment.Status)
			require.Equal(t, tc.reason, stored.Comment.HeldReason.String)
			require.Equal(t, tc.verdict.Reason, stored.Comment.HeldDetail.String)
			require.Len(t, rec.messages(), tc.mails)
			require.Equal(t, readerCommentCandidate{PostID: rcPostID, Name: rcName, Email: "reader@example.com", Body: rcBody, IP: "192.0.2.1"}, seen)
		})
	}
}

// expectKeyedRules stubs the rules' reads for a keyed comment.
func expectKeyedRules(store *mockdb.MockStore, commenter db.Commenter, approvedBefore bool, members ...db.ListMemberNamesRow) {
	store.EXPECT().GetCommenterByKeys(gomock.Any(), gomock.Any()).Return(commenter, nil)
	store.EXPECT().CommenterHasApprovedReaderComment(gomock.Any(), sql.NullInt64{Int64: commenter.ID, Valid: true}).Return(approvedBefore, nil)
	store.EXPECT().ListMemberNames(gomock.Any()).Return(members, nil)
}

func TestReaderCommentWithABrowserKey(t *testing.T) {
	key, keyHash, err := newAccountToken()
	require.NoError(t, err)
	commenter := db.Commenter{ID: 9, Email: "reader@example.com", EmailLower: "reader@example.com", VerifiedAt: sql.NullTime{Time: time.Now(), Valid: true}}

	t.Run("an approved commenter is published at once", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		expectPostOpen(store)
		store.EXPECT().GetCommenterByKeys(gomock.Any(), db.GetCommenterByKeysParams{KeyHashes: [][]byte{keyHash}, EmailLower: "reader@example.com"}).Return(commenter, nil)
		store.EXPECT().CommenterHasApprovedReaderComment(gomock.Any(), gomock.Any()).Return(true, nil)
		store.EXPECT().ListMemberNames(gomock.Any()).Return(nil, nil)
		stored := storedComment(store, 300)
		server, rec, _ := newCommentTestServer(t, store)

		recorder := postComment(t, server, commentBody("Reader@Example.com"), withKeys("garbage", key))
		require.Equal(t, http.StatusCreated, recorder.Code, recorder.Body.String())
		require.JSONEq(t, `{"outcome":"published","comment_id":300,"post_url":"/post/hello-world","comment_url":"/post/hello-world#comment-300"}`, recorder.Body.String())
		require.Empty(t, rec.messages(), "a key skips the mail")
		require.Equal(t, db.ReaderCommentApproved, stored.Comment.Status)
		require.True(t, stored.Comment.ApprovedAt.Valid)
		require.True(t, stored.VerifiedCommenter, "the name used becomes the commenter's")
		require.Empty(t, stored.Comment.ConfirmTokenHash)
	})

	t.Run("a held comment answers pending", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		expectCommentTarget(store, rcSettings())
		expectKeyedRules(store, commenter, false)
		stored := storedComment(store, 301)
		server, _, _ := newCommentTestServer(t, store)

		recorder := postComment(t, server, commentBody("reader@example.com"), withKeys(key))
		require.Equal(t, http.StatusAccepted, recorder.Code, recorder.Body.String())
		require.JSONEq(t, `{"outcome":"pending","comment_id":301,"post_url":"/post/hello-world"}`, recorder.Body.String())
		require.Equal(t, db.ReaderCommentPending, stored.Comment.Status)
		require.Equal(t, heldFirstComment, stored.Comment.HeldReason.String)
	})

	t.Run("a member's name is held", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		expectCommentTarget(store, rcSettings())
		expectKeyedRules(store, commenter, true, db.ListMemberNamesRow{Username: "maya", FullName: "Maya Rivers"})
		stored := storedComment(store, 302)
		server, _, _ := newCommentTestServer(t, store)

		require.Equal(t, http.StatusAccepted, postComment(t, server, commentBody("reader@example.com"), withKeys(key)).Code)
		require.Equal(t, heldMemberName, stored.Comment.HeldReason.String)
	})

	t.Run("spam answers pending, silently", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		expectPostOpen(store)
		expectKeyedRules(store, commenter, true)
		stored := storedComment(store, 303)
		server, _, _ := newCommentTestServer(t, store)

		body := commentBody("reader@example.com")
		body["website"] = "x"
		recorder := postComment(t, server, body, withKeys(key))
		require.Equal(t, http.StatusAccepted, recorder.Code)
		require.JSONEq(t, `{"outcome":"pending","comment_id":303,"post_url":"/post/hello-world"}`, recorder.Body.String())
		require.Equal(t, db.ReaderCommentSpam, stored.Comment.Status)
		require.Equal(t, spamHoneypot, stored.Comment.HeldReason.String)
	})

	t.Run("the parent went meanwhile", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		expectPostOpen(store)
		expectKeyedRules(store, commenter, true)
		store.EXPECT().CreateReaderCommentTx(gomock.Any(), gomock.Any()).Return(db.ReaderComment{}, db.ErrReaderCommentParentGone)
		server, _, _ := newCommentTestServer(t, store)
		requireErrorCode(t, postComment(t, server, commentBody("reader@example.com"), withKeys(key)), http.StatusNotFound, "parent_not_found")
	})
}

func TestReaderCommentRefusals(t *testing.T) {
	closedAt := time.Now().Add(-time.Hour).UTC()
	cases := []struct {
		name   string
		body   gin.H
		stub   func(store *mockdb.MockStore)
		status int
		code   string
	}{
		{"comments off for the site", commentBody("a@example.com"), func(store *mockdb.MockStore) {
			store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, nil)
		}, http.StatusConflict, "comments_off"},
		{"a post that isn't published", commentBody("a@example.com"), func(store *mockdb.MockStore) {
			store.EXPECT().GetSettings(gomock.Any()).Return(rcSettings(), nil)
			post := rcPost()
			post.PostStatus = "draft"
			store.EXPECT().GetReaderCommentPost(gomock.Any(), rcPostID).Return(post, nil)
		}, http.StatusNotFound, "not_found"},
		{"no such post", commentBody("a@example.com"), func(store *mockdb.MockStore) {
			store.EXPECT().GetSettings(gomock.Any()).Return(rcSettings(), nil)
			store.EXPECT().GetReaderCommentPost(gomock.Any(), rcPostID).Return(db.GetReaderCommentPostRow{}, sql.ErrNoRows)
		}, http.StatusNotFound, "not_found"},
		{"a type that isn't public", commentBody("a@example.com"), func(store *mockdb.MockStore) {
			store.EXPECT().GetSettings(gomock.Any()).Return(rcSettings(), nil)
			store.EXPECT().GetReaderCommentPost(gomock.Any(), rcPostID).Return(rcPost(), nil)
			typ := rcPostType()
			typ.Public = false
			store.EXPECT().GetPostType(gomock.Any(), "post").Return(typ, nil)
		}, http.StatusNotFound, "not_found"},
		{"a post whose discussion is off", commentBody("a@example.com"), func(store *mockdb.MockStore) {
			store.EXPECT().GetSettings(gomock.Any()).Return(rcSettings(), nil)
			post := rcPost()
			post.Discussion = postDiscussionOff
			store.EXPECT().GetReaderCommentPost(gomock.Any(), rcPostID).Return(post, nil)
			store.EXPECT().GetPostType(gomock.Any(), "post").Return(rcPostType(), nil)
		}, http.StatusConflict, "comments_off"},
		{"a type without the Comments field", commentBody("a@example.com"), func(store *mockdb.MockStore) {
			store.EXPECT().GetSettings(gomock.Any()).Return(rcSettings(), nil)
			store.EXPECT().GetReaderCommentPost(gomock.Any(), rcPostID).Return(rcPost(), nil)
			typ := rcPostType()
			typ.Supports = json.RawMessage(`["title"]`)
			store.EXPECT().GetPostType(gomock.Any(), "post").Return(typ, nil)
		}, http.StatusConflict, "comments_off"},
		{"a closed post", commentBody("a@example.com"), func(store *mockdb.MockStore) {
			store.EXPECT().GetSettings(gomock.Any()).Return(rcSettings(), nil)
			post := rcPost()
			post.Discussion = postDiscussionClosed
			store.EXPECT().GetReaderCommentPost(gomock.Any(), rcPostID).Return(post, nil)
			store.EXPECT().GetPostType(gomock.Any(), "post").Return(rcPostType(), nil)
		}, http.StatusConflict, "comments_closed"},
		{"closed by the timer since the page was cached", commentBody("a@example.com"), func(store *mockdb.MockStore) {
			settings := rcSettings()
			settings.CommentsCloseAfterDays = 1
			store.EXPECT().GetSettings(gomock.Any()).Return(settings, nil)
			post := rcPost()
			post.FirstPublishedAt = sql.NullTime{Time: closedAt.Add(-24 * time.Hour), Valid: true}
			store.EXPECT().GetReaderCommentPost(gomock.Any(), rcPostID).Return(post, nil)
			store.EXPECT().GetPostType(gomock.Any(), "post").Return(rcPostType(), nil)
		}, http.StatusConflict, "comments_closed"},
		{"a reply to a pending comment", withParent(commentBody("a@example.com"), 7), func(store *mockdb.MockStore) {
			expectPostOpen(store)
			store.EXPECT().GetReaderComment(gomock.Any(), int64(7)).Return(db.ReaderComment{ID: 7, PostID: rcPostID, Status: db.ReaderCommentPending}, nil)
		}, http.StatusNotFound, "parent_not_found"},
		{"a reply to an unconfirmed comment", withParent(commentBody("a@example.com"), 7), func(store *mockdb.MockStore) {
			expectPostOpen(store)
			store.EXPECT().GetReaderComment(gomock.Any(), int64(7)).Return(db.ReaderComment{ID: 7, PostID: rcPostID, Status: db.ReaderCommentUnconfirmed}, nil)
		}, http.StatusNotFound, "parent_not_found"},
		{"a reply to another post's comment", withParent(commentBody("a@example.com"), 7), func(store *mockdb.MockStore) {
			expectPostOpen(store)
			store.EXPECT().GetReaderComment(gomock.Any(), int64(7)).Return(db.ReaderComment{ID: 7, PostID: rcPostID + 1, Status: db.ReaderCommentApproved}, nil)
		}, http.StatusNotFound, "parent_not_found"},
		{"a reply to a tombstone", withParent(commentBody("a@example.com"), 7), func(store *mockdb.MockStore) {
			expectPostOpen(store)
			store.EXPECT().GetReaderComment(gomock.Any(), int64(7)).Return(db.ReaderComment{ID: 7, PostID: rcPostID, Status: db.ReaderCommentApproved, RemovedAt: sql.NullTime{Time: closedAt, Valid: true}}, nil)
		}, http.StatusNotFound, "parent_not_found"},
		{"a reply to no comment", withParent(commentBody("a@example.com"), 7), func(store *mockdb.MockStore) {
			expectPostOpen(store)
			store.EXPECT().GetReaderComment(gomock.Any(), int64(7)).Return(db.ReaderComment{}, sql.ErrNoRows)
		}, http.StatusNotFound, "parent_not_found"},
		{"too many waiting on the post", commentBody("a@example.com"), func(store *mockdb.MockStore) {
			expectPostOpen(store)
			store.EXPECT().CountPendingReaderCommentsForPost(gomock.Any(), rcPostID).Return(int64(readerCommentPendingCap), nil)
		}, http.StatusTooManyRequests, "comments_busy"},
		{"an empty name", gin.H{"name": "  ", "email": "a@example.com", "body": rcBody}, nil, http.StatusBadRequest, "name_required"},
		{"a bidi override in the name", gin.H{"name": "Ana" + string(rune(0x202e)) + "Costa", "email": "a@example.com", "body": rcBody}, nil, http.StatusBadRequest, "name_invalid"},
		{"a one-character comment", gin.H{"name": rcName, "email": "a@example.com", "body": " x "}, nil, http.StatusBadRequest, "body_too_short"},
		{"a control character in the text", gin.H{"name": rcName, "email": "a@example.com", "body": "a\u0000b"}, nil, http.StatusBadRequest, "body_invalid"},
		{"too long a comment", gin.H{"name": rcName, "email": "a@example.com", "body": strings.Repeat("x", readerCommentBodyMax+1)}, nil, http.StatusBadRequest, "body_too_long"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			if tc.stub != nil {
				tc.stub(store)
			}
			server, rec, _ := newCommentTestServer(t, store)
			server.runInBackground = func(_, _ string, _ func()) { t.Fatal("a refused comment has no background work") }
			recorder := postComment(t, server, tc.body, nil)
			requireErrorCode(t, recorder, tc.status, tc.code)
			require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
			require.Empty(t, rec.messages())
			if tc.name == "closed by the timer since the page was cached" {
				require.Contains(t, recorder.Body.String(), closedAt.Truncate(time.Second).Format(time.RFC3339))
			}
		})
	}

	t.Run("malformed fields never reach the store", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server, _, _ := newCommentTestServer(t, store)
		for _, body := range []any{
			gin.H{"name": rcName, "email": "not-an-address", "body": rcBody},
			gin.H{"name": rcName, "body": rcBody},
			gin.H{"name": rcName, "email": "a@example.com", "body": rcBody, "status": "approved"},
			gin.H{"name": rcName, "email": "a@example.com", "body": rcBody, "parent_id": 0},
		} {
			recorder := postComment(t, server, body, nil)
			require.Equal(t, http.StatusBadRequest, recorder.Code, recorder.Body.String())
		}
		recorder := doJSON(t, server, http.MethodPost, "/public/posts/abc/comments", commentBody("a@example.com"), nil)
		requireErrorCode(t, recorder, http.StatusNotFound, "not_found")
	})

	t.Run("a body over the limit", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server, _, _ := newCommentTestServer(t, store)
		body := commentBody("a@example.com")
		body["website"] = strings.Repeat("y", int(discussionBodyLimit))
		require.Equal(t, http.StatusRequestEntityTooLarge, postComment(t, server, body, nil).Code)
	})

	t.Run("4000 emoji fit the body limit", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		expectCommentTarget(store, rcSettings())
		server, _, _ := newCommentTestServer(t, store)
		server.runInBackground = func(_, _ string, _ func()) {}
		body := commentBody("a@example.com")
		body["body"] = strings.Repeat("😀", readerCommentBodyMax)
		require.Equal(t, http.StatusAccepted, postComment(t, server, body, nil).Code)
	})
}

func withParent(body gin.H, id int64) gin.H {
	body["parent_id"] = id
	return body
}

func expectPostOpen(store *mockdb.MockStore) {
	store.EXPECT().GetSettings(gomock.Any()).Return(rcSettings(), nil)
	store.EXPECT().GetReaderCommentPost(gomock.Any(), rcPostID).Return(rcPost(), nil)
	store.EXPECT().GetPostType(gomock.Any(), "post").Return(rcPostType(), nil)
}

func TestReaderCommentReplyJoinsItsThread(t *testing.T) {
	for name, tc := range map[string]struct {
		parent db.ReaderComment
		root   int64
	}{
		"a reply to a top-level comment":    {db.ReaderComment{ID: 7, PostID: rcPostID, Status: db.ReaderCommentApproved}, 7},
		"a reply to a reply keeps its root": {db.ReaderComment{ID: 8, PostID: rcPostID, Status: db.ReaderCommentApproved, RootID: sql.NullInt64{Int64: 7, Valid: true}, ParentID: sql.NullInt64{Int64: 7, Valid: true}}, 7},
	} {
		t.Run(name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			expectPostOpen(store)
			store.EXPECT().GetReaderComment(gomock.Any(), tc.parent.ID).Return(tc.parent, nil)
			store.EXPECT().CountPendingReaderCommentsForPost(gomock.Any(), rcPostID).Return(int64(0), nil)
			store.EXPECT().EnsureCommenter(gomock.Any(), gomock.Any()).Return(db.Commenter{ID: 10}, nil)
			store.EXPECT().CountUnconfirmedReaderComments(gomock.Any(), gomock.Any()).Return(int64(0), nil)
			stored := storedComment(store, 100)
			server, _, _ := newCommentTestServer(t, store)
			require.Equal(t, http.StatusAccepted, postComment(t, server, withParent(commentBody("a@example.com"), tc.parent.ID), nil).Code)
			require.Equal(t, sql.NullInt64{Int64: tc.parent.ID, Valid: true}, stored.Comment.ParentID)
			require.Equal(t, sql.NullInt64{Int64: tc.root, Valid: true}, stored.Comment.RootID)
		})
	}
}

// --- Confirmation -------------------------------------------------------------------

func postConfirm(t *testing.T, server *Server, token string) *httptest.ResponseRecorder {
	t.Helper()
	return doJSON(t, server, http.MethodPost, "/public/discussion/confirm", gin.H{"token": token}, nil)
}

func unconfirmedComment(tokenHash []byte) db.ReaderComment {
	return db.ReaderComment{
		ID: 500, PostID: rcPostID, CommenterID: sql.NullInt64{Int64: 9, Valid: true}, DisplayName: rcName, Body: rcBody,
		Status: db.ReaderCommentUnconfirmed, ConfirmTokenHash: tokenHash, CreatedAt: time.Now().Add(-time.Hour),
	}
}

func TestConfirmReaderComment(t *testing.T) {
	token, hash, err := newAccountToken()
	require.NoError(t, err)
	commenter := db.Commenter{ID: 9, Email: "reader@example.com", EmailLower: "reader@example.com"}

	expectConfirm := func(store *mockdb.MockStore, settings db.Setting, approvedBefore bool) {
		store.EXPECT().GetSettings(gomock.Any()).Return(settings, nil)
		store.EXPECT().GetUnconfirmedReaderCommentByToken(gomock.Any(), gomock.Any()).
			DoAndReturn(func(_ context.Context, arg db.GetUnconfirmedReaderCommentByTokenParams) (db.ReaderComment, error) {
				require.Equal(t, hash, arg.TokenHash)
				require.WithinDuration(t, time.Now().Add(-readerCommentConfirmTTL), arg.CreatedAfter, 5*time.Second)
				return unconfirmedComment(hash), nil
			})
		store.EXPECT().GetReaderCommentPost(gomock.Any(), rcPostID).Return(rcPost(), nil)
		store.EXPECT().GetPostType(gomock.Any(), "post").Return(rcPostType(), nil)
		store.EXPECT().GetCommenter(gomock.Any(), int64(9)).Return(commenter, nil)
		store.EXPECT().CommenterHasApprovedReaderComment(gomock.Any(), gomock.Any()).Return(approvedBefore, nil)
		store.EXPECT().ListMemberNames(gomock.Any()).Return(nil, nil)
	}

	t.Run("publishes its own comment, keys the browser, lists the others", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		expectConfirm(store, rcSettings(), true)
		var published db.PublishReaderCommentTxParams
		store.EXPECT().PublishReaderCommentTx(gomock.Any(), gomock.Any()).
			DoAndReturn(func(_ context.Context, arg db.PublishReaderCommentTxParams) (db.ReaderComment, error) {
				published = arg
				c := unconfirmedComment(nil)
				c.Status = arg.Status
				return c, nil
			})
		store.EXPECT().ListUnconfirmedReaderCommentsForCommenter(gomock.Any(), gomock.Any()).
			DoAndReturn(func(_ context.Context, arg db.ListUnconfirmedReaderCommentsForCommenterParams) ([]db.ListUnconfirmedReaderCommentsForCommenterRow, error) {
				require.Equal(t, sql.NullInt64{Int64: 9, Valid: true}, arg.CommenterID)
				require.Equal(t, int64(500), arg.ExcludeID, "its own comment isn't listed")
				return []db.ListUnconfirmedReaderCommentsForCommenterRow{{
					ID: 501, PostID: 43, PostType: "post", Slug: "other", PostTitle: "Other post", Excerpt: strings.Repeat("é", 120), CreatedAt: time.Now(),
				}}, nil
			})
		server, _, logs := newCommentTestServer(t, store)

		recorder := postConfirm(t, server, token)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
		var body struct {
			Outcome    string `json:"outcome"`
			CommentID  int64  `json:"comment_id"`
			PostURL    string `json:"post_url"`
			CommentURL string `json:"comment_url"`
			SetKey     string `json:"set_key"`
			Others     []struct {
				ID        int64  `json:"id"`
				PostTitle string `json:"post_title"`
				PostURL   string `json:"post_url"`
				Excerpt   string `json:"excerpt"`
			} `json:"others"`
		}
		require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
		require.Equal(t, readerCommentOutcomePublished, body.Outcome)
		require.Equal(t, rcPostPath, body.PostURL)
		require.Equal(t, rcPostPath+"#comment-500", body.CommentURL)

		// Its own comment only, by its id and its token.
		require.Equal(t, int64(500), published.ID)
		require.Equal(t, hash, published.TokenHash)
		require.Equal(t, db.ReaderCommentApproved, published.Status)
		// The browser key: only its hash is stored, for a year.
		require.Len(t, body.SetKey, accountTokenLen)
		require.NotNil(t, published.NewKey)
		require.Equal(t, hashAccountToken(body.SetKey), published.NewKey.KeyHash)
		require.WithinDuration(t, time.Now().Add(readerCommentKeyTTL), published.NewKey.ExpiresAt, time.Minute)
		// The others are listed, not published.
		require.Len(t, body.Others, 1)
		require.Equal(t, int64(501), body.Others[0].ID)
		require.Equal(t, "/post/other", body.Others[0].PostURL)
		require.Len(t, []rune(body.Others[0].Excerpt), readerCommentExcerptMax)
		requireNoPersonalData(t, logs.String(), token, body.SetKey, rcName, rcBody, "reader@example.com")
	})

	t.Run("a first comment is held as pending", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		expectConfirm(store, rcSettings(), false)
		store.EXPECT().CountPendingReaderCommentsForPost(gomock.Any(), rcPostID).Return(int64(0), nil)
		store.EXPECT().PublishReaderCommentTx(gomock.Any(), gomock.Any()).
			DoAndReturn(func(_ context.Context, arg db.PublishReaderCommentTxParams) (db.ReaderComment, error) {
				require.Equal(t, heldFirstComment, arg.HeldReason.String)
				c := unconfirmedComment(nil)
				c.Status = arg.Status
				return c, nil
			})
		store.EXPECT().ListUnconfirmedReaderCommentsForCommenter(gomock.Any(), gomock.Any()).Return(nil, nil)
		server, _, _ := newCommentTestServer(t, store)
		recorder := postConfirm(t, server, token)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.Contains(t, recorder.Body.String(), `"outcome":"pending"`)
		require.Contains(t, recorder.Body.String(), `"others":[]`)
	})

	t.Run("a guard's stored hold applies without asking it again", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetSettings(gomock.Any()).Return(rcSettings(), nil)
		held := unconfirmedComment(hash)
		held.HeldReason = sql.NullString{String: heldPlugin, Valid: true}
		held.HeldDetail = sql.NullString{String: "Check this", Valid: true}
		store.EXPECT().GetUnconfirmedReaderCommentByToken(gomock.Any(), gomock.Any()).Return(held, nil)
		store.EXPECT().GetReaderCommentPost(gomock.Any(), rcPostID).Return(rcPost(), nil)
		store.EXPECT().GetPostType(gomock.Any(), "post").Return(rcPostType(), nil)
		store.EXPECT().GetCommenter(gomock.Any(), int64(9)).Return(commenter, nil)
		store.EXPECT().CommenterHasApprovedReaderComment(gomock.Any(), gomock.Any()).Return(true, nil)
		store.EXPECT().ListMemberNames(gomock.Any()).Return(nil, nil)
		store.EXPECT().CountPendingReaderCommentsForPost(gomock.Any(), rcPostID).Return(int64(0), nil)
		store.EXPECT().PublishReaderCommentTx(gomock.Any(), gomock.Any()).
			DoAndReturn(func(_ context.Context, arg db.PublishReaderCommentTxParams) (db.ReaderComment, error) {
				require.Equal(t, db.ReaderCommentPending, arg.Status)
				require.Equal(t, heldPlugin, arg.HeldReason.String)
				require.Equal(t, "Check this", arg.HeldDetail.String)
				return db.ReaderComment{ID: 500, Status: arg.Status}, nil
			})
		store.EXPECT().ListUnconfirmedReaderCommentsForCommenter(gomock.Any(), gomock.Any()).Return(nil, nil)
		server, _, _ := newCommentTestServer(t, store)
		server.readerCommentGuard = func(context.Context, *slog.Logger, readerCommentCandidate) readerCommentGuardVerdict {
			t.Fatal("the guard ran again")
			return readerCommentGuardVerdict{}
		}
		require.Equal(t, http.StatusOK, postConfirm(t, server, token).Code)
	})

	for name, tc := range map[string]struct {
		lookupErr error
		txErr     error
		status    int
		code      string
	}{
		"unknown, used or expired": {lookupErr: sql.ErrNoRows, status: http.StatusBadRequest, code: "invalid_token"},
		"spent meanwhile":          {txErr: db.ErrTokenInvalid, status: http.StatusBadRequest, code: "invalid_token"},
		"its parent went":          {txErr: db.ErrReaderCommentParentGone, status: http.StatusNotFound, code: "parent_not_found"},
	} {
		t.Run(name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			if tc.lookupErr != nil {
				store.EXPECT().GetSettings(gomock.Any()).Return(rcSettings(), nil)
				store.EXPECT().GetUnconfirmedReaderCommentByToken(gomock.Any(), gomock.Any()).Return(db.ReaderComment{}, tc.lookupErr)
			} else {
				expectConfirm(store, rcSettings(), true)
				store.EXPECT().PublishReaderCommentTx(gomock.Any(), gomock.Any()).Return(db.ReaderComment{}, tc.txErr)
			}
			server, _, _ := newCommentTestServer(t, store)
			requireErrorCode(t, postConfirm(t, server, token), tc.status, tc.code)
		})
	}

	t.Run("a malformed token is refused without a lookup", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetSettings(gomock.Any()).Return(rcSettings(), nil)
		server, _, _ := newCommentTestServer(t, store)
		requireErrorCode(t, postConfirm(t, server, strings.Repeat("!", accountTokenLen)), http.StatusBadRequest, "invalid_token")
	})

	t.Run("comments turned off since: nothing is spent", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, nil)
		server, _, _ := newCommentTestServer(t, store)
		requireErrorCode(t, postConfirm(t, server, token), http.StatusConflict, "comments_off")
	})

	t.Run("the post closed since: nothing is spent", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetSettings(gomock.Any()).Return(rcSettings(), nil)
		store.EXPECT().GetUnconfirmedReaderCommentByToken(gomock.Any(), gomock.Any()).Return(unconfirmedComment(hash), nil)
		post := rcPost()
		post.Discussion = postDiscussionClosed
		store.EXPECT().GetReaderCommentPost(gomock.Any(), rcPostID).Return(post, nil)
		store.EXPECT().GetPostType(gomock.Any(), "post").Return(rcPostType(), nil)
		server, _, _ := newCommentTestServer(t, store)
		requireErrorCode(t, postConfirm(t, server, token), http.StatusConflict, "comments_closed")
	})

	t.Run("a GET never spends a token", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server, _, _ := newCommentTestServer(t, store)
		for _, path := range []string{"/public/discussion/confirm", "/public/discussion/confirm?token=" + token} {
			recorder := httptest.NewRecorder()
			server.router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
			require.Equal(t, http.StatusNotFound, recorder.Code, "only the button's POST confirms")
		}
	})
}

// --- The confirm page's Publish and Discard (3.3 step 5) ---------------------------

func postUnconfirmed(t *testing.T, server *Server, id, action string, configure func(*http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	return doJSON(t, server, http.MethodPost, "/public/discussion/unconfirmed/"+id, gin.H{"action": action}, configure)
}

func TestUnconfirmedReaderCommentActions(t *testing.T) {
	key, keyHash, err := newAccountToken()
	require.NoError(t, err)

	t.Run("no key, no access", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetSettings(gomock.Any()).Return(rcSettings(), nil).Times(2)
		server, _, _ := newCommentTestServer(t, store)
		requireErrorCode(t, postUnconfirmed(t, server, "501", "publish", nil), http.StatusNotFound, "not_found")
		requireErrorCode(t, postUnconfirmed(t, server, "501", "discard", withKeys("not-a-key")), http.StatusNotFound, "not_found")
	})

	t.Run("an expired or unknown key is no key", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetSettings(gomock.Any()).Return(rcSettings(), nil)
		store.EXPECT().ListCommenterIDsByKeys(gomock.Any(), [][]byte{keyHash}).Return(nil, nil)
		server, _, _ := newCommentTestServer(t, store)
		requireErrorCode(t, postUnconfirmed(t, server, "501", "publish", withKeys(key)), http.StatusNotFound, "not_found")
	})

	t.Run("another address's comment is not found", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetSettings(gomock.Any()).Return(rcSettings(), nil).Times(2)
		store.EXPECT().ListCommenterIDsByKeys(gomock.Any(), gomock.Any()).Return([]int64{9}, nil).Times(2)
		store.EXPECT().GetUnconfirmedReaderCommentForCommenters(gomock.Any(), gomock.Any()).Return(db.ReaderComment{}, sql.ErrNoRows)
		store.EXPECT().DeleteUnconfirmedReaderComment(gomock.Any(), db.DeleteUnconfirmedReaderCommentParams{ID: 501, CommenterIds: []int64{9}}).Return(int64(0), nil)
		server, _, _ := newCommentTestServer(t, store)
		requireErrorCode(t, postUnconfirmed(t, server, "501", "publish", withKeys(key)), http.StatusNotFound, "not_found")
		requireErrorCode(t, postUnconfirmed(t, server, "501", "discard", withKeys(key)), http.StatusNotFound, "not_found")
	})

	t.Run("discard", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetSettings(gomock.Any()).Return(rcSettings(), nil)
		store.EXPECT().ListCommenterIDsByKeys(gomock.Any(), gomock.Any()).Return([]int64{9}, nil)
		store.EXPECT().DeleteUnconfirmedReaderComment(gomock.Any(), gomock.Any()).Return(int64(1), nil)
		server, _, _ := newCommentTestServer(t, store)
		recorder := postUnconfirmed(t, server, "501", "discard", withKeys(key))
		require.Equal(t, http.StatusNoContent, recorder.Code, recorder.Body.String())
	})

	t.Run("publish: the rules decide, no token, no new key", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		store.EXPECT().GetSettings(gomock.Any()).Return(rcSettings(), nil)
		store.EXPECT().ListCommenterIDsByKeys(gomock.Any(), gomock.Any()).Return([]int64{9}, nil)
		other := unconfirmedComment(nil)
		other.ID = 501
		store.EXPECT().GetUnconfirmedReaderCommentForCommenters(gomock.Any(), gomock.Any()).
			DoAndReturn(func(_ context.Context, arg db.GetUnconfirmedReaderCommentForCommentersParams) (db.ReaderComment, error) {
				require.Equal(t, int64(501), arg.ID)
				require.Equal(t, []int64{9}, arg.CommenterIds)
				return other, nil
			})
		store.EXPECT().GetReaderCommentPost(gomock.Any(), rcPostID).Return(rcPost(), nil)
		store.EXPECT().GetPostType(gomock.Any(), "post").Return(rcPostType(), nil)
		store.EXPECT().GetCommenter(gomock.Any(), int64(9)).Return(db.Commenter{ID: 9}, nil)
		store.EXPECT().CommenterHasApprovedReaderComment(gomock.Any(), gomock.Any()).Return(true, nil)
		store.EXPECT().ListMemberNames(gomock.Any()).Return(nil, nil)
		store.EXPECT().PublishReaderCommentTx(gomock.Any(), gomock.Any()).
			DoAndReturn(func(_ context.Context, arg db.PublishReaderCommentTxParams) (db.ReaderComment, error) {
				require.Equal(t, int64(501), arg.ID)
				require.Nil(t, arg.TokenHash)
				require.Nil(t, arg.NewKey)
				return db.ReaderComment{ID: 501, PostID: rcPostID, Status: arg.Status}, nil
			})
		server, _, _ := newCommentTestServer(t, store)
		recorder := postUnconfirmed(t, server, "501", "publish", withKeys(key))
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.JSONEq(t, `{"outcome":"published","comment_id":501,"post_url":"/post/hello-world","comment_url":"/post/hello-world#comment-501"}`, recorder.Body.String())
	})

	t.Run("an unknown action", func(t *testing.T) {
		store := mockdb.NewMockStore(gomock.NewController(t))
		server, _, _ := newCommentTestServer(t, store)
		require.Equal(t, http.StatusBadRequest, postUnconfirmed(t, server, "501", "approve", withKeys(key)).Code)
	})
}

// --- Rate limits on the browser's address (5.3) -----------------------------------

func TestReaderCommentRateLimitsKeyOnTheBrowser(t *testing.T) {
	// The web container (10.9.0.2) is trusted; it forwards the browser's address.
	const web = "10.9.0.2:5000"
	from := func(browser string) func(*http.Request) {
		return func(r *http.Request) {
			r.RemoteAddr = web
			r.Header.Set("X-Forwarded-For", browser)
		}
	}
	offSite := func(store *mockdb.MockStore, n int) {
		store.EXPECT().GetSettings(gomock.Any()).Return(db.Setting{}, nil).Times(n)
	}

	t.Run("per browser", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		offSite(store, 3)
		server := newRateLimitedTestServer(t, store, func(c *util.Config) {
			c.TrustedProxies = "10.9.0.2"
			c.RateLimitCommentPostPerMinute = 2
		})
		for range 2 {
			requireErrorCode(t, postComment(t, server, commentBody("a@example.com"), from("203.0.113.7")), http.StatusConflict, "comments_off")
		}
		requireRateLimited(t, postComment(t, server, commentBody("b@example.com"), from("203.0.113.7")))
		// Another browser behind the same web container is unaffected.
		requireErrorCode(t, postComment(t, server, commentBody("a@example.com"), from("203.0.113.8")), http.StatusConflict, "comments_off")
	})

	t.Run("per browser and address, never the address alone", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		offSite(store, 4)
		server := newRateLimitedTestServer(t, store, func(c *util.Config) {
			c.TrustedProxies = "10.9.0.2"
			c.RateLimitCommentAddressPerMinute = 2
		})
		for range 2 {
			postComment(t, server, commentBody("victim@example.com"), from("203.0.113.7"))
		}
		requireRateLimited(t, postComment(t, server, commentBody("Victim@Example.com"), from("203.0.113.7")))
		// The address from another browser (its owner, say), and another address.
		requireErrorCode(t, postComment(t, server, commentBody("victim@example.com"), from("203.0.113.8")), http.StatusConflict, "comments_off")
		requireErrorCode(t, postComment(t, server, commentBody("other@example.com"), from("203.0.113.7")), http.StatusConflict, "comments_off")
	})

	t.Run("an untrusted peer's X-Forwarded-For is ignored", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		offSite(store, 2)
		server := newRateLimitedTestServer(t, store, func(c *util.Config) {
			c.TrustedProxies = "10.9.0.2"
			c.RateLimitCommentPostPerMinute = 2
		})
		for i := range 3 {
			recorder := postComment(t, server, commentBody("a@example.com"), func(r *http.Request) {
				r.RemoteAddr = "198.51.100.5:1"
				r.Header.Set("X-Forwarded-For", "203.0.113."+string(rune('1'+i)))
			})
			if i < 2 {
				require.Equal(t, http.StatusConflict, recorder.Code)
			} else {
				requireRateLimited(t, recorder)
			}
		}
	})

	t.Run("confirmations are emailed-token endpoints", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		offSite(store, 2)
		server := newRateLimitedTestServer(t, store, func(c *util.Config) {
			c.TrustedProxies = "10.9.0.2"
			c.RateLimitAccountTokenPerMinute = 2
		})
		confirm := func() *httptest.ResponseRecorder {
			return doJSON(t, server, http.MethodPost, "/public/discussion/confirm", gin.H{"token": "x"}, from("203.0.113.7"))
		}
		confirm()
		postUnconfirmed(t, server, "1", "discard", from("203.0.113.7"))
		requireRateLimited(t, confirm())
	})

	t.Run("the mail cooldown is ten minutes", func(t *testing.T) {
		limiter := newIntervalLimiter("comment-mail", readerCommentMailCooldown, true)
		store := limiter.store.(*memoryRateLimitStore)
		now := time.Now()
		store.now = func() time.Time { return now }
		require.True(t, limiter.allowSilently(t.Context(), "a@example.com"))
		now = now.Add(9 * time.Minute)
		require.False(t, limiter.allowSilently(t.Context(), "a@example.com"))
		require.True(t, limiter.allowSilently(t.Context(), "b@example.com"))
		now = now.Add(time.Minute + time.Second)
		require.True(t, limiter.allowSilently(t.Context(), "a@example.com"))
		require.Nil(t, newIntervalLimiter("x", time.Minute, false))
	})

	t.Run("on by default in config", func(t *testing.T) {
		limits, err := newRateLimits(util.Config{RateLimitCommentPostPerMinute: 5, RateLimitCommentAddressPerMinute: 3, RateLimitAccountTokenPerMinute: 10})
		require.NoError(t, err)
		require.NotNil(t, limits.commentPost)
		require.NotNil(t, limits.commentAddress)
		require.NotNil(t, limits.commentMail)
		require.NotNil(t, limits.commentConfirm)
		zero, err := newRateLimits(util.Config{})
		require.NoError(t, err)
		require.Nil(t, zero.commentMail, "a zero Config has every limit off")
	})
}

func TestReaderCommentStoreFailuresAfterTheAnswerAreLogged(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	expectCommentTarget(store, rcSettings())
	store.EXPECT().EnsureCommenter(gomock.Any(), gomock.Any()).Return(db.Commenter{}, errors.New("db down"))
	server, rec, logs := newCommentTestServer(t, store)
	recorder := postComment(t, server, commentBody("reader@example.com"), nil)
	require.Equal(t, http.StatusAccepted, recorder.Code)
	require.Empty(t, rec.messages())
	require.Contains(t, logs.String(), "storing the commenter failed")
	requireNoPersonalData(t, logs.String(), "reader@example.com", rcName, rcBody)
}

func TestReaderCommentFailedStoreKeepsTheMailCooldown(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	commenter := db.Commenter{ID: 10, Email: "reader@example.com", EmailLower: "reader@example.com"}
	for range 2 {
		expectCommentTarget(store, rcSettings())
		store.EXPECT().EnsureCommenter(gomock.Any(), gomock.Any()).Return(commenter, nil)
		store.EXPECT().CountUnconfirmedReaderComments(gomock.Any(), gomock.Any()).Return(int64(0), nil)
	}
	gomock.InOrder(
		store.EXPECT().CreateReaderCommentTx(gomock.Any(), gomock.Any()).Return(db.ReaderComment{}, errors.New("db down")),
		store.EXPECT().CreateReaderCommentTx(gomock.Any(), gomock.Any()).Return(db.ReaderComment{ID: 101, Status: db.ReaderCommentUnconfirmed}, nil),
	)
	server, rec, _ := newCommentTestServer(t, store)
	postComment(t, server, commentBody("reader@example.com"), nil)
	require.Empty(t, rec.messages())
	postComment(t, server, commentBody("reader@example.com"), nil)
	require.Len(t, rec.messages(), 1, "the failed store didn't use up the address's mail")
}

func TestReaderCommentFullQueueRefusesOnlyWhatWouldWait(t *testing.T) {
	key, _, err := newAccountToken()
	require.NoError(t, err)
	commenter := db.Commenter{ID: 9, EmailLower: "reader@example.com"}
	full := func(store *mockdb.MockStore) {
		store.EXPECT().CountPendingReaderCommentsForPost(gomock.Any(), rcPostID).Return(int64(readerCommentPendingCap), nil)
	}

	t.Run("a comment the rules publish goes through", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		expectPostOpen(store)
		expectKeyedRules(store, commenter, true)
		storedComment(store, 400)
		server, _, _ := newCommentTestServer(t, store)
		require.Equal(t, http.StatusCreated, postComment(t, server, commentBody("reader@example.com"), withKeys(key)).Code)
	})

	t.Run("a held one is refused", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		expectPostOpen(store)
		expectKeyedRules(store, commenter, false)
		full(store)
		server, _, _ := newCommentTestServer(t, store)
		requireErrorCode(t, postComment(t, server, commentBody("reader@example.com"), withKeys(key)), http.StatusTooManyRequests, "comments_busy")
	})
}
