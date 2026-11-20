package api

import (
	"context"
	"database/sql"
	"log/slog"
	"testing"
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/stretchr/testify/require"
)

// The approval rules and the spam routing (#524, design 4.2, 5), and the word and link
// rules against the vectors the web's twin runs (web/src/lib/discussion.test.ts).

const discussionRulesVectorsPath = "../web/src/lib/discussionRulesVectors.json"

type discussionRulesVectors struct {
	Words []struct {
		Name  string   `json:"name"`
		Words []string `json:"words"`
		Text  string   `json:"text"`
		Match *string  `json:"match"`
	} `json:"words"`
	Links []struct {
		Name  string   `json:"name"`
		Text  string   `json:"text"`
		Links []string `json:"links"`
	} `json:"links"`
	MemberNames []struct {
		Name    string                  `json:"name"`
		Guest   string                  `json:"guest"`
		Members []db.ListMemberNamesRow `json:"members"`
		Match   bool                    `json:"match"`
	} `json:"member_names"`
}

func TestDiscussionRulesVectors(t *testing.T) {
	var vectors discussionRulesVectors
	readJSONVectors(t, discussionRulesVectorsPath, &vectors)
	require.NotEmpty(t, vectors.Words)
	require.NotEmpty(t, vectors.Links)
	require.NotEmpty(t, vectors.MemberNames)

	for _, c := range vectors.Words {
		t.Run("words/"+c.Name, func(t *testing.T) {
			want := ""
			if c.Match != nil {
				want = *c.Match
			}
			require.Equal(t, want, matchDiscussionWord(c.Text, c.Words))
		})
	}
	for _, c := range vectors.Links {
		t.Run("links/"+c.Name, func(t *testing.T) {
			got := readerCommentLinks(c.Text)
			if len(c.Links) == 0 {
				require.Empty(t, got)
				return
			}
			require.Equal(t, c.Links, got)
		})
	}
	for _, c := range vectors.MemberNames {
		t.Run("member_names/"+c.Name, func(t *testing.T) {
			require.Equal(t, c.Match, matchesMemberName(c.Guest, c.Members))
		})
	}
}

// ruleInput is a comment every rule lets through, from a commenter approved before, on a
// site that publishes what no rule holds.
func ruleInput() readerCommentRuleInput {
	return readerCommentRuleInput{
		Name: "Maya", Body: "A thoughtful reply.",
		Settings:    db.Setting{CommentsModeration: discussionModerationNone, CommentsMaxLinks: 1},
		Commenter:   db.Commenter{ID: 7},
		HasApproved: true,
		Now:         time.Date(2026, 11, 19, 12, 0, 0, 0, time.UTC),
	}
}

