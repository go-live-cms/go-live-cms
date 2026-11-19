package api

import (
	"database/sql"
	"regexp"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"golang.org/x/text/runes"
	"golang.org/x/text/transform"
	"golang.org/x/text/unicode/norm"
)

// The approval rules and the spam routing of reader comments (#524, design 4.2, 5).
// The word lists' matching and the link rule are pinned by
// web/src/lib/discussionRulesVectors.json, which both suites run (the TypeScript twins in
// web/src/lib/discussion.ts are for the admin's preview and the renderer's links).

// Why the rules held a comment (held_reason with status pending, 4.2).
const (
	heldFirstComment  = "first_comment"
	heldModerationAll = "moderation_all"
	heldLinks         = "links"
	heldWord          = "held_word"
	heldMemberName    = "member_name"
	heldPreviousSpam  = "previous_spam"
	heldPlugin        = "plugin"
)

// Why a comment went to spam (held_reason with status spam, 16.1). "blocked" is 5.5's:
// a blocked commenter's later comments go to spam silently.
const (
	spamWord     = "spam_word"
	spamHoneypot = "honeypot"
	spamPlugin   = "plugin"
	spamBlocked  = "blocked"
)

// The moderation modes (settings.comments_moderation).
const (
	discussionModerationAll   = "all"
	discussionModerationFirst = "first"
	discussionModerationNone  = "none"
)

// previousSpamWindow: a commenter with a comment marked spam this recently is held,
// whatever the mode (4.2; commenters.last_spam_at outlives the spam rows).
const previousSpamWindow = 90 * 24 * time.Hour

// foldDiscussionText is how the rules compare text: accents dropped (NFD, then the
// combining marks removed), then lower-cased. "Ação" and "acao" fold the same.
func foldDiscussionText(s string) string {
	t := transform.Chain(norm.NFD, runes.Remove(runes.In(unicode.Mn)))
	folded, _, err := transform.String(t, s)
	if err != nil {
		folded = s
	}
	return strings.ToLower(folded)
}

func isDiscussionWordRune(r rune) bool {
	return unicode.IsLetter(r) || unicode.IsNumber(r)
}

// matchDiscussionWord returns the first entry of words found in text, or "". An entry
// matches case-insensitively, accents dropped, on word boundaries: the characters around
// it aren't letters or digits where the entry itself begins or ends with one ("ass" is
// not in "class"; "$$$" is in "win$$$"). An entry may hold several words ("buy now").
func matchDiscussionWord(text string, words []string) string {
	folded := foldDiscussionText(text)
	for _, word := range words {
		entry := foldDiscussionText(strings.TrimSpace(word))
		if entry == "" {
			continue
		}
		if containsDiscussionWord(folded, entry) {
			return word
		}
	}
	return ""
}

func containsDiscussionWord(text, entry string) bool {
	first, _ := utf8.DecodeRuneInString(entry)
	last, _ := utf8.DecodeLastRuneInString(entry)
	for from := 0; from <= len(text); {
		i := strings.Index(text[from:], entry)
		if i < 0 {
			return false
		}
		start, end := from+i, from+i+len(entry)
		before, _ := utf8.DecodeLastRuneInString(text[:start])
		after, _ := utf8.DecodeRuneInString(text[end:])
		okBefore := start == 0 || !isDiscussionWordRune(first) || !isDiscussionWordRune(before)
		okAfter := end == len(text) || !isDiscussionWordRune(last) || !isDiscussionWordRune(after)
		if okBefore && okAfter {
			return true
		}
		_, size := utf8.DecodeRuneInString(text[start:])
		from = start + size
	}
	return false
}

// readerCommentLinkPattern: what the renderer links (5.4, 11.4), only http and https
// URLs, the scheme in any case. Trailing punctuation is trimmed by readerCommentLinks.
var readerCommentLinkPattern = regexp.MustCompile(`(?i)\bhttps?://[^\s<>"'` + "`" + `]+`)

// readerCommentLinks are the links in a comment's text, as the renderer links them: each
// http(s) URL up to the next space, without the sentence punctuation after it (a final
// . , ; : ! ? and a closing bracket it doesn't open). A URL that is only a scheme isn't
// one. The "links" rule counts them (comments_max_links).
func readerCommentLinks(text string) []string {
	var links []string
	for _, match := range readerCommentLinkPattern.FindAllString(text, -1) {
		link := trimLinkPunctuation(match)
		scheme := strings.Index(link, "://") + 3
		if len(link) <= scheme {
			continue
		}
		links = append(links, link)
	}
	return links
}

