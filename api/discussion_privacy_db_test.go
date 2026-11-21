package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
)

// A commenter's export and erasure (#529, discussion_privacy.go) against the test database
// (skipped without one): admins only (an editor can't erase), every status and nothing
// hashed in the file, erasure through the route, the reader's data request answering the
// same for any address, the link's flow, and no address in any log line. The store-level
// rules of erasure (tombstones exactly where approved replies are, the outbox, one
// transaction) are db/sqlc's TestEraseCommenterTx*.

// fixtureNetworkHash is discussionFixture.comment's network hash.
var fixtureNetworkHash = []byte("0123456789abcdef0123456789abcdef")

// privacyFixture is a mail fixture (recording mailer, captured logs, background work
// inline) with a moderator's view for the admin routes.
type privacyFixture struct {
	mailFixture
	contributor db.User
}

func newPrivacyFixture(t *testing.T) privacyFixture {
	t.Helper()
	f := privacyFixture{mailFixture: newMailFixture(t)}
	f.contributor = scheduleUser(t, f.store, RoleContributor)
	return f
}

func (f privacyFixture) call(t *testing.T, caller *db.User, method, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	return trashCall(t, f.server, caller, method, path, body)
}

func (f privacyFixture) public(t *testing.T, path string, body any) *httptest.ResponseRecorder {
	t.Helper()
	return doJSON(t, f.server, http.MethodPost, "/public/discussion/"+path, body, nil)
}

// dataLink asks for the address's link and returns the token mailed to it.
func (f privacyFixture) dataLink(t *testing.T, email string) string {
	t.Helper()
	before := len(f.mail.messages())
	recorder := f.public(t, "data-request", map[string]any{"email": email})
	require.Equal(t, http.StatusAccepted, recorder.Code, recorder.Body.String())
	sent := ofTemplate(f.mail.messages()[before:], mailer.TemplateReaderCommentData)
	require.Len(t, sent, 1)
	prefix := f.server.publicURL + readerCommentDataPath + "#token="
	at := strings.Index(sent[0].Text, prefix)
	require.GreaterOrEqual(t, at, 0, sent[0].Text)
	token := strings.Fields(sent[0].Text[at+len(prefix):])[0]
	require.NotEmpty(t, token)
	return token
}

func (f privacyFixture) export(t *testing.T, recorder *httptest.ResponseRecorder) CommenterExport {
	t.Helper()
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var out CommenterExport
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &out))
	return out
}

func exportIDs(out CommenterExport) map[int64]string {
	ids := map[int64]string{}
	for _, c := range out.Comments {
		ids[c.ID] = c.Status
	}
	return ids
}

// requireNothingHashed: the file holds no hash, key or token, by name or by value.
func requireNothingHashed(t *testing.T, raw string, secrets ...[]byte) {
	t.Helper()
	for _, field := range []string{"hash", "network", "key", "token"} {
		require.NotContains(t, strings.ToLower(raw), `"`+field, "no %q field in the file", field)
	}
	for _, secret := range secrets {
		for _, form := range []string{string(secret), hex.EncodeToString(secret), base64.StdEncoding.EncodeToString(secret), base64.RawURLEncoding.EncodeToString(secret)} {
			require.NotContains(t, raw, form)
		}
	}
}

// Export and Erase are admins' (13.1, 15.1): an editor, who moderates and sees the
// address, gets 403 and nothing is erased; a contributor 403; anonymous 401.
func TestCommenterExportAndEraseAreAdminsOnly(t *testing.T) {
	f := newPrivacyFixture(t)
	ana := f.ana
	comment := f.comment(t, f.post, ana, nil, db.ReaderCommentApproved)
	exportPath := fmt.Sprintf("/api/v1/discussion/commenters/%d/export", ana.ID)
	erasePath := fmt.Sprintf("/api/v1/discussion/commenters/%d", ana.ID)

	for _, caller := range []*db.User{&f.editor, &f.other, &f.contributor} {
		require.Equal(t, http.StatusForbidden, f.call(t, caller, http.MethodGet, exportPath, nil).Code)
		require.Equal(t, http.StatusForbidden, f.call(t, caller, http.MethodDelete, erasePath, nil).Code)
	}
	require.Equal(t, http.StatusUnauthorized, f.call(t, nil, http.MethodGet, exportPath, nil).Code)
	require.Equal(t, http.StatusUnauthorized, f.call(t, nil, http.MethodDelete, erasePath, nil).Code)
	_, err := f.store.GetCommenter(context.Background(), ana.ID)
	require.NoError(t, err, "an editor's erase did nothing")
	require.True(t, f.exists(t, comment.ID))
	// An editor still has the commenter's page (Block, #526).
	require.Equal(t, http.StatusOK, f.call(t, &f.editor, http.MethodGet, erasePath, nil).Code)

	require.Equal(t, http.StatusOK, f.call(t, &f.admin, http.MethodGet, exportPath, nil).Code)
	require.Equal(t, http.StatusOK, f.call(t, &f.admin, http.MethodDelete, erasePath, nil).Code)
}

