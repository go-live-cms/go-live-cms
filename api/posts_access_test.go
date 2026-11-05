package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
	"github.com/go-live-cms/go-live-cms/util"
)

// Edit access requests and grants (#321) against the test database (skipped
// without one): request, notify, grant/decline, revoke, the permissions of each,
// one open request per member and post, the decline cooldown, the rate limit,
// and that a grant is what the collab access lookup and the editor read. The
// database is shared, so every assertion is about this test's own rows.

func ptrBool(v bool) *bool { return &v }

// recheckStub is the collab server's internal listener: it records the user
// re-checks the API asks for (POST /internal/users/:id/recheck).
type recheckStub struct {
	server *httptest.Server
	mu     sync.Mutex
	paths  []string
}

func newRecheckStub(t *testing.T) *recheckStub {
	t.Helper()
	stub := &recheckStub{}
	stub.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		stub.mu.Lock()
		stub.paths = append(stub.paths, r.Method+" "+r.URL.Path)
		stub.mu.Unlock()
		_, _ = w.Write([]byte(`{"docs":1}`))
	}))
	t.Cleanup(stub.server.Close)
	return stub
}

func (stub *recheckStub) rechecks(userID int64) int {
	stub.mu.Lock()
	defer stub.mu.Unlock()
	n := 0
	for _, p := range stub.paths {
		if p == fmt.Sprintf("POST /internal/users/%d/recheck", userID) {
			n++
		}
	}
	return n
}

type accessFixture struct {
	conn    *sql.DB
	store   db.Store
	server  *Server
	mail    *recordingMailer
	collab  *recheckStub
	editor  db.User
	owner   db.User // a contributor who owns post
	asker   db.User // a contributor watching post
	other   db.User // another contributor
	post    db.Post // owner's published post
	modPost db.Post // the editor's published post
}

func newAccessFixture(t *testing.T, adjust func(*util.Config)) accessFixture {
	t.Helper()
	conn, store := scheduleTestDB(t)
	collab := newRecheckStub(t)
	server := authFlowServer(t, store, func(config *util.Config) {
		config.CollabInternalURL = collab.server.URL
		config.CollabInternalSecret = testCollabInternalSecret
		if adjust != nil {
			adjust(config)
		}
	})
	mail := &recordingMailer{}
	server.mailer = mail
	// The emails and the collab re-check run inline, so the test sees them.
	server.runInBackground = func(_, _ string, f func()) { f() }

	f := accessFixture{conn: conn, store: store, server: server, mail: mail, collab: collab}
	f.editor = scheduleUser(t, store, RoleEditor)
	f.owner = scheduleUser(t, store, RoleContributor)
	f.asker = scheduleUser(t, store, RoleContributor)
	f.other = scheduleUser(t, store, RoleContributor)
	f.post = publishForTest(t, store, scheduleDraft(t, store, f.owner, scheduleWord()), f.editor)
	f.modPost = publishForTest(t, store, scheduleDraft(t, store, f.editor, scheduleWord()), f.editor)
	return f
}

func accessPath(post db.Post, rest string) string {
	return fmt.Sprintf("/api/v1/posts/%d%s", post.ID, rest)
}

func getAccessState(t *testing.T, server *Server, caller db.User, post db.Post) PostAccessResponse {
	t.Helper()
	recorder := as(t, server, caller, http.MethodGet, accessPath(post, "/access"), nil)
	requireStatus(t, recorder, http.StatusOK)
	var rsp PostAccessResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	return rsp
}

