package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// Settings › Discussion (#522, design 12.1): fields of GET/PUT /settings, admins only to
// write like every setting. comments_enabled starts off; the admin keeps its switch
// hidden until the moderation screens ship (#526, #527).
//
// GET /settings is public (the site reads it on every page, through #185's cache). The
// display settings and the notice are public on purpose; the hold and spam word lists
// are not (a spammer would read them to get round them), so only an admin's request
// gets them. A request carrying Authorization is never served from or stored in the
// public cache, so the anonymous cached answer never holds them.

const (
	// discussionWordListMax and discussionWordMax bound comments_hold_words and
	// comments_spam_words (4.2): one entry per line in the admin.
	discussionWordListMax = 500
	discussionWordMax     = 64
	// discussionNoticeMax is comments_notice's limit (7.5), also a CHECK in 000061.
	discussionNoticeMax = 400
)

// discussionSettingsRequest is Settings › Discussion in PUT /settings. Absent keeps a
// value. The enums are checked by their binding tags; the ranges and lists here, since
// 0 is a value (omitempty would skip it).
type discussionSettingsRequest struct {
	CommentsEnabled        *bool     `json:"comments_enabled"`
	CommentsModeration     *string   `json:"comments_moderation" binding:"omitempty,oneof=all first none"`
	CommentsMaxLinks       *int32    `json:"comments_max_links"`
	CommentsHoldWords      *[]string `json:"comments_hold_words"`
	CommentsSpamWords      *[]string `json:"comments_spam_words"`
	CommentsCloseAfterDays *int32    `json:"comments_close_after_days"`
	CommentsThreading      *string   `json:"comments_threading" binding:"omitempty,oneof=replies flat"`
	CommentsOrder          *string   `json:"comments_order" binding:"omitempty,oneof=oldest newest"`
	CommentsPerPage        *int32    `json:"comments_per_page"`
	// Plain text, one line; "" restores core's text.
	CommentsNotice *string `json:"comments_notice"`
	// A published page's id, null for none, absent to keep it.
	CommentsPrivacyPageID json.RawMessage `json:"comments_privacy_page_id"`
}

// setFields adds the Discussion settings the request sets, for "settings_updated".
func (req discussionSettingsRequest) setFields(add func(bool, string)) {
	add(req.CommentsEnabled != nil, "comments_enabled")
	add(req.CommentsModeration != nil, "comments_moderation")
	add(req.CommentsMaxLinks != nil, "comments_max_links")
	add(req.CommentsHoldWords != nil, "comments_hold_words")
	add(req.CommentsSpamWords != nil, "comments_spam_words")
	add(req.CommentsCloseAfterDays != nil, "comments_close_after_days")
	add(req.CommentsThreading != nil, "comments_threading")
	add(req.CommentsOrder != nil, "comments_order")
	add(req.CommentsPerPage != nil, "comments_per_page")
	add(req.CommentsNotice != nil, "comments_notice")
	add(len(req.CommentsPrivacyPageID) > 0, "comments_privacy_page_id")
}

// discussionFieldError is a 400 on one field.
type discussionFieldError struct {
	field, message string
}

func (e discussionFieldError) Error() string { return e.field + ": " + e.message }

// apply checks the request and copies it into params. privacyPage is the page to check
// (nil when the request clears it or leaves it alone).
func (req discussionSettingsRequest) apply(params *db.UpdateSettingsParams) (privacyPage *int64, err error) {
	inRange := func(field string, v *int32, lo, hi int32) (sql.NullInt32, error) {
		if v == nil {
			return sql.NullInt32{}, nil
		}
		if *v < lo || *v > hi {
			return sql.NullInt32{}, discussionFieldError{field, fmt.Sprintf("must be between %d and %d", lo, hi)}
		}
		return sql.NullInt32{Int32: *v, Valid: true}, nil
	}
	if params.CommentsMaxLinks, err = inRange("comments_max_links", req.CommentsMaxLinks, 0, 10); err != nil {
		return nil, err
	}
	if params.CommentsCloseAfterDays, err = inRange("comments_close_after_days", req.CommentsCloseAfterDays, 0, 3650); err != nil {
		return nil, err
	}
	if params.CommentsPerPage, err = inRange("comments_per_page", req.CommentsPerPage, 10, 100); err != nil {
		return nil, err
	}
	if req.CommentsHoldWords != nil {
		if params.CommentsHoldWords, err = normalizeDiscussionWords("comments_hold_words", *req.CommentsHoldWords); err != nil {
			return nil, err
		}
	}
	if req.CommentsSpamWords != nil {
		if params.CommentsSpamWords, err = normalizeDiscussionWords("comments_spam_words", *req.CommentsSpamWords); err != nil {
			return nil, err
		}
	}
	if req.CommentsNotice != nil {
		notice := strings.TrimSpace(*req.CommentsNotice)
		if !isSingleLine(notice) || strings.ContainsFunc(notice, isBidiControl) {
			return nil, discussionFieldError{"comments_notice", "must be one line of plain text"}
		}
		if utf8.RuneCountInString(notice) > discussionNoticeMax {
			return nil, discussionFieldError{"comments_notice", fmt.Sprintf("must be at most %d characters", discussionNoticeMax)}
		}
		params.CommentsNotice = sql.NullString{String: notice, Valid: true}
	}
	params.CommentsEnabled = boolToNullBool(req.CommentsEnabled)
	params.CommentsModeration = stringToNullString(req.CommentsModeration)
	params.CommentsThreading = stringToNullString(req.CommentsThreading)
	params.CommentsOrder = stringToNullString(req.CommentsOrder)

	raw := bytes.TrimSpace(req.CommentsPrivacyPageID)
	switch {
	case len(raw) == 0:
	case string(raw) == "null":
		params.SetCommentsPrivacyPage = true
	default:
		var id int64
		if err := json.Unmarshal(raw, &id); err != nil || id <= 0 {
			return nil, discussionFieldError{"comments_privacy_page_id", "must be a page id or null"}
		}
		params.SetCommentsPrivacyPage = true
		params.CommentsPrivacyPageID = sql.NullInt64{Int64: id, Valid: true}
		privacyPage = &id
	}
	return privacyPage, nil
}