// The admin's export: every comment of the address in every status, unconfirmed
// included, the names and subscriptions, a download, nothing hashed; commenter_exported.
// Erase: the counts, commenter_erased with the count and no address, then 404.
func TestCommenterAdminExportAndErase(t *testing.T) {
	f := newPrivacyFixture(t)
	m := moderationFixture{commentsFixture: f.commentsFixture}
	ana, bea := f.ana, f.bea
	answered := f.comment(t, f.post, ana, nil, db.ReaderCommentApproved)
	f.comment(t, f.post, bea, &answered, db.ReaderCommentApproved)
	pending := f.comment(t, f.post, ana, nil, db.ReaderCommentPending)
	spam := f.comment(t, f.post, ana, nil, db.ReaderCommentSpam)
	unconfirmed := f.comment(t, f.post, ana, nil, db.ReaderCommentUnconfirmed)
	trashed := f.comment(t, f.post, ana, nil, db.ReaderCommentPending)
	code, body := m.call(t, &f.editor, http.MethodPut, fmt.Sprintf("/api/v1/discussion/comments/%d/status", trashed.ID), map[string]any{"action": "trash"})
	require.Equal(t, http.StatusOK, code, body)
	keySum := sha256.Sum256([]byte("browser-key-" + uuid.NewString()))
	key := keySum[:]
	_, err := f.store.CreateCommenterKey(context.Background(), db.CreateCommenterKeyParams{KeyHash: key, CommenterID: ana.ID, ExpiresAt: time.Now().Add(time.Hour)})
	require.NoError(t, err)

	recorder := f.call(t, &f.admin, http.MethodGet, fmt.Sprintf("/api/v1/discussion/commenters/%d/export", ana.ID), nil)
	require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
	require.Equal(t, fmt.Sprintf(`attachment; filename="commenter-%d.json"`, ana.ID), recorder.Header().Get("Content-Disposition"))
	raw := recorder.Body.String()
	out := f.export(t, recorder)
	require.Equal(t, ana.Email, out.Commenter.Email, "the address in full, as typed")
	require.Equal(t, []string{ana.DisplayName}, out.Commenter.NamesUsed)
	require.Equal(t, map[int64]string{
		answered.ID: db.ReaderCommentApproved, pending.ID: db.ReaderCommentPending, spam.ID: db.ReaderCommentSpam,
		unconfirmed.ID: db.ReaderCommentUnconfirmed, trashed.ID: db.ReaderCommentTrash,
	}, exportIDs(out), "every status, and only Ana's")
	for _, c := range out.Comments {
		require.NotEmpty(t, c.Body)
		require.True(t, strings.HasPrefix(c.PostURL, "/"), c.PostURL)
		if c.ID == answered.ID {
			require.NotNil(t, c.CommentURL)
			require.True(t, strings.HasSuffix(*c.CommentURL, fmt.Sprintf("#comment-%d", c.ID)))
		}
	}
	require.Len(t, out.Subscriptions, 4, "every comment but the unconfirmed one asked for replies")
	requireNothingHashed(t, raw, fixtureNetworkHash, key)
	require.Equal(t, []string{db.ActivityCommenterExported}, m.verbs(t, db.ActivityObjectCommenter, ana.ID))

	recorder = f.call(t, &f.admin, http.MethodDelete, fmt.Sprintf("/api/v1/discussion/commenters/%d", ana.ID), nil)
	require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
	var erased struct {
		CommentCount int `json:"comment_count"`
		Tombstoned   int `json:"tombstoned"`
	}
	require.NoError(t, json.Unmarshal(recorder.Body.Bytes(), &erased))
	require.Equal(t, 5, erased.CommentCount)
	require.Equal(t, 1, erased.Tombstoned)
	require.True(t, f.reload(t, answered.ID).RemovedAt.Valid)
	for _, id := range []int64{pending.ID, spam.ID, unconfirmed.ID, trashed.ID} {
		require.False(t, f.exists(t, id))
	}
	require.Equal(t, []string{db.ActivityCommenterExported, db.ActivityCommenterErased}, m.verbs(t, db.ActivityObjectCommenter, ana.ID))
	var payload string
	require.NoError(t, f.conn.QueryRow(`SELECT payload::text FROM activity WHERE object_type = 'commenter' AND object_id = $1 AND verb = $2`,
		ana.ID, db.ActivityCommenterErased).Scan(&payload))
	require.JSONEq(t, `{"comment_count": 5}`, payload)

	require.Equal(t, http.StatusNotFound, f.call(t, &f.admin, http.MethodGet, fmt.Sprintf("/api/v1/discussion/commenters/%d", ana.ID), nil).Code)
	require.Equal(t, http.StatusNotFound, f.call(t, &f.admin, http.MethodDelete, fmt.Sprintf("/api/v1/discussion/commenters/%d", ana.ID), nil).Code)
	require.Equal(t, http.StatusNotFound, f.call(t, &f.admin, http.MethodGet, fmt.Sprintf("/api/v1/discussion/commenters/%d/export", ana.ID), nil).Code)
}