// collabCanEdit is the collab server's per-connection lookup (GET
// /internal/users/:id/access), as it asks at connect and on every re-check.
func collabCanEdit(t *testing.T, server *Server, user db.User, post db.Post) (int, bool) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet,
		fmt.Sprintf("/internal/users/%d/access?doc=post-%d&issued_at=%d", user.ID, post.ID, time.Now().Unix()), nil)
	request.Header.Set(authorizationHeaderKey, "Bearer "+testRoleLookupSecret)
	recorder := httptest.NewRecorder()
	server.internalRouter.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		return recorder.Code, false
	}
	var body struct {
		CanEdit bool `json:"can_edit"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &body))
	return recorder.Code, body.CanEdit
}

func requestAccess(t *testing.T, f accessFixture, caller db.User, post db.Post, message string) *httptest.ResponseRecorder {
	t.Helper()
	var body any
	if message != "" {
		body = gin.H{"message": message}
	}
	return as(t, f.server, caller, http.MethodPost, accessPath(post, "/access-requests"), body)
}

func decodeRequest(t *testing.T, recorder *httptest.ResponseRecorder) AccessRequestResponse {
	t.Helper()
	var rsp struct {
		Request AccessRequestResponse `json:"request"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp), recorder.Body.String())
	require.NotZero(t, rsp.Request.ID, recorder.Body.String())
	return rsp.Request
}

