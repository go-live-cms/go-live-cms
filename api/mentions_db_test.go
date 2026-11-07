package api

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
)

// #320 through the real routers against the test database (skipped without one): the @
// menu's routes, mention emails after collab stores (once, never to someone who can't
// read the post), the public API's mentions and links (names and current URLs, never
// ids or emails), and reminders sent by the scheduler.

type mentionFixture struct {
	conn   *sql.DB
	store  db.Store
	server *Server
	mail   *recordingMailer

	editor, admin, owner, viewer db.User
	draft, published             db.Post
}

func newMentionFixture(t *testing.T) mentionFixture {
	t.Helper()
	conn, store := scheduleTestDB(t)
	server := scheduleServer(t, store, newStubCollab(t, 0))
	mail := &recordingMailer{}
	server.mailer = mail
	// The mention emails run inline, so the test sees them.
	server.runInBackground = func(_, _ string, f func()) { f() }
	f := mentionFixture{conn: conn, store: store, server: server, mail: mail}
	f.editor = scheduleUser(t, store, RoleEditor)
	f.admin = scheduleUser(t, store, RoleAdmin)
	f.owner = scheduleUser(t, store, RoleContributor)
	f.viewer = scheduleUser(t, store, RoleContributor)
	f.draft = scheduleDraft(t, store, f.owner, scheduleWord())
	f.published = publishForTest(t, store, scheduleDraft(t, store, f.owner, scheduleWord()), f.editor)
	return f
}

// inlineBlock is a paragraph block whose pm holds nodes.
func inlineBlock(id string, nodes ...map[string]any) map[string]any {
	content := make([]any, len(nodes))
	for i, n := range nodes {
		content[i] = n
	}
	return map[string]any{"id": id, "type": "paragraph", "version": 1, "attrs": map[string]any{
		"pm":   map[string]any{"type": "paragraph", "content": content},
		"text": "Inline text of " + id,
	}}
}

func mentionOf(user db.User, label string) map[string]any {
	return map[string]any{"type": "mention", "attrs": map[string]any{"userId": user.ID, "label": label}}
}

func textNode(s string) map[string]any { return map[string]any{"type": "text", "text": s} }

// storeDoc stores blocks (in order) through the collab server's internal PUT, with the
// blocks in editedBy attributed to that user (#328), and returns the post's new revision.
func (f mentionFixture) storeDoc(t *testing.T, post db.Post, blocks []map[string]any, editedBy map[string]db.User) {
	t.Helper()
	order := []string{}
	byID := map[string]any{}
	for _, b := range blocks {
		id := b["id"].(string)
		order = append(order, id)
		byID[id] = b
	}
	edits := []map[string]any{}
	for id, user := range editedBy {
		edits = append(edits, map[string]any{"block_id": id, "user_id": user.ID, "edited_at": time.Now().UTC().Format(time.RFC3339)})
	}
	body, err := json.Marshal(map[string]any{
		"state":         base64.StdEncoding.EncodeToString([]byte{1, 2, 3}),
		"epoch":         "6f1c5f4e-9a59-4d55-9a4d-2b8f0d9e1a01",
		"block_doc":     map[string]any{"doc_version": 1, "blocks_order": order, "blocks": byID},
		"base_revision": reloadPost(t, f.store, post.ID).BlockRevision,
		"block_edits":   edits,
	})
	require.NoError(t, err)
	rec := internalCollabRequest(t, f.server, http.MethodPut, fmt.Sprintf("/internal/posts/%d/collab", post.ID), body, "Bearer "+testRoleLookupSecret)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
}

func (f mentionFixture) mentionMails(to db.User) []mailer.Message {
	out := []mailer.Message{}
	for _, m := range mailsTo(f.mail.messages(), to.Email) {
		if m.Template == mailer.TemplateMention {
			out = append(out, m)
		}
	}
	return out
}