// normalizeDiscussionWords cleans a word list (4.2): entries trimmed, blank ones
// dropped, duplicates (ignoring case) kept once in their first position; at most
// discussionWordListMax entries of at most discussionWordMax characters, one line each.
// Never nil, so [] clears the list.
func normalizeDiscussionWords(field string, words []string) ([]string, error) {
	out := make([]string, 0, len(words))
	seen := make(map[string]bool, len(words))
	for _, word := range words {
		word = strings.TrimSpace(word)
		if word == "" {
			continue
		}
		if strings.ContainsFunc(word, func(r rune) bool { return unicode.IsControl(r) || isBidiControl(r) }) {
			return nil, discussionFieldError{field, "entries must be one line of plain text"}
		}
		if utf8.RuneCountInString(word) > discussionWordMax {
			return nil, discussionFieldError{field, fmt.Sprintf("entries must be at most %d characters", discussionWordMax)}
		}
		key := strings.ToLower(word)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, word)
	}
	if len(out) > discussionWordListMax {
		return nil, discussionFieldError{field, fmt.Sprintf("must have at most %d entries", discussionWordListMax)}
	}
	return out, nil
}

// writeDiscussionSettingsError answers a refused Discussion setting.
func writeDiscussionSettingsError(c *gin.Context, err error) {
	var fieldErr discussionFieldError
	if errors.As(err, &fieldErr) {
		c.JSON(http.StatusBadRequest, gin.H{"error": fieldErr.field + " " + fieldErr.message, "code": "invalid_discussion_settings",
			"fields": gin.H{fieldErr.field: fieldErr.message}})
		return
	}
	c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update settings"})
}

// checkPrivacyPage answers 400 itself unless id is a published page of an active,
// public page type: the notice links it as "Privacy" (7.5).
func (server *Server) checkPrivacyPage(c *gin.Context, id int64) bool {
	return server.checkPublishedPageSetting(c, id, publishedPageSetting{
		field:      "comments_privacy_page_id",
		code:       "invalid_privacy_page",
		notPage:    "the privacy page must be a published page",
		notServed:  "pages are switched off or not public, so the site can't link one",
		lookupFail: "failed to get the privacy page",
	})
}

// discussionSettingsResponse is Settings › Discussion in GET/PUT /settings. The word
// lists are set only for an admin (nil is omitted).
type discussionSettingsResponse struct {
	CommentsEnabled        bool      `json:"comments_enabled"`
	CommentsModeration     string    `json:"comments_moderation"`
	CommentsMaxLinks       int32     `json:"comments_max_links"`
	CommentsHoldWords      *[]string `json:"comments_hold_words,omitempty"`
	CommentsSpamWords      *[]string `json:"comments_spam_words,omitempty"`
	CommentsCloseAfterDays int32     `json:"comments_close_after_days"`
	CommentsThreading      string    `json:"comments_threading"`
	CommentsOrder          string    `json:"comments_order"`
	CommentsPerPage        int32     `json:"comments_per_page"`
	CommentsNotice         string    `json:"comments_notice"`
	CommentsPrivacyPageID  *int64    `json:"comments_privacy_page_id"`
}

func toDiscussionSettingsResponse(settings db.Setting, admin bool) discussionSettingsResponse {
	response := discussionSettingsResponse{
		CommentsEnabled:        settings.CommentsEnabled,
		CommentsModeration:     settings.CommentsModeration,
		CommentsMaxLinks:       settings.CommentsMaxLinks,
		CommentsCloseAfterDays: settings.CommentsCloseAfterDays,
		CommentsThreading:      settings.CommentsThreading,
		CommentsOrder:          settings.CommentsOrder,
		CommentsPerPage:        settings.CommentsPerPage,
		CommentsNotice:         settings.CommentsNotice,
		CommentsPrivacyPageID:  nullInt64Ptr(settings.CommentsPrivacyPageID),
	}
	if admin {
		hold, spam := settings.CommentsHoldWords, settings.CommentsSpamWords
		if hold == nil {
			hold = []string{}
		}
		if spam == nil {
			spam = []string{}
		}
		response.CommentsHoldWords, response.CommentsSpamWords = &hold, &spam
	}
	return response
}