func errorCode(t *testing.T, recorder *httptest.ResponseRecorder) string {
	t.Helper()
	var rsp struct {
		Code string `json:"code"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp), recorder.Body.String())
	return rsp.Code
}

func mailsTo(messages []mailer.Message, email string) []mailer.Message {
	out := []mailer.Message{}
	for _, m := range messages {
		if m.To == email {
			out = append(out, m)
		}
	}
	return out
}

// TestAccessRequestGrantAndRevoke walks the whole flow: a contributor asks, the
// reviewers are told (email + Needs attention), the owner grants, the grant is
// what the collab lookup and the editor read, the open connection is re-checked
// at once, and a revoke takes it back the same way. Each step is in the log.
func TestAccessRequestGrantAndRevoke(t *testing.T) {
	f := newAccessFixture(t, nil)

	// Before: view-only, may ask.
	state := getAccessState(t, f.server, f.asker, f.post)
	require.False(t, state.CanEdit)
	require.False(t, state.Collaborator)
	require.True(t, state.CanRequest)
	require.Nil(t, state.Request)
	require.False(t, state.CanReview)
	require.Nil(t, state.Pending, "only reviewers see the requests")
	status, canEdit := collabCanEdit(t, f.server, f.asker, f.post)
	require.Equal(t, http.StatusOK, status)
	require.False(t, canEdit)

	created := requestAccess(t, f, f.asker, f.post, "  I'd like to fix the typos.  ")
	requireStatus(t, created, http.StatusCreated)
	request := decodeRequest(t, created)
	require.Equal(t, db.AccessRequestPending, request.Status)
	require.Equal(t, "I'd like to fix the typos.", request.Message, "trimmed")

	// One open request per member and post.
	again := requestAccess(t, f, f.asker, f.post, "")
	requireStatus(t, again, http.StatusConflict)
	require.Equal(t, codeAccessRequestOpen, errorCode(t, again))
	require.Equal(t, request.ID, decodeRequest(t, again).ID, "the open request comes back")

	state = getAccessState(t, f.server, f.asker, f.post)
	require.False(t, state.CanRequest)
	require.NotNil(t, state.Request)
	require.Equal(t, db.AccessRequestPending, state.Request.Status)

	// The reviewers were emailed: the owner and the editor, never the requester.
	sent := f.mail.messages()
	require.Len(t, mailsTo(sent, f.owner.Email), 1)
	require.Len(t, mailsTo(sent, f.editor.Email), 1)
	require.Empty(t, mailsTo(sent, f.asker.Email))
	require.Empty(t, mailsTo(sent, f.other.Email), "another contributor doesn't review this post")
	msg := mailsTo(sent, f.owner.Email)[0]
	require.Equal(t, mailer.TemplateAccessRequest, msg.Template)
	require.Contains(t, msg.Subject, "asked for edit access to "+f.post.Title)
	link := fmt.Sprintf("%s/gl-admin/content/edit/%d", testPublicBaseURL, f.post.ID)
	require.Contains(t, msg.Text, link)
	require.Contains(t, msg.HTML, link)
	require.Contains(t, msg.Text, "I'd like to fix the typos.")

	// The owner and the editor see it; the owner may answer.
	ownerState := getAccessState(t, f.server, f.owner, f.post)
	require.True(t, ownerState.CanReview)
	require.Len(t, ownerState.Pending, 1)
	require.Equal(t, request.ID, ownerState.Pending[0].ID)
	require.Equal(t, f.asker.ID, ownerState.Pending[0].Requester.ID)
	require.Empty(t, ownerState.Collaborators)
	for _, reviewer := range []db.User{f.owner, f.editor} {
		needs := needsAttentionOf(t, f.server, reviewer)
		require.True(t, hasAccessRequest(needs, request.ID), "%s sees the request", reviewer.Role)
	}
	require.False(t, hasAccessRequest(needsAttentionOf(t, f.server, f.other), request.ID))
	require.False(t, hasAccessRequest(needsAttentionOf(t, f.server, f.asker), request.ID))

	// Someone who isn't a reviewer can't answer it.
	grantPath := accessPath(f.post, fmt.Sprintf("/access-requests/%d/grant", request.ID))
	requireStatus(t, as(t, f.server, f.other, http.MethodPost, grantPath, nil), http.StatusForbidden)
	requireStatus(t, as(t, f.server, f.asker, http.MethodPost, grantPath, nil), http.StatusForbidden)
	// A request id from another post is not this post's.
	requireStatus(t, as(t, f.server, f.editor, http.MethodPost, accessPath(f.modPost, fmt.Sprintf("/access-requests/%d/grant", request.ID)), nil), http.StatusNotFound)

	granted := as(t, f.server, f.owner, http.MethodPost, grantPath, nil)
	requireStatus(t, granted, http.StatusOK)
	require.Equal(t, db.AccessRequestGranted, decodeRequest(t, granted).Status)
	require.Equal(t, 1, f.collab.rechecks(f.asker.ID), "the open editor is re-checked at once")

	// Answered once only.
	twice := as(t, f.server, f.editor, http.MethodPost, accessPath(f.post, fmt.Sprintf("/access-requests/%d/decline", request.ID)), nil)
	requireStatus(t, twice, http.StatusConflict)
	require.Equal(t, codeAlreadyAnswered, errorCode(t, twice))

	// The grant is what the collab server and the editor read.
	status, canEdit = collabCanEdit(t, f.server, f.asker, f.post)
	require.Equal(t, http.StatusOK, status)
	require.True(t, canEdit, "a grant makes the connection read-write")
	state = getAccessState(t, f.server, f.asker, f.post)
	require.True(t, state.CanEdit)
	require.True(t, state.Collaborator)
	require.False(t, state.CanRequest)
	ownerState = getAccessState(t, f.server, f.owner, f.post)
	require.Empty(t, ownerState.Pending)
	require.Len(t, ownerState.Collaborators, 1)
	require.Equal(t, f.asker.ID, ownerState.Collaborators[0].ID)
	require.False(t, hasAccessRequest(needsAttentionOf(t, f.server, f.editor), request.ID), "answered: off the list")
	requireStatus(t, requestAccess(t, f, f.asker, f.post, ""), http.StatusConflict)

	// Nothing else: the live fields stay the owner's, so PUT /posts/:id is refused.
	requireStatus(t, as(t, f.server, f.asker, http.MethodPut, accessPath(f.post, ""), gin.H{"title": "Changed"}), http.StatusForbidden)

	// Revoke.
	revokePath := accessPath(f.post, fmt.Sprintf("/collaborators/%d", f.asker.ID))
	requireStatus(t, as(t, f.server, f.other, http.MethodDelete, revokePath, nil), http.StatusForbidden)
	requireStatus(t, as(t, f.server, f.editor, http.MethodDelete, revokePath, nil), http.StatusNoContent)
	require.Equal(t, 2, f.collab.rechecks(f.asker.ID))
	status, canEdit = collabCanEdit(t, f.server, f.asker, f.post)
	require.Equal(t, http.StatusOK, status)
	require.False(t, canEdit, "revoked: read-only again")
	notAny := as(t, f.server, f.editor, http.MethodDelete, revokePath, nil)
	requireStatus(t, notAny, http.StatusNotFound)
	require.Equal(t, codeNotCollaborator, errorCode(t, notAny))
	state = getAccessState(t, f.server, f.asker, f.post)
	require.False(t, state.CanEdit)
	require.True(t, state.CanRequest, "a revoked member may ask again")

	// The log: request (by the asker), grant (by the owner), revoke (by the editor).
	events := objectEvents(t, f.conn, db.ActivityObjectPost, f.post.ID)
	verbs := []string{}
	for _, e := range events {
		if strings.HasPrefix(e.Verb, "access_") {
			verbs = append(verbs, e.Verb)
		}
	}
	require.Equal(t, []string{db.ActivityAccessRequested, db.ActivityAccessGranted, db.ActivityAccessRevoked}, verbs)
	for _, e := range events {
		switch e.Verb {
		case db.ActivityAccessRequested:
			require.Equal(t, f.asker.ID, e.Actor.Int64)
			require.JSONEq(t, fmt.Sprintf(`{"request_id":%d}`, request.ID), e.Payload)
		case db.ActivityAccessGranted:
			require.Equal(t, f.owner.ID, e.Actor.Int64)
			require.JSONEq(t, fmt.Sprintf(`{"user_id":%d,"request_id":%d}`, f.asker.ID, request.ID), e.Payload)
		case db.ActivityAccessRevoked:
			require.Equal(t, f.editor.ID, e.Actor.Int64)
			require.JSONEq(t, fmt.Sprintf(`{"user_id":%d}`, f.asker.ID), e.Payload)
		}
		require.NotContains(t, e.Payload, "typos", "the message is never in the log")
	}

	// The feed names who an event is about, and only the people involved see it.
	feed := getActivity(t, f.server, f.owner, fmt.Sprintf("?post_id=%d", f.post.ID))
	var grant *ActivityResponse
	for i := range feed.Activity {
		if feed.Activity[i].Verb == db.ActivityAccessGranted {
			grant = &feed.Activity[i]
		}
	}
	require.NotNil(t, grant)
	require.NotNil(t, grant.Subject)
	require.Equal(t, f.asker.ID, grant.Subject.ID)
	require.Equal(t, f.asker.Username, grant.Subject.Username)
	for _, viewer := range []db.User{f.asker, f.editor} {
		require.Len(t, accessEvents(getActivity(t, f.server, viewer, fmt.Sprintf("?post_id=%d", f.post.ID))), 3, viewer.Username)
	}
	require.Empty(t, accessEvents(getActivity(t, f.server, f.other, fmt.Sprintf("?post_id=%d", f.post.ID))),
		"another contributor sees the published post's events, not who asked for access")
}

func accessEvents(page activityPage) []ActivityResponse {
	out := []ActivityResponse{}
	for _, e := range page.Activity {
		if strings.HasPrefix(e.Verb, "access_") {
			out = append(out, e)
		}
	}
	return out
}

func needsAttentionOf(t *testing.T, server *Server, caller db.User) NeedsAttentionResponse {
	t.Helper()
	recorder := as(t, server, caller, http.MethodGet, "/api/v1/home/needs-attention", nil)
	requireStatus(t, recorder, http.StatusOK)
	var rsp NeedsAttentionResponse
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &rsp))
	return rsp
}

// hasAccessRequest looks among the listed requests (the newest few). The tests
// in this package run one after another, so the request a test just made is
// the newest one an editor sees.
func hasAccessRequest(needs NeedsAttentionResponse, requestID int64) bool {
	for _, r := range needs.AccessRequests.Posts {
		if r.RequestID == requestID {
			return true
		}
	}
	return false
}

// TestAccessRequestDeclineAndCooldown: a decline grants nothing, and the same
// member can't ask again for that post until the cooldown has passed.
func TestAccessRequestDeclineAndCooldown(t *testing.T) {
	f := newAccessFixture(t, nil)

	created := requestAccess(t, f, f.asker, f.modPost, "")
	requireStatus(t, created, http.StatusCreated)
	request := decodeRequest(t, created)
	require.Empty(t, request.Message)
	// The editor's post: no contributor owner to email, the editor is.
	require.Len(t, mailsTo(f.mail.messages(), f.editor.Email), 1)
	require.Empty(t, mailsTo(f.mail.messages(), f.owner.Email))

	// The owner of another post doesn't review this one.
	requireStatus(t, as(t, f.server, f.owner, http.MethodPost, accessPath(f.modPost, fmt.Sprintf("/access-requests/%d/decline", request.ID)), nil), http.StatusForbidden)
	declined := as(t, f.server, f.editor, http.MethodPost, accessPath(f.modPost, fmt.Sprintf("/access-requests/%d/decline", request.ID)), nil)
	requireStatus(t, declined, http.StatusOK)
	answer := decodeRequest(t, declined)
	require.Equal(t, db.AccessRequestDeclined, answer.Status)
	require.NotNil(t, answer.RequestAgainAt)
	require.Zero(t, f.collab.rechecks(f.asker.ID), "nothing changed for the open editor")

	status, canEdit := collabCanEdit(t, f.server, f.asker, f.modPost)
	require.Equal(t, http.StatusOK, status)
	require.False(t, canEdit)

	state := getAccessState(t, f.server, f.asker, f.modPost)
	require.False(t, state.CanRequest, "within the cooldown")
	require.Equal(t, db.AccessRequestDeclined, state.Request.Status)
	require.NotNil(t, state.Request.RequestAgainAt)
	require.WithinDuration(t, time.Now().Add(accessRequestCooldown), *state.Request.RequestAgainAt, time.Minute)

	again := requestAccess(t, f, f.asker, f.modPost, "please?")
	requireStatus(t, again, http.StatusConflict)
	require.Equal(t, codeRecentlyDeclined, errorCode(t, again))
	require.Contains(t, again.Body.String(), "request_again_at")
	// Other posts and other members aren't held back.
	requireStatus(t, requestAccess(t, f, f.other, f.modPost, ""), http.StatusCreated)

	// Once the cooldown has passed, they may ask again.
	_, err := f.conn.Exec(`UPDATE post_access_requests SET reviewed_at = now() - interval '25 hours' WHERE id = $1`, request.ID)
	require.NoError(t, err)
	require.True(t, getAccessState(t, f.server, f.asker, f.modPost).CanRequest)
	requireStatus(t, requestAccess(t, f, f.asker, f.modPost, "please?"), http.StatusCreated)

	events := objectEvents(t, f.conn, db.ActivityObjectPost, f.modPost.ID)
	verbs := []string{}
	for _, e := range events {
		if strings.HasPrefix(e.Verb, "access_") {
			verbs = append(verbs, e.Verb)
		}
	}
	require.Equal(t, []string{db.ActivityAccessRequested, db.ActivityAccessDeclined, db.ActivityAccessRequested, db.ActivityAccessRequested}, verbs)
}

// TestAccessRequestPermissions: who may ask (a contributor watching someone
// else's published post) and the answers for everyone else.
func TestAccessRequestPermissions(t *testing.T) {
	f := newAccessFixture(t, nil)
	draft := scheduleDraft(t, f.store, f.owner, scheduleWord())
	ctx := context.Background()

	// Moderators and owners can already edit.
	for _, caller := range []db.User{f.editor, f.owner} {
		recorder := requestAccess(t, f, caller, f.post, "")
		requireStatus(t, recorder, http.StatusConflict)
		require.Equal(t, codeAlreadyHasAccess, errorCode(t, recorder))
		require.False(t, getAccessState(t, f.server, caller, f.post).CanRequest)
	}
	require.True(t, getAccessState(t, f.server, f.editor, f.post).CanEdit)

	// Someone else's draft isn't theirs to read, so not to ask for either.
	requireStatus(t, requestAccess(t, f, f.asker, draft, ""), http.StatusForbidden)
	requireStatus(t, as(t, f.server, f.asker, http.MethodGet, accessPath(draft, "/access"), nil), http.StatusForbidden)
	requireStatus(t, as(t, f.server, f.asker, http.MethodGet, "/api/v1/posts/999999999/access", nil), http.StatusNotFound)
	// Too long a message.
	requireStatus(t, requestAccess(t, f, f.asker, f.post, strings.Repeat("x", accessRequestMessageMax+1)), http.StatusBadRequest)
	requireStatus(t, requestAccess(t, f, f.asker, f.post, strings.Repeat("é", accessRequestMessageMax)), http.StatusCreated)

	// No token, no access.
	recorder := doJSON(t, f.server, http.MethodPost, accessPath(f.post, "/access-requests"), nil, nil)
	requireStatus(t, recorder, http.StatusUnauthorized)

	// A grant applies while the post is published only: unpublished, the
	// collaborator can't read it (403, the collab server closes the
	// connection), and the grant rests until it is published again.
	_, err := f.store.ReviewPostAccessRequestTx(ctx, db.ReviewPostAccessRequestTxParams{
		RequestID:  decodeRequest(t, requestAccess(t, f, f.other, f.post, "")).ID,
		ReviewerID: f.editor.ID,
		Grant:      true,
	})
	require.NoError(t, err)
	_, canEdit := collabCanEdit(t, f.server, f.other, f.post)
	require.True(t, canEdit)
	requireStatus(t, as(t, f.server, f.editor, http.MethodPost, accessPath(f.post, "/unpublish"), nil), http.StatusOK)
	status, _ := collabCanEdit(t, f.server, f.other, f.post)
	require.Equal(t, http.StatusForbidden, status)
	requireStatus(t, as(t, f.server, f.other, http.MethodGet, accessPath(f.post, "/access"), nil), http.StatusForbidden)
	republished := publishForTest(t, f.store, reloadPost(t, f.store, f.post.ID), f.editor)
	_, canEdit = collabCanEdit(t, f.server, f.other, republished)
	require.True(t, canEdit, "published again: the grant applies again")

	// In the trash nobody edits it, grant or not, and nobody answers requests.
	requireStatus(t, as(t, f.server, f.editor, http.MethodDelete, accessPath(f.post, ""), nil), http.StatusOK)
	status, _ = collabCanEdit(t, f.server, f.other, f.post)
	require.Equal(t, http.StatusGone, status)
	trashedAsk := requestAccess(t, f, f.editor, f.post, "")
	requireStatus(t, trashedAsk, http.StatusConflict)
	require.Equal(t, codePostTrashed, errorCode(t, trashedAsk), "restore it first, as the other write routes say")
	pending := decodeRequest(t, requestAccess(t, f, f.asker, f.modPost, ""))
	requireStatus(t, as(t, f.server, f.editor, http.MethodDelete, accessPath(f.modPost, ""), nil), http.StatusOK)
	trashed := as(t, f.server, f.editor, http.MethodPost, accessPath(f.modPost, fmt.Sprintf("/access-requests/%d/grant", pending.ID)), nil)
	requireStatus(t, trashed, http.StatusConflict)
	require.Equal(t, codePostTrashed, errorCode(t, trashed))
	require.False(t, hasAccessRequest(needsAttentionOf(t, f.server, f.editor), pending.ID), "a trashed post's requests leave the list")
}

// TestAccessRequestRateLimit: the per member+IP limit answers 429 before
// anything is written or emailed.
func TestAccessRequestRateLimit(t *testing.T) {
	f := newAccessFixture(t, func(config *util.Config) { config.RateLimitAccessRequestPerMinute = 1 })
	requireStatus(t, requestAccess(t, f, f.asker, f.post, ""), http.StatusCreated)
	sent := len(f.mail.messages())
	// Asking again for the same post is answered before the limit: 409, not 429.
	requireStatus(t, requestAccess(t, f, f.asker, f.post, ""), http.StatusConflict)

	limited := requestAccess(t, f, f.asker, f.modPost, "")
	requireStatus(t, limited, http.StatusTooManyRequests)
	require.NotEmpty(t, limited.Header().Get("Retry-After"))
	require.Len(t, f.mail.messages(), sent, "no email for a refused request")
	require.Nil(t, getAccessState(t, f.server, f.asker, f.modPost).Request)

	// Another member has their own allowance.
	requireStatus(t, requestAccess(t, f, f.other, f.modPost, ""), http.StatusCreated)
}

// TestAccessRequestReviewRace: two reviewers answering at once, one wins.
func TestAccessRequestReviewRace(t *testing.T) {
	f := newAccessFixture(t, nil)
	request := decodeRequest(t, requestAccess(t, f, f.asker, f.post, ""))

	var wg sync.WaitGroup
	errs := make([]error, 2)
	for i, grant := range []bool{true, false} {
		wg.Add(1)
		go func(i int, grant bool) {
			defer wg.Done()
			_, errs[i] = f.store.ReviewPostAccessRequestTx(context.Background(), db.ReviewPostAccessRequestTxParams{RequestID: request.ID, ReviewerID: f.editor.ID, Grant: grant})
		}(i, grant)
	}
	wg.Wait()
	answered := 0
	for _, err := range errs {
		if err == nil {
			continue
		}
		require.ErrorIs(t, err, db.ErrAccessRequestAnswered)
		answered++
	}
	require.Equal(t, 1, answered, "exactly one answer wins")

	current, err := f.store.GetPostAccessRequest(context.Background(), request.ID)
	require.NoError(t, err)
	collaborator, err := f.store.IsPostCollaborator(context.Background(), db.IsPostCollaboratorParams{PostID: f.post.ID, UserID: f.asker.ID})
	require.NoError(t, err)
	require.Equal(t, current.Status == db.AccessRequestGranted, collaborator, "a grant row exactly when the grant won")

	_, err = f.store.ReviewPostAccessRequestTx(context.Background(), db.ReviewPostAccessRequestTxParams{RequestID: 999999999, ReviewerID: f.editor.ID, Grant: true})
	require.ErrorIs(t, err, db.ErrAccessRequestAnswered)
}

func TestMayRequestAgain(t *testing.T) {
	now := time.Now()
	reviewed := func(ago time.Duration) sql.NullTime { return sql.NullTime{Time: now.Add(-ago), Valid: true} }
	require.True(t, mayRequestAgain(nil, now))
	require.False(t, mayRequestAgain(&db.PostAccessRequest{Status: db.AccessRequestPending}, now))
	require.False(t, mayRequestAgain(&db.PostAccessRequest{Status: db.AccessRequestDeclined, ReviewedAt: reviewed(time.Hour)}, now))
	require.True(t, mayRequestAgain(&db.PostAccessRequest{Status: db.AccessRequestDeclined, ReviewedAt: reviewed(accessRequestCooldown)}, now))
	require.True(t, mayRequestAgain(&db.PostAccessRequest{Status: db.AccessRequestGranted, ReviewedAt: reviewed(time.Minute)}, now))
}

// The rules on their own (auth_posts.go).
func TestEditAccessRules(t *testing.T) {
	contributor := db.User{ID: 5, Role: RoleContributor}
	editor := db.User{ID: 6, Role: RoleEditor}
	theirs := func(status string) db.Post { return db.Post{ID: 1, UserID: 9, PostStatus: status} }
	own := db.Post{ID: 2, UserID: 5, PostStatus: "published"}

	require.True(t, canRequestPostAccess(contributor, theirs("published")))
	for _, status := range []string{"draft", "scheduled", "archived", "trash"} {
		require.False(t, canRequestPostAccess(contributor, theirs(status)), status)
		require.False(t, canEditAsCollaborator(contributor, theirs(status)), status)
	}
	require.False(t, canRequestPostAccess(contributor, own))
	require.False(t, canRequestPostAccess(editor, theirs("published")))
	require.False(t, canRequestPostAccess(db.User{ID: 7, Role: "subscriber"}, theirs("published")))

	require.True(t, canReviewPostAccess(editor, theirs("draft")))
	require.True(t, canReviewPostAccess(contributor, own))
	require.False(t, canReviewPostAccess(contributor, theirs("published")))
	require.False(t, canReviewPostAccess(editor, theirs("trash")))
	require.False(t, canReviewPostAccess(contributor, db.Post{UserID: 5, PostStatus: "trash"}))
}