// The data request answers the same 202 for an address with comments, one without, a
// blocked one, one in its mail cooldown and one typed in another case, and mails only an
// address comments were written with: a link and nothing else.
func TestCommenterDataRequestAnswersTheSame(t *testing.T) {
	f := newPrivacyFixture(t)
	f.server.rateLimits.commentDataMail = newIntervalLimiter("test-comment-data-mail", time.Minute, true)
	comment := f.comment(t, f.post, f.ana, nil, db.ReaderCommentApproved)
	blocked := f.commenter(t)
	_, err := f.store.SetCommenterBlocked(context.Background(), db.SetCommenterBlockedParams{ID: blocked.ID, Blocked: true})
	require.NoError(t, err)
	unknown := "nobody." + uuid.NewString()[:8] + "@example.test"

	type answer struct {
		Code  int
		Body  string
		Cache string
	}
	ask := func(email string) answer {
		recorder := f.public(t, "data-request", map[string]any{"email": email})
		return answer{recorder.Code, recorder.Body.String(), recorder.Header().Get("Cache-Control")}
	}
	before := len(f.mail.messages())
	first := ask(f.ana.Email)
	require.Equal(t, http.StatusAccepted, first.Code)
	for _, email := range []string{unknown, blocked.Email, f.ana.Email, strings.ToUpper(f.ana.Email)} {
		require.Equal(t, first, ask(email), email)
	}
	sent := ofTemplate(f.mail.messages()[before:], mailer.TemplateReaderCommentData)
	require.Len(t, sent, 2, "Ana once (then her cooldown), the blocked commenter once, nobody for the unknown address")
	require.ElementsMatch(t, []string{f.ana.Email, blocked.Email}, []string{sent[0].To, sent[1].To})
	for _, msg := range sent {
		require.NotContains(t, msg.Text+msg.HTML, f.ana.DisplayName, "a link and nothing else")
		require.NotContains(t, msg.Text+msg.HTML, comment.Body)
		require.Contains(t, msg.Text, f.server.publicURL+readerCommentDataPath+"#token=")
	}

	// A malformed address is refused whatever it is: it says nothing about the address.
	require.Equal(t, http.StatusBadRequest, f.public(t, "data-request", map[string]any{"email": "not an address"}).Code)
}

