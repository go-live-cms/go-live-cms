package api

// Mention notifications (#320).
//
// When: only after the collab server's store writes block_doc (PUT
// /internal/posts/:id/collab), never per keystroke: the store is debounced (2-10s) and
// sends a block_doc only when the derived doc changed.
//
// Once: StorePostCollabTx records every member the stored doc mentions in
// post_mention_notifications, one row per (post, member), in the store's own transaction,
// and returns the ones it had never seen. Only those can send an email, so editing,
// splitting, moving, pasting or re-storing never mails anyone twice about a post, and two
// replicas can't both mail (the insert is the claim). Decision: the key is the post, not
// the block: a split or a paste gives the mention a new block id, and mailing again then
// would be a notification per edit.
//
// Who typed it: the collab server's per-block attribution (#328, block_edits, taken
// from the connection that sent the change, never from the document). A mention in a
// block this store didn't change (a duplicated post, a template, a restore's untouched
// blocks) is recorded without an email: nobody just wrote it. Nor is anyone mailed for
// mentioning themselves.
//
// Access (decision): a member who can't read the post (canReadPost: a contributor
// mentioned in someone else's draft, a member without a content role) gets **no
// notification**, not "you were mentioned in a post you can't see": that message would
// still tell them the post exists, who wrote it and when. The mention is recorded as not
// emailed, so publishing the post later doesn't send a late email either; the mention
// itself is visible to them once they can read the post. Nothing is sent for a post in
// the trash.
//
// Abuse: at most mentionEmailsPerStore emails per store; the rest are recorded and
// skipped (logged with the count). Emails carry the post's title and the admin link,
// never the post's content.

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
)

// mentionEmailsPerStore caps the emails one collab store can send.
const mentionEmailsPerStore = 25

// collabInlineNodes reads what a collab store's doc holds of #320's inline nodes: each
// mentioned member once (in a block this store changed when there is one, with who typed
// it there; else the first block, with nobody),
// and each reminder chip (a block and an instant) once, owned the same way. loc is the
// site's zone (reminders are site wall-clock times); nil when the doc has no reminder.
func collabInlineNodes(doc *BlockDocV1, edits []db.PostBlockEditInput, loc *time.Location) ([]db.MentionInput, []db.ReminderInput) {
	editor := make(map[string]int64, len(edits))
	for _, edit := range edits {
		editor[edit.BlockID] = edit.UserID
	}
	ids := make([]string, 0, len(doc.Blocks))
	for id := range doc.Blocks {
		ids = append(ids, id)
	}
	sort.Strings(ids) // a stable order for the inserts

	// nil when there are none, so a store without them passes the params it always did.
	var mentions []db.MentionInput
	var reminders []db.ReminderInput
	mentionAt := map[int64]int{} // member → index in mentions
	seenReminder := map[string]bool{}
	for _, id := range ids {
		pm := blockPM(doc.Blocks[id])
		if pm == nil {
			continue
		}
		walkInlineNodes(pm, func(node map[string]interface{}) {
			attrs, _ := node["attrs"].(map[string]interface{})
			switch stringOf(node["type"]) {
			case mentionNodeType:
				userID, ok := normalizeEntityID(attrs["userId"])
				if !ok {
					return
				}
				entry := db.MentionInput{BlockID: id, UserID: userID, MentionedBy: editor[id]}
				if at, seen := mentionAt[userID]; seen {
					// An attributed block wins over one nobody changed in this store.
					if mentions[at].MentionedBy == 0 && entry.MentionedBy != 0 {
						mentions[at] = entry
					}
					return
				}
				mentionAt[userID] = len(mentions)
				mentions = append(mentions, entry)
			case dateChipNodeType:
				chip := sanitizeInlineNodeAttrs(dateChipNodeType, attrs)
				if chip == nil || chip["reminder"] != true || loc == nil {
					return
				}
				date, _ := chip["date"].(string)
				clock, _ := chip["time"].(string)
				at, ok := reminderInstant(date, clock, loc)
				if !ok {
					return
				}
				key := db.ReminderKey(id, date, clock)
				if seenReminder[key] {
					return
				}
				seenReminder[key] = true
				reminders = append(reminders, db.ReminderInput{BlockID: id, RemindAt: at, ChipDate: date, ChipTime: clock, UserID: editor[id]})
			}
		})
	}
	return mentions, reminders
}