func TestMentionEmails_OncePerMemberAndPost(t *testing.T) {
	f := newMentionFixture(t)

	// The editor types two mentions in the owner's published post: the viewer (who can
	// read it) and the admin get one email each.
	f.storeDoc(t, f.published, []map[string]any{
		inlineBlock("blk-men-a001", textNode("Ask "), mentionOf(f.viewer, "Viewer"), textNode(" and "), mentionOf(f.admin, "Admin")),
	}, map[string]db.User{"blk-men-a001": f.editor})
	require.Len(t, f.mentionMails(f.viewer), 1)
	require.Len(t, f.mentionMails(f.admin), 1)
	mail := f.mentionMails(f.viewer)[0]
	require.Equal(t, fmt.Sprintf("%s mentioned you in %s", f.editor.FullName, f.published.Title), mail.Subject)
	require.Contains(t, mail.Text, fmt.Sprintf("/gl-admin/content/edit/%d", f.published.ID))
	// The email names the post, never its content.
	require.NotContains(t, mail.Text, "Inline text of")

	// Every later store (more typing, a split into a new block, a move, a re-store) is
	// quiet: one email per member and post.
	f.storeDoc(t, f.published, []map[string]any{
		inlineBlock("blk-men-a001", textNode("Ask")),
		inlineBlock("blk-men-a002", mentionOf(f.viewer, "Viewer"), textNode(" and "), mentionOf(f.admin, "Admin"), textNode(" please")),
	}, map[string]db.User{"blk-men-a001": f.editor, "blk-men-a002": f.editor})
	f.storeDoc(t, f.published, []map[string]any{
		inlineBlock("blk-men-a002", mentionOf(f.viewer, "Viewer"), mentionOf(f.admin, "Admin")),
	}, map[string]db.User{"blk-men-a002": f.owner})
	require.Len(t, f.mentionMails(f.viewer), 1)
	require.Len(t, f.mentionMails(f.admin), 1)

	ledger, err := f.store.ListPostMentionNotifications(context.Background(), f.published.ID)
	require.NoError(t, err)
	require.Len(t, ledger, 2)
	for _, row := range ledger {
		require.True(t, row.Emailed)
		require.Equal(t, "blk-men-a001", row.BlockID)
		require.Equal(t, f.editor.ID, row.MentionedBy.Int64)
	}
}

func TestMentionEmails_NobodyWhoCantReadThePost(t *testing.T) {
	f := newMentionFixture(t)

	// The owner's draft: another contributor (the viewer) can't read it. No email, and
	// nothing tells them the post exists; the editor (a moderator) does get one.
	f.storeDoc(t, f.draft, []map[string]any{
		inlineBlock("blk-men-d001", mentionOf(f.viewer, "Viewer"), mentionOf(f.editor, "Editor")),
	}, map[string]db.User{"blk-men-d001": f.owner})
	require.Empty(t, f.mentionMails(f.viewer))
	require.Len(t, f.mentionMails(f.editor), 1)
	for _, m := range f.mail.messages() {
		if m.To == f.viewer.Email {
			t.Fatalf("the viewer got %q about a draft they can't read", m.Subject)
		}
	}

	// Published later: still no late email (the mention was recorded, not emailed).
	publishForTest(t, f.store, f.draft, f.editor)
	f.storeDoc(t, f.draft, []map[string]any{
		inlineBlock("blk-men-d001", mentionOf(f.viewer, "Viewer"), mentionOf(f.editor, "Editor"), textNode("!")),
	}, map[string]db.User{"blk-men-d001": f.owner})
	require.Empty(t, f.mentionMails(f.viewer))
	ledger, err := f.store.ListPostMentionNotifications(context.Background(), f.draft.ID)
	require.NoError(t, err)
	emailed := map[int64]bool{}
	for _, row := range ledger {
		emailed[row.UserID] = row.Emailed
	}
	require.Equal(t, map[int64]bool{f.viewer.ID: false, f.editor.ID: true}, emailed)
}