func TestDecideReaderComment(t *testing.T) {
	now := ruleInput().Now
	cases := []struct {
		name   string
		change func(*readerCommentRuleInput)
		want   readerCommentVerdict
	}{
		{"nothing holds it: approved", func(*readerCommentRuleInput) {}, readerCommentVerdict{Status: db.ReaderCommentApproved}},

		// Holds (4.2), one case each.
		{"first_comment: mode first, nothing approved yet", func(in *readerCommentRuleInput) {
			in.Settings.CommentsModeration = discussionModerationFirst
			in.HasApproved = false
		}, readerCommentVerdict{Status: db.ReaderCommentPending, Reason: heldFirstComment}},
		{"mode first lets an approved commenter through", func(in *readerCommentRuleInput) {
			in.Settings.CommentsModeration = discussionModerationFirst
		}, readerCommentVerdict{Status: db.ReaderCommentApproved}},
		{"moderation_all: mode all", func(in *readerCommentRuleInput) {
			in.Settings.CommentsModeration = discussionModerationAll
		}, readerCommentVerdict{Status: db.ReaderCommentPending, Reason: heldModerationAll}},
		{"an unknown mode holds", func(in *readerCommentRuleInput) {
			in.Settings.CommentsModeration = "later"
		}, readerCommentVerdict{Status: db.ReaderCommentPending, Reason: heldModerationAll}},
		{"links: more than comments_max_links", func(in *readerCommentRuleInput) {
			in.Body = "See https://a.example and https://b.example"
		}, readerCommentVerdict{Status: db.ReaderCommentPending, Reason: heldLinks}},
		{"links: as many as allowed is fine", func(in *readerCommentRuleInput) {
			in.Body = "See https://a.example"
		}, readerCommentVerdict{Status: db.ReaderCommentApproved}},
		{"links: 0 allowed holds one", func(in *readerCommentRuleInput) {
			in.Settings.CommentsMaxLinks = 0
			in.Body = "See https://a.example"
		}, readerCommentVerdict{Status: db.ReaderCommentPending, Reason: heldLinks}},
		{"held_word in the text", func(in *readerCommentRuleInput) {
			in.Settings.CommentsHoldWords = []string{"refund"}
			in.Body = "I want a REFUND."
		}, readerCommentVerdict{Status: db.ReaderCommentPending, Reason: heldWord, Detail: "refund"}},
		{"held_word in the name", func(in *readerCommentRuleInput) {
			in.Settings.CommentsHoldWords = []string{"admin"}
			in.Name = "The Admin"
		}, readerCommentVerdict{Status: db.ReaderCommentPending, Reason: heldWord, Detail: "admin"}},
		{"member_name", func(in *readerCommentRuleInput) {
			in.MemberName = true
		}, readerCommentVerdict{Status: db.ReaderCommentPending, Reason: heldMemberName}},
		{"previous_spam within 90 days", func(in *readerCommentRuleInput) {
			in.Commenter.LastSpamAt = sql.NullTime{Time: now.Add(-89 * 24 * time.Hour), Valid: true}
		}, readerCommentVerdict{Status: db.ReaderCommentPending, Reason: heldPreviousSpam}},
		{"previous_spam ends after 90 days", func(in *readerCommentRuleInput) {
			in.Commenter.LastSpamAt = sql.NullTime{Time: now.Add(-91 * 24 * time.Hour), Valid: true}
		}, readerCommentVerdict{Status: db.ReaderCommentApproved}},
		{"plugin: a guard's hold, with its reason", func(in *readerCommentRuleInput) {
			in.Guard = readerCommentGuardVerdict{Action: readerCommentGuardHold, Reason: "Looks automated"}
		}, readerCommentVerdict{Status: db.ReaderCommentPending, Reason: heldPlugin, Detail: "Looks automated"}},

		// Spam routes (5, 16.1), one case each.
		{"spam_word in the text", func(in *readerCommentRuleInput) {
			in.Settings.CommentsSpamWords = []string{"casino"}
			in.Body = "Best Casino bonuses"
		}, readerCommentVerdict{Status: db.ReaderCommentSpam, Reason: spamWord, Detail: "casino"}},
		{"spam_word in the name", func(in *readerCommentRuleInput) {
			in.Settings.CommentsSpamWords = []string{"casino"}
			in.Name = "Casino Bob"
		}, readerCommentVerdict{Status: db.ReaderCommentSpam, Reason: spamWord, Detail: "casino"}},
		{"honeypot", func(in *readerCommentRuleInput) {
			in.Honeypot = true
		}, readerCommentVerdict{Status: db.ReaderCommentSpam, Reason: spamHoneypot}},
		{"plugin: a guard's spam", func(in *readerCommentRuleInput) {
			in.Guard = readerCommentGuardVerdict{Action: readerCommentGuardSpam, Reason: "Known spammer"}
		}, readerCommentVerdict{Status: db.ReaderCommentSpam, Reason: spamPlugin, Detail: "Known spammer"}},
		{"blocked commenter (5.5)", func(in *readerCommentRuleInput) {
			in.Commenter.BlockedAt = sql.NullTime{Time: now, Valid: true}
		}, readerCommentVerdict{Status: db.ReaderCommentSpam, Reason: spamBlocked}},

		// Precedence.
		{"a spam word beats a hold word", func(in *readerCommentRuleInput) {
			in.Settings.CommentsHoldWords = []string{"bonus"}
			in.Settings.CommentsSpamWords = []string{"casino"}
			in.Body = "casino bonus"
		}, readerCommentVerdict{Status: db.ReaderCommentSpam, Reason: spamWord, Detail: "casino"}},
		{"a guard's spam beats its hold and every hold", func(in *readerCommentRuleInput) {
			in.Guard = readerCommentGuardVerdict{Action: readerCommentGuardSpam}
			in.MemberName = true
		}, readerCommentVerdict{Status: db.ReaderCommentSpam, Reason: spamPlugin}},
		{"a specific hold beats the mode", func(in *readerCommentRuleInput) {
			in.Settings.CommentsModeration = discussionModerationAll
			in.MemberName = true
		}, readerCommentVerdict{Status: db.ReaderCommentPending, Reason: heldMemberName}},
		{"a guard can't approve what the mode holds", func(in *readerCommentRuleInput) {
			in.Settings.CommentsModeration = discussionModerationAll
			in.Guard = readerCommentGuardVerdict{Action: "approve"}
		}, readerCommentVerdict{Status: db.ReaderCommentPending, Reason: heldModerationAll}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			in := ruleInput()
			tc.change(&in)
			require.Equal(t, tc.want, decideReaderComment(in))
		})
	}
}