// Nothing the data request does before its answer touches the address (as the comment
// form, #524): with a store that may not be called and no background work run, every
// address gets the same answer.
func TestCommenterDataRequestReadsNothingBeforeAnswering(t *testing.T) {
	store := mockdb.NewMockStore(gomock.NewController(t)) // any call fails the test
	server := newTestServer(t, store)
	var queued int
	server.runInBackground = func(_, _ string, _ func()) { queued++ }
	var answers []string
	for _, email := range []string{"known@example.test", "unknown@example.test", "Blocked@Example.test"} {
		recorder := doJSON(t, server, http.MethodPost, "/public/discussion/data-request", map[string]any{"email": email}, nil)
		require.Equal(t, http.StatusAccepted, recorder.Code)
		answers = append(answers, recorder.Body.String())
	}
	require.Equal(t, 3, queued)
	require.Equal(t, answers[0], answers[1])
	require.Equal(t, answers[0], answers[2])
	require.JSONEq(t, `{"outcome": "link_sent"}`, answers[0])
}

// The link: the reader's own file (the same as the admin's), not spent by reading; Delete
// takes only their comments; Stop all mail; Delete everything erases and ends the link.
// It all works with comments off for the site.
func TestCommenterDataLink(t *testing.T) {
	f := newPrivacyFixture(t)
	answered := f.comment(t, f.post, f.ana, nil, db.ReaderCommentApproved)
	beaReply := f.comment(t, f.post, f.bea, &answered, db.ReaderCommentApproved)
	pending := f.comment(t, f.post, f.ana, nil, db.ReaderCommentPending)
	spam := f.comment(t, f.post, f.ana, nil, db.ReaderCommentSpam)
	token := f.dataLink(t, f.ana.Email)
	f.settings(t, map[string]any{"comments_enabled": false})

	for range 2 {
		recorder := f.public(t, "data", map[string]any{"token": token})
		require.Equal(t, "no-store", recorder.Header().Get("Cache-Control"))
		raw := recorder.Body.String()
		out := f.export(t, recorder)
		require.Equal(t, f.ana.Email, out.Commenter.Email)
		require.Equal(t, map[int64]string{answered.ID: db.ReaderCommentApproved, pending.ID: db.ReaderCommentPending, spam.ID: db.ReaderCommentSpam}, exportIDs(out))
		requireNothingHashed(t, raw, fixtureNetworkHash)
	}
	for _, bad := range []string{"", "not-a-token", strings.Repeat("A", 43)} {
		recorder := f.public(t, "data", map[string]any{"token": bad})
		require.Equal(t, http.StatusBadRequest, recorder.Code, bad)
	}
	require.Contains(t, f.public(t, "data", map[string]any{"token": strings.Repeat("A", 43)}).Body.String(), "invalid_token")

	// Delete: only Ana's own.
	recorder := f.public(t, "data/delete", map[string]any{"token": token, "comment_id": beaReply.ID})
	require.Equal(t, http.StatusNotFound, recorder.Code)
	require.True(t, f.exists(t, beaReply.ID))
	require.Equal(t, http.StatusNoContent, f.public(t, "data/delete", map[string]any{"token": token, "comment_id": pending.ID}).Code)
	require.False(t, f.exists(t, pending.ID))

	// Stop all mail.
	require.Equal(t, http.StatusNoContent, f.public(t, "data/unsubscribe", map[string]any{"token": token}).Code)
	require.False(t, f.reload(t, answered.ID).NotifyReplies)
	require.False(t, f.reload(t, spam.ID).NotifyReplies)

	// Delete everything: the erasure, then the link is gone with the commenter.
	require.Equal(t, http.StatusNoContent, f.public(t, "data/delete", map[string]any{"token": token}).Code)
	require.True(t, f.reload(t, answered.ID).RemovedAt.Valid, "Bea's reply keeps a tombstone")
	require.False(t, f.exists(t, spam.ID))
	_, err := f.store.GetCommenter(context.Background(), f.ana.ID)
	require.Error(t, err)
	require.Equal(t, http.StatusBadRequest, f.public(t, "data", map[string]any{"token": token}).Code)
	m := moderationFixture{commentsFixture: f.commentsFixture}
	require.Empty(t, m.verbs(t, db.ActivityObjectCommenter, f.ana.ID), "self-service leaves no activity (7.4)")
}