func TestMentionEmails_NotForSelfOrUnattributedOrTrash(t *testing.T) {
	f := newMentionFixture(t)

	// Mentioning yourself sends nothing; a mention in a block nobody changed in this
	// store (a duplicated post's content) is recorded without an email.
	f.storeDoc(t, f.published, []map[string]any{
		inlineBlock("blk-men-s001", mentionOf(f.editor, "Me")),
		inlineBlock("blk-men-s002", mentionOf(f.admin, "Admin")),
	}, map[string]db.User{"blk-men-s001": f.editor})
	require.Empty(t, f.mentionMails(f.editor))
	require.Empty(t, f.mentionMails(f.admin))
	// …and editing that block later doesn't mail them either: they were recorded.
	f.storeDoc(t, f.published, []map[string]any{
		inlineBlock("blk-men-s001", mentionOf(f.editor, "Me")),
		inlineBlock("blk-men-s002", mentionOf(f.admin, "Admin"), textNode(" hi")),
	}, map[string]db.User{"blk-men-s002": f.editor})
	require.Empty(t, f.mentionMails(f.admin))

	// A state-only store (the server's derived doc failed validation) records nothing.
	body, err := json.Marshal(map[string]any{
		"state": base64.StdEncoding.EncodeToString([]byte{1}), "epoch": "6f1c5f4e-9a59-4d55-9a4d-2b8f0d9e1a01",
		"base_revision": reloadPost(t, f.store, f.published.ID).BlockRevision,
	})
	require.NoError(t, err)
	rec := internalCollabRequest(t, f.server, http.MethodPut, fmt.Sprintf("/internal/posts/%d/collab", f.published.ID), body, "Bearer "+testRoleLookupSecret)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())

	// The last store of a post moved to the trash mails nobody.
	trashed := publishForTest(t, f.store, scheduleDraft(t, f.store, f.editor, scheduleWord()), f.editor)
	_, err = f.conn.Exec(`UPDATE posts SET trashed_from_status = post_status, post_status = 'trash', deleted_at = now() WHERE id = $1`, trashed.ID)
	require.NoError(t, err)
	f.storeDoc(t, trashed, []map[string]any{inlineBlock("blk-men-t001", mentionOf(f.viewer, "Viewer"))}, map[string]db.User{"blk-men-t001": f.editor})
	require.Empty(t, f.mentionMails(f.viewer))
}

// The public API never sends a mention's id, a member's email or a link's post id: a
// mention is the member's current name, a link the target's current URL (none for a
// draft), on every /public read that carries a published block doc.
func TestPublicInlineNodesWithoutIDsOrEmails(t *testing.T) {
	f := newMentionFixture(t)
	ctx := context.Background()
	target := publishForTest(t, f.store, scheduleDraft(t, f.store, f.editor, scheduleWord()), f.editor)
	draftTarget := scheduleDraft(t, f.store, f.editor, scheduleWord())
	post := scheduleDraft(t, f.store, f.editor, scheduleWord())
	publicBlock := inlineBlock("blk-pub-0001",
		textNode("Thanks "), mentionOf(f.viewer, "Old Label"),
		textNode(", see "), map[string]any{"type": "contentLink", "attrs": map[string]any{"postId": target.ID, "label": "The guide"}},
		textNode(" and "), map[string]any{"type": "contentLink", "attrs": map[string]any{"postId": draftTarget.ID, "label": "Coming soon"}},
		textNode(" by "), map[string]any{"type": "dateChip", "attrs": map[string]any{"date": "2026-12-01", "time": "10:00", "reminder": true}},
	)
	// The plain text the bridge builds from the stored labels (excerpts read it).
	publicBlock["attrs"].(map[string]any)["text"] = "Thanks @Old Label, see The guide and Coming soon by Dec 1, 2026"
	f.storeDoc(t, post, []map[string]any{publicBlock}, map[string]db.User{"blk-pub-0001": f.editor})
	_, err := f.conn.Exec(`UPDATE users SET full_name = 'Renamed Member' WHERE id = $1`, f.viewer.ID)
	require.NoError(t, err)
	post = publishForTest(t, f.store, post, f.editor)
	// The link follows the target's slug as it is now.
	_, err = f.conn.Exec(`UPDATE posts SET slug = slug || '-moved' WHERE id = $1`, target.ID)
	require.NoError(t, err)
	target = reloadPost(t, f.store, target.ID)
	settings, err := f.store.GetSettings(ctx)
	require.NoError(t, err)
	wantHref := postHref(target.PostType, target.Slug, target.ID, settings.PostUrlStructure, "")

	paths := []string{
		fmt.Sprintf("/public/posts/%d", post.ID),
		fmt.Sprintf("/public/posts/slug/%s", post.Slug),
		fmt.Sprintf("/public/posts/%d/blocks", post.ID),
		fmt.Sprintf("/public/authors/%s/posts", f.editor.Username),
		"/public/posts/type/post",
	}
	for _, path := range paths {
		rec := httpGet(t, f.server, path)
		require.Equal(t, http.StatusOK, rec.Code, path+": "+rec.Body.String())
		body := rec.Body.String()
		require.NotContains(t, body, `"userId"`, path)
		require.NotContains(t, body, `"postId"`, path)
		require.NotContains(t, body, `"reminder"`, path)
		require.NotContains(t, body, f.viewer.Email, path)
		require.NotContains(t, body, "Old Label", path)
		if strings.Contains(body, "blk-pub-0001") {
			require.Contains(t, body, `"label":"Renamed Member"`, path)
			require.Contains(t, body, fmt.Sprintf(`"href":%q`, wantHref), path)
			// The draft's link is its text alone.
			require.Contains(t, body, `{"label":"Coming soon"}`, path)
			require.Contains(t, body, "Thanks @Renamed Member, see", path)
			require.Contains(t, body, `"date":"2026-12-01"`, path)
		}
	}
	// The post page itself has them for sure.
	require.Contains(t, httpGet(t, f.server, fmt.Sprintf("/public/posts/%d", post.ID)).Body.String(), "Renamed Member")

	// The admin's working copy keeps the ids (the editor needs them).
	rec := as(t, f.server, f.editor, http.MethodGet, fmt.Sprintf("/api/v1/posts/%d/blocks", post.ID), nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), `"userId"`)
}