func trimLinkPunctuation(link string) string {
	for link != "" {
		last := link[len(link)-1]
		switch last {
		case '.', ',', ';', ':', '!', '?':
			link = link[:len(link)-1]
			continue
		case ')', ']', '}':
			open := map[byte]byte{')': '(', ']': '[', '}': '{'}[last]
			if strings.Count(link, string(open)) < strings.Count(link, string(last)) {
				link = link[:len(link)-1]
				continue
			}
		}
		return link
	}
	return link
}

// foldMemberName is a name as the member-name rule compares it: folded, its whitespace
// runs made one space.
func foldMemberName(name string) string {
	return strings.Join(strings.Fields(foldDiscussionText(name)), " ")
}

// matchesMemberName reports whether a guest's name is a member's full name or username
// (3.4), case-insensitively with accents dropped, so a reader can't pass as staff.
func matchesMemberName(name string, members []db.ListMemberNamesRow) bool {
	folded := foldMemberName(name)
	if folded == "" {
		return false
	}
	for _, m := range members {
		if folded == foldMemberName(m.FullName) || folded == foldMemberName(m.Username) {
			return true
		}
	}
	return false
}

// readerCommentRuleInput is everything 4.2's rules read about one comment.
type readerCommentRuleInput struct {
	Name, Body string
	// Honeypot: the hidden "website" field was filled (5.2).
	Honeypot bool
	Settings db.Setting
	// The commenter as stored (blocked, last spam), and whether they have an approved
	// comment already.
	Commenter   db.Commenter
	HasApproved bool
	// MemberName: the name is a member's (3.4).
	MemberName bool
	// Guard is a plugin guard's verdict (#530), stored with an unconfirmed comment.
	Guard readerCommentGuardVerdict
	Now   time.Time
}

// readerCommentVerdict is what the rules decided: approved, pending or spam, and why.
type readerCommentVerdict struct {
	Status string
	Reason string
	Detail string
}

// decideReaderComment applies 4.2 and 5: spam routes first (a blocked commenter, the
// honeypot, a spam word in the text or name, a guard's spam: a spam word beats a hold
// word), then the holds, most specific first (a guard, a member's name, a held word,
// too many links, previous spam, the mode), else approved. A guard can hold or spam a
// comment, never approve one.
func decideReaderComment(in readerCommentRuleInput) readerCommentVerdict {
	spam := func(reason, detail string) readerCommentVerdict {
		return readerCommentVerdict{Status: db.ReaderCommentSpam, Reason: reason, Detail: detail}
	}
	hold := func(reason, detail string) readerCommentVerdict {
		return readerCommentVerdict{Status: db.ReaderCommentPending, Reason: reason, Detail: detail}
	}
	words := in.Body + "\n" + in.Name
	switch {
	case in.Commenter.BlockedAt.Valid:
		return spam(spamBlocked, "")
	case in.Honeypot:
		return spam(spamHoneypot, "")
	}
	if word := matchDiscussionWord(words, in.Settings.CommentsSpamWords); word != "" {
		return spam(spamWord, word)
	}
	if in.Guard.Action == readerCommentGuardSpam {
		return spam(spamPlugin, in.Guard.Reason)
	}
	if in.Guard.Action == readerCommentGuardHold {
		return hold(heldPlugin, in.Guard.Reason)
	}
	if in.MemberName {
		return hold(heldMemberName, "")
	}
	if word := matchDiscussionWord(words, in.Settings.CommentsHoldWords); word != "" {
		return hold(heldWord, word)
	}
	if links := len(readerCommentLinks(in.Body)); links > int(in.Settings.CommentsMaxLinks) {
		return hold(heldLinks, "")
	}
	if in.Commenter.LastSpamAt.Valid && in.Now.Sub(in.Commenter.LastSpamAt.Time) < previousSpamWindow {
		return hold(heldPreviousSpam, "")
	}
	switch in.Settings.CommentsModeration {
	case discussionModerationNone:
	case discussionModerationFirst:
		if !in.HasApproved {
			return hold(heldFirstComment, "")
		}
	default:
		// "all", and anything unknown (the column's CHECK refuses one): hold.
		return hold(heldModerationAll, "")
	}
	return readerCommentVerdict{Status: db.ReaderCommentApproved}
}

// heldDetailMax is held_detail's column width (varchar(200)).
const heldDetailMax = 200

func (v readerCommentVerdict) heldColumns() (reason, detail sql.NullString) {
	if v.Reason != "" {
		reason = sql.NullString{String: v.Reason, Valid: true}
	}
	if d := truncateRunes(oneLineText(v.Detail), heldDetailMax); d != "" {
		detail = sql.NullString{String: d, Valid: true}
	}
	return reason, detail
}

// oneLineText collapses whitespace runs (line breaks included) to one space.
func oneLineText(s string) string {
	return strings.Join(strings.Fields(s), " ")
}