// A link works for its hour; the maintenance job deletes it after.
func TestCommenterDataLinkExpires(t *testing.T) {
	f := newPrivacyFixture(t)
	f.comment(t, f.post, f.ana, nil, db.ReaderCommentPending)
	token := f.dataLink(t, f.ana.Email)
	hash, ok := parseAccountToken(token)
	require.True(t, ok)
	_, err := f.conn.Exec(`UPDATE commenter_data_tokens SET expires_at = now() - interval '1 second' WHERE token_hash = $1`, hash)
	require.NoError(t, err)
	require.Equal(t, http.StatusBadRequest, f.public(t, "data", map[string]any{"token": token}).Code)
	require.GreaterOrEqual(t, f.maintain(t).DataLinksDeleted, int64(1))
	var left int
	require.NoError(t, f.conn.QueryRow(`SELECT count(*) FROM commenter_data_tokens WHERE token_hash = $1`, hash).Scan(&left))
	require.Zero(t, left)
}

// Every reader mail links "Manage your comments" (13.2).
func TestReaderMailsLinkYourData(t *testing.T) {
	f := newPrivacyFixture(t)
	root := f.comment(t, f.post, f.ana, nil, db.ReaderCommentApproved)
	reply := f.comment(t, f.post, f.bea, &root, db.ReaderCommentPending)
	f.approve(t, f.other, reply.ID)
	f.due(t)
	sent := ofTemplate(mailsTo(f.drain(t), f.ana.Email), mailer.TemplateReaderCommentReply)
	require.Len(t, sent, 1)
	require.Contains(t, sent[0].Text, "Manage your comments: "+f.server.publicURL+readerCommentDataPath)
	require.Contains(t, sent[0].HTML, f.server.publicURL+readerCommentDataPath)
}

// No address, name, text or token in any log line of the new paths (#528's log guard,
// TestDiscussionMailLogsHoldNoAddress, extended to #529): the request (mailed, unknown,
// a relay that refuses quoting the address), the link's reads, delete, unsubscribe and
// erasure, and the admin's export and erase.
func TestCommenterPrivacyLogsHoldNoAddress(t *testing.T) {
	f := newPrivacyFixture(t)
	ana, bea := f.ana, f.bea
	answered := f.comment(t, f.post, ana, nil, db.ReaderCommentApproved)
	f.comment(t, f.post, bea, &answered, db.ReaderCommentApproved)
	pending := f.comment(t, f.post, ana, nil, db.ReaderCommentPending)
	beaOwn := f.comment(t, f.post, bea, nil, db.ReaderCommentPending)

	f.mail.err = fmt.Errorf("550 5.1.1 <%s>: Recipient address rejected", bea.Email)
	require.Equal(t, http.StatusAccepted, f.public(t, "data-request", map[string]any{"email": bea.Email}).Code)
	f.mail.err = nil
	require.Equal(t, http.StatusAccepted, f.public(t, "data-request", map[string]any{"email": "nobody." + uuid.NewString()[:8] + "@example.test"}).Code)
	token := f.dataLink(t, ana.Email)
	require.Equal(t, http.StatusOK, f.public(t, "data", map[string]any{"token": token}).Code)
	require.Equal(t, http.StatusNoContent, f.public(t, "data/delete", map[string]any{"token": token, "comment_id": pending.ID}).Code)
	require.Equal(t, http.StatusNoContent, f.public(t, "data/unsubscribe", map[string]any{"token": token}).Code)
	require.Equal(t, http.StatusNoContent, f.public(t, "data/delete", map[string]any{"token": token}).Code)
	require.Equal(t, http.StatusOK, f.call(t, &f.admin, http.MethodGet, fmt.Sprintf("/api/v1/discussion/commenters/%d/export", bea.ID), nil).Code)
	require.Equal(t, http.StatusOK, f.call(t, &f.admin, http.MethodDelete, fmt.Sprintf("/api/v1/discussion/commenters/%d", bea.ID), nil).Code)

	logs := f.logs.String()
	for _, line := range []string{"commenter data email sent", "commenter data email failed", "commenter data request: no comments with the address",
		"commenter_data_read", "commenter_comment_deleted", "reader_comment_unsubscribed", "commenter_erased", "discussion_commenter_exported"} {
		require.Contains(t, logs, line)
	}
	requireNoPersonalData(t, logs,
		ana.Email, strings.ToLower(ana.Email), bea.Email, strings.ToLower(bea.Email), ana.DisplayName,
		answered.Body, pending.Body, beaOwn.Body, token, "Recipient address rejected")
}