func httpGet(t *testing.T, server *Server, path string) *httptest.ResponseRecorder {
	t.Helper()
	request, err := http.NewRequest(http.MethodGet, path, nil)
	require.NoError(t, err)
	return flowServe(server, request)
}

func TestMentionMenuRoutes(t *testing.T) {
	f := newMentionFixture(t)
	marker := "Mentioned " + scheduleWord()
	_, err := f.conn.Exec(`UPDATE users SET full_name = $1 WHERE id = $2`, marker, f.viewer.ID)
	require.NoError(t, err)

	// People: content roles by name, public fields only (never an email), contributors too.
	rec := as(t, f.server, f.owner, http.MethodGet, "/api/v1/mentions/people?q="+strings.Split(marker, " ")[1], nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var people struct {
		People []MentionPersonResponse `json:"people"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &people))
	require.Len(t, people.People, 1)
	require.Equal(t, MentionPersonResponse{ID: f.viewer.ID, Username: f.viewer.Username, FullName: marker, Role: RoleContributor}, people.People[0])
	require.NotContains(t, rec.Body.String(), "@example.test")

	// By ids: the editor's current names (a missing member is left out).
	rec = as(t, f.server, f.owner, http.MethodGet, fmt.Sprintf("/api/v1/mentions/people?ids=%d,%d,999999999", f.viewer.ID, f.editor.ID), nil)
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &people))
	require.Len(t, people.People, 2)
	require.Equal(t, http.StatusBadRequest, as(t, f.server, f.owner, http.MethodGet, "/api/v1/mentions/people?ids=1,x", nil).Code)
	require.Equal(t, http.StatusBadRequest, as(t, f.server, f.owner, http.MethodGet, "/api/v1/mentions/people?q="+strings.Repeat("a", 101), nil).Code)

	// Content: what the caller may read (canReadPost), never the trash.
	word := scheduleWord()
	ownDraft := scheduleDraft(t, f.store, f.viewer, word)
	othersDraft := scheduleDraft(t, f.store, f.owner, word)
	live := publishForTest(t, f.store, scheduleDraft(t, f.store, f.owner, word), f.editor)
	gone := scheduleDraft(t, f.store, f.viewer, word)
	_, err = f.conn.Exec(`UPDATE posts SET trashed_from_status = post_status, post_status = 'trash', deleted_at = now() WHERE id = $1`, gone.ID)
	require.NoError(t, err)
	ids := func(caller db.User) map[int64]bool {
		rec := as(t, f.server, caller, http.MethodGet, "/api/v1/mentions/content?q="+word, nil)
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var rsp struct {
			Posts []MentionContentResponse `json:"posts"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &rsp))
		out := map[int64]bool{}
		for _, p := range rsp.Posts {
			require.Equal(t, "Post", p.PostTypeLabel)
			out[p.ID] = true
		}
		return out
	}
	require.Equal(t, map[int64]bool{ownDraft.ID: true, live.ID: true}, ids(f.viewer))
	require.Equal(t, map[int64]bool{ownDraft.ID: true, othersDraft.ID: true, live.ID: true}, ids(f.editor))

	// Signed out: nothing.
	request, err := http.NewRequest(http.MethodGet, "/api/v1/mentions/people", nil)
	require.NoError(t, err)
	require.Equal(t, http.StatusUnauthorized, flowServe(f.server, request).Code)
}