func TestReaderCommentSpamOnlyNeverHolds(t *testing.T) {
	in := ruleInput()
	in.Settings = readerCommentSpamOnly(db.Setting{
		CommentsModeration: discussionModerationAll, CommentsMaxLinks: 0,
		CommentsHoldWords: []string{"refund"}, CommentsSpamWords: []string{"casino"},
	})
	in.HasApproved = false
	in.Body = "refund https://a.example https://b.example"
	require.Equal(t, db.ReaderCommentApproved, decideReaderComment(in).Status, "holds wait for the confirmation")
	in.Body = "casino"
	require.Equal(t, readerCommentVerdict{Status: db.ReaderCommentSpam, Reason: spamWord, Detail: "casino"}, decideReaderComment(in))
}

func TestReaderCommentHeldColumns(t *testing.T) {
	reason, detail := readerCommentVerdict{Status: db.ReaderCommentApproved}.heldColumns()
	require.False(t, reason.Valid)
	require.False(t, detail.Valid)

	long := ""
	for range 300 {
		long += "é"
	}
	reason, detail = readerCommentVerdict{Reason: heldPlugin, Detail: "two\nlines " + long}.heldColumns()
	require.Equal(t, sql.NullString{String: heldPlugin, Valid: true}, reason)
	require.True(t, detail.Valid)
	require.NotContains(t, detail.String, "\n")
	require.Len(t, []rune(detail.String), heldDetailMax)
}

func TestParseCommenterKeys(t *testing.T) {
	a, aHash, err := newAccountToken()
	require.NoError(t, err)
	b, bHash, err := newAccountToken()
	require.NoError(t, err)
	require.Equal(t, [][]byte{aHash, bHash}, parseCommenterKeys(" "+a+", nonsense,,"+b))
	require.Empty(t, parseCommenterKeys(""))
	require.Empty(t, parseCommenterKeys("short, "+a[:42]+"!"))

	many := ""
	for range commenterKeysMax + 2 {
		k, _, err := newAccountToken()
		require.NoError(t, err)
		many += k + ","
	}
	require.Len(t, parseCommenterKeys(many), commenterKeysMax)
}

func TestGuardReaderCommentHook(t *testing.T) {
	server := &Server{}
	require.Equal(t, readerCommentGuardVerdict{}, server.guardReaderComment(t.Context(), nil, readerCommentCandidate{}), "no comment guard in this build")

	var seen readerCommentCandidate
	server.readerCommentGuard = func(_ context.Context, _ *slog.Logger, c readerCommentCandidate) readerCommentGuardVerdict {
		seen = c
		return readerCommentGuardVerdict{Action: readerCommentGuardHold, Reason: "line one\nline two"}
	}
	verdict := server.guardReaderComment(t.Context(), nil, readerCommentCandidate{PostID: 3, Email: "a@example.com"})
	require.Equal(t, readerCommentGuardVerdict{Action: readerCommentGuardHold, Reason: "line one line two"}, verdict)
	require.Equal(t, int64(3), seen.PostID)

	server.readerCommentGuard = func(context.Context, *slog.Logger, readerCommentCandidate) readerCommentGuardVerdict {
		return readerCommentGuardVerdict{Action: "approve", Reason: "trust me"}
	}
	require.Equal(t, readerCommentGuardVerdict{}, server.guardReaderComment(t.Context(), nil, readerCommentCandidate{}), "a guard can't approve")
}
