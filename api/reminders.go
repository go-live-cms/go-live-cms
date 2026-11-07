package api

// Date reminders (#320): a date chip with "Remind me" emails whoever set it at the chip's
// day and time (the site's zone).
//
//   - Recorded: StorePostCollabTx keeps post_reminders in step with the working copy on
//     every store that writes block_doc (mention_notifications.go's collabInlineNodes): a
//     chip removed, or moved to another time, takes its pending row with it; a new chip
//     is owned by whoever typed it in that store (#328's attribution, never a value in
//     the document), and only if its time is still ahead. A chip nobody typed in a
//     store (a duplicated post's) has no owner and never fires.
//   - Sent: by the scheduled publishing loop (scheduled_publish.go's
//     RunScheduledPublishing, every SCHEDULED_PUBLISH_INTERVAL), after its publishes and
//     updates: ClaimDueReminders takes one due row FOR UPDATE SKIP LOCKED with a lease
//     (the fencing token, as #147's claims), so replicas share the work and a reminder
//     goes out once. A reminder whose owner can no longer read the post (or whose post
//     is in the trash) is skipped, not sent: the email names the post. A failed send is
//     retried with #147's backoff up to reminderMaxAttempts, then marked failed.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/go-live-cms/go-live-cms/mailer"
)

const (
	reminderMaxPerRound = 100
	reminderMaxAttempts = 5

	reminderSent    = "sent"
	reminderSkipped = "skipped"
	reminderFailed  = "failed"
)

// sendDueReminders is one round: claim and send due reminders one at a time until none is
// due, ctx is done or the round's cap is reached. Returns how many it sent.
func (server *Server) sendDueReminders(ctx context.Context) int {
	sent := 0
	var zone *time.Location
	for i := 0; i < reminderMaxPerRound && ctx.Err() == nil; i++ {
		claims, err := server.store.ClaimDueReminders(ctx, db.ClaimDueRemindersParams{
			LeaseSeconds: scheduledPublishLease.Seconds(),
			MaxRows:      1,
		})
		if err != nil {
			if ctx.Err() == nil {
				server.logger.Error("reminders: claiming due reminders failed", "error", err)
			}
			return sent
		}
		if len(claims) == 0 {
			return sent
		}
		if zone == nil {
			zone = server.siteZone(ctx)
		}
		if server.sendReminder(ctx, claims[0], zone) {
			sent++
		}
	}
	return sent
}

// sendReminder sends one claimed reminder and ends its claim. True when it was sent.
func (server *Server) sendReminder(ctx context.Context, claim db.ClaimDueRemindersRow, zone *time.Location) bool {
	logger := server.logger.With("reminder_id", claim.ID, "post_id", claim.PostID, "user_id", claim.UserID)
	finish := func(status string) {
		if !claim.Claim.Valid {
			return
		}
		if _, err := server.store.FinishReminder(ctx, db.FinishReminderParams{Status: status, ID: claim.ID, Claim: claim.Claim.Time}); err != nil {
			logger.Error("reminders: recording the outcome failed", "status", status, "error", err)
		}
	}

	member, err := server.store.GetUser(ctx, claim.UserID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			finish(reminderSkipped)
		} else {
			logger.Error("reminders: reading the member failed", "error", err)
			server.retryReminder(ctx, claim, logger)
		}
		return false
	}
	post, err := server.store.GetPost(ctx, claim.PostID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			finish(reminderSkipped)
		} else {
			logger.Error("reminders: reading the post failed", "error", err)
			server.retryReminder(ctx, claim, logger)
		}
		return false
	}
	if isTrashed(post) || !canReadPost(member, post) || member.Email == "" {
		finish(reminderSkipped)
		logger.Info("reminder skipped: no access")
		return false
	}

	msg, err := mailer.RenderReminder(member.Email, mailer.Reminder{
		SiteTitle: server.siteTitle(ctx),
		PostTitle: post.Title,
		When:      reminderWhen(claim, zone),
		Link:      server.publicURL + fmt.Sprintf(adminEditPath, post.ID),
	})
	if err == nil {
		err = server.sendMail(context.Background(), msg)
	}
	if err != nil {
		logger.Error("reminder email failed", "attempts", claim.Attempts, "error", err)
		if claim.Attempts >= reminderMaxAttempts {
			finish(reminderFailed)
		} else {
			server.retryReminder(ctx, claim, logger)
		}
		return false
	}
	finish(reminderSent)
	logger.Info("reminder email sent")
	return true
}

// retryReminder gives a claimed reminder back for the next attempt, after #147's backoff.
func (server *Server) retryReminder(ctx context.Context, claim db.ClaimDueRemindersRow, logger *slog.Logger) {
	if !claim.Claim.Valid {
		return
	}
	retryAt := time.Now().Add(scheduledPublishRetryAfter(claim.Attempts))
	if _, err := server.store.ReleaseReminder(ctx, db.ReleaseReminderParams{RetryAt: retryAt, ID: claim.ID, Claim: claim.Claim.Time}); err != nil {
		logger.Error("reminders: scheduling the retry failed", "error", err)
	}
}

// reminderWhen is the chip's day and time as the email says it: "2026-11-12 at 09:00
// (Europe/Lisbon)".
func reminderWhen(claim db.ClaimDueRemindersRow, zone *time.Location) string {
	name := "UTC"
	if zone != nil {
		name = zone.String()
	}
	return fmt.Sprintf("%s at %s (%s)", claim.ChipDate.Format("2006-01-02"), claim.ChipTime, name)
}