func reminderChip(date, clock string) map[string]any {
	return map[string]any{"type": "dateChip", "attrs": map[string]any{"date": date, "time": clock, "reminder": true}}
}

func TestReminders_KeptInStepAndSentOnce(t *testing.T) {
	f := newMentionFixture(t)
	ctx := context.Background()
	post := scheduleDraft(t, f.store, f.editor, scheduleWord())
	day := time.Now().AddDate(0, 1, 0).Format("2006-01-02")

	// The editor sets a reminder: one pending row, theirs.
	f.storeDoc(t, post, []map[string]any{inlineBlock("blk-rem-0001", textNode("Ship by "), reminderChip(day, "10:00"))}, map[string]db.User{"blk-rem-0001": f.editor})
	rows, err := f.store.ListPostReminders(ctx, post.ID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, f.editor.ID, rows[0].UserID)
	require.Equal(t, "pending", rows[0].Status)

	// Someone else edits the block's text: still the editor's, still one.
	f.storeDoc(t, post, []map[string]any{inlineBlock("blk-rem-0001", textNode("Ship it by "), reminderChip(day, "10:00"))}, map[string]db.User{"blk-rem-0001": f.admin})
	rows, err = f.store.ListPostReminders(ctx, post.ID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, f.editor.ID, rows[0].UserID)

	// Moved to 11:00: the old pending row goes, the new one is whoever moved it.
	f.storeDoc(t, post, []map[string]any{inlineBlock("blk-rem-0001", textNode("Ship it by "), reminderChip(day, "11:00"))}, map[string]db.User{"blk-rem-0001": f.editor})
	rows, err = f.store.ListPostReminders(ctx, post.ID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	require.Equal(t, "11:00", rows[0].ChipTime)

	// The site's zone changed (simulated: the stored instant is off by an hour): the next
	// store, by someone editing another block, moves it back to the chip's time and keeps it.
	_, err = f.conn.Exec(`UPDATE post_reminders SET remind_at = remind_at + interval '1 hour' WHERE id = $1`, rows[0].ID)
	require.NoError(t, err)
	f.storeDoc(t, post, []map[string]any{inlineBlock("blk-rem-0001", textNode("Ship it by "), reminderChip(day, "11:00")), inlineBlock("blk-rem-0009", textNode("x"))}, map[string]db.User{"blk-rem-0009": f.admin})
	retimed, err := f.store.ListPostReminders(ctx, post.ID)
	require.NoError(t, err)
	require.Len(t, retimed, 1)
	require.Equal(t, rows[0].ID, retimed[0].ID)
	require.True(t, rows[0].RemindAt.Equal(retimed[0].RemindAt), "%v vs %v", rows[0].RemindAt, retimed[0].RemindAt)
	require.Equal(t, f.editor.ID, retimed[0].UserID)

	// A reminder in the past, or one nobody typed in a store, isn't added.
	f.storeDoc(t, post, []map[string]any{
		inlineBlock("blk-rem-0001", textNode("Ship it by "), reminderChip(day, "11:00")),
		inlineBlock("blk-rem-0002", reminderChip("2020-01-01", "09:00")),
		inlineBlock("blk-rem-0003", reminderChip(day, "12:00")),
	}, map[string]db.User{"blk-rem-0002": f.editor})
	rows, err = f.store.ListPostReminders(ctx, post.ID)
	require.NoError(t, err)
	require.Len(t, rows, 1)

	// Due now (set in the past by hand: a store refuses a past time): the scheduler sends
	// it once, to its owner. Then its time is put back, as if the clock had moved on.
	_, err = f.conn.Exec(`UPDATE post_reminders SET remind_at = now() - interval '1 minute' WHERE id = $1`, rows[0].ID)
	require.NoError(t, err)
	for i := 0; i < 20 && reminderStatus(t, f.conn, rows[0].ID) == "pending"; i++ {
		f.server.sendDueReminders(ctx)
	}
	require.Equal(t, "sent", reminderStatus(t, f.conn, rows[0].ID))
	_, err = f.conn.Exec(`UPDATE post_reminders SET remind_at = $2 WHERE id = $1`, rows[0].ID, rows[0].RemindAt)
	require.NoError(t, err)
	reminders := []mailer.Message{}
	for _, m := range mailsTo(f.mail.messages(), f.editor.Email) {
		if m.Template == mailer.TemplateReminder {
			reminders = append(reminders, m)
		}
	}
	require.Len(t, reminders, 1)
	require.Equal(t, "Reminder: "+post.Title, reminders[0].Subject)
	require.Contains(t, reminders[0].Text, day+" at 11:00")
	f.server.sendDueReminders(ctx)
	require.Equal(t, "sent", reminderStatus(t, f.conn, rows[0].ID))

	// A store after it was sent keeps the sent row (never fires twice) and adds nothing.
	f.storeDoc(t, post, []map[string]any{inlineBlock("blk-rem-0001", textNode("Ship it by "), reminderChip(day, "11:00"))}, map[string]db.User{"blk-rem-0001": f.editor})
	rows, err = f.store.ListPostReminders(ctx, post.ID)
	require.NoError(t, err)
	require.Len(t, rows, 1)

	// Removing the chip removes a pending reminder.
	f.storeDoc(t, post, []map[string]any{inlineBlock("blk-rem-0004", reminderChip(day, "15:00"))}, map[string]db.User{"blk-rem-0004": f.editor})
	f.storeDoc(t, post, []map[string]any{inlineBlock("blk-rem-0004", textNode("no date"))}, map[string]db.User{"blk-rem-0004": f.editor})
	rows, err = f.store.ListPostReminders(ctx, post.ID)
	require.NoError(t, err)
	require.Len(t, rows, 1) // the sent one
	require.Equal(t, "sent", rows[0].Status)
}

func TestReminders_SkippedWithoutAccess(t *testing.T) {
	f := newMentionFixture(t)
	ctx := context.Background()
	day := time.Now().AddDate(0, 1, 0).Format("2006-01-02")
	// An editor's reminder on the owner's draft, then the editor becomes a contributor:
	// they can't read the draft any more, so the reminder (which names the post) is skipped.
	f.storeDoc(t, f.draft, []map[string]any{inlineBlock("blk-rem-s001", reminderChip(day, "10:00"))}, map[string]db.User{"blk-rem-s001": f.editor})
	rows, err := f.store.ListPostReminders(ctx, f.draft.ID)
	require.NoError(t, err)
	require.Len(t, rows, 1)
	_, err = f.conn.Exec(`UPDATE users SET role = 'contributor' WHERE id = $1`, f.editor.ID)
	require.NoError(t, err)
	_, err = f.conn.Exec(`UPDATE post_reminders SET remind_at = now() - interval '1 minute' WHERE id = $1`, rows[0].ID)
	require.NoError(t, err)
	for i := 0; i < 20 && reminderStatus(t, f.conn, rows[0].ID) == "pending"; i++ {
		f.server.sendDueReminders(ctx)
	}
	require.Equal(t, "skipped", reminderStatus(t, f.conn, rows[0].ID))
	for _, m := range mailsTo(f.mail.messages(), f.editor.Email) {
		require.NotEqual(t, mailer.TemplateReminder, m.Template)
	}
}

func reminderStatus(t *testing.T, conn *sql.DB, id int64) string {
	t.Helper()
	var status string
	require.NoError(t, conn.QueryRow(`SELECT status FROM post_reminders WHERE id = $1`, id).Scan(&status))
	return status
}