// docHasReminders reports whether any block of doc has a reminder chip (so the store
// needs the site's zone).
func docHasReminders(doc *BlockDocV1) bool {
	found := false
	for _, block := range doc.Blocks {
		if pm := blockPM(block); pm != nil && !found {
			walkInlineNodes(pm, func(node map[string]interface{}) {
				if stringOf(node["type"]) == dateChipNodeType {
					attrs, _ := node["attrs"].(map[string]interface{})
					if normalizeReminder(attrs["reminder"]) {
						found = true
					}
				}
			})
		}
	}
	return found
}

// reminderInstant is a chip's day and time in loc as an instant. A time the clocks skip
// (spring forward) fires when the gap ends (02:30 on a 02:00-03:00 gap: at 03:00).
func reminderInstant(date, clock string, loc *time.Location) (time.Time, bool) {
	local := date + "T" + clock
	if t, err := siteLocalToUTC(local, loc); err == nil {
		return t, true
	}
	t, err := time.ParseInLocation(siteLocalLayout, local, loc)
	if err != nil {
		return time.Time{}, false
	}
	// Go may land on either side of the gap; take the first half hour past the wall time.
	for step := time.Duration(0); step <= 2*time.Hour; step += 30 * time.Minute {
		if c := t.Add(step); c.In(loc).Format(siteLocalLayout) > local {
			return c.UTC(), true
		}
	}
	return t.UTC(), true
}

// siteZone is the site's time zone for stores and the scheduler (siteTimeZone), UTC when
// it can't be read: a reminder an hour off beats a store that fails.
func (server *Server) siteZone(ctx context.Context) *time.Location {
	loc, err := server.siteTimeZone(ctx)
	if err != nil {
		return time.UTC
	}
	return loc
}

// notifyNewMentions emails the members a store mentioned for the first time, after the
// response (runInBackground). See the package comment above for who gets one.
func (server *Server) notifyNewMentions(logger *slog.Logger, postID int64, mentions []db.RecordPostMentionsRow) {
	ctx, cancel := context.WithTimeout(context.Background(), mailSendTimeout)
	defer cancel()

	// One row per member (the ledger's key); those nobody typed, or typed themselves, are due nothing.
	byUser := map[int64]db.RecordPostMentionsRow{}
	order := []int64{}
	for _, m := range mentions {
		if !m.MentionedBy.Valid || m.MentionedBy.Int64 == m.UserID {
			continue
		}
		order = append(order, m.UserID)
		byUser[m.UserID] = m
	}
	if len(order) == 0 {
		return
	}
	post, err := server.store.GetPost(ctx, postID)
	if err != nil {
		logger.Error("mention emails: reading the post failed", "post_id", postID, "error", err)
		return
	}
	if isTrashed(post) {
		return
	}

	siteTitle := server.siteTitle(ctx)
	link := server.publicURL + fmt.Sprintf(adminEditPath, post.ID)
	names := map[int64]string{}
	sentUsers := []int64{}
	skipped, capped := 0, 0
	for _, userID := range order {
		if len(sentUsers) >= mentionEmailsPerStore {
			capped++
			continue
		}
		member, err := server.store.GetUser(ctx, userID)
		if err != nil || member.Email == "" || !canReadPost(member, post) {
			// No access (or gone): no notification at all, by design.
			skipped++
			continue
		}
		row := byUser[userID]
		mentioner, known := names[row.MentionedBy.Int64]
		if !known {
			if by, err := server.store.GetUser(ctx, row.MentionedBy.Int64); err == nil {
				mentioner = strings.TrimSpace(by.FullName)
				if mentioner == "" {
					mentioner = by.Username
				}
			}
			names[row.MentionedBy.Int64] = mentioner
		}
		msg, err := mailer.RenderMention(member.Email, mailer.Mention{SiteTitle: siteTitle, MentionerName: mentioner, PostTitle: post.Title, Link: link})
		if err == nil {
			err = server.sendMail(context.Background(), msg)
		}
		if err != nil {
			logger.Error("mention email failed", "post_id", postID, "user_id", userID, "error", err)
			continue
		}
		sentUsers = append(sentUsers, userID)
	}
	if len(sentUsers) > 0 {
		if err := server.store.MarkMentionsEmailed(ctx, db.MarkMentionsEmailedParams{PostID: postID, UserIds: sentUsers}); err != nil {
			logger.Warn("mention emails: marking them sent failed", "post_id", postID, "error", err)
		}
	}
	logger.Info("mention emails sent", "post_id", postID, "count", len(sentUsers), "skipped", skipped, "capped", capped)
}
