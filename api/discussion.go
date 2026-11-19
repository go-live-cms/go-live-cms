// Package api – Reader comments (#499): storage and rules, phase 1 (#522).
//
// Design: docs/design/reader-comments.md (decisions in its section 18). In code and SQL
// these are "reader comments" (reader_comments, commenters, discussion), never #192's
// block comments (post_comments, /posts/:id/comments, commentBodyMax).
//
// This phase ships the storage (000061), the settings of 12.1 in GET/PUT /settings, the
// state rule (this file), the text rules (discussion_text.go), PUT /posts/:id/discussion
// (posts_discussion.go) and the retention job (discussion_maintenance.go).
// settings.comments_enabled starts off and its switch stays hidden until the moderation
// screens (#526, #527) ship. /public reads them since #523 (discussion_public.go, with its
// purges in discussion_purge.go); nothing writes them there yet (#524).
package api

import (
	"context"
	"crypto/hkdf"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"slices"
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// The post's Discussion choice (posts.discussion, 12.3).
const (
	postDiscussionDefault = "default"
	postDiscussionOpen    = "open"
	postDiscussionClosed  = "closed"
	postDiscussionOff     = "off"
)

// The discussion states (12.4).
const (
	discussionStateOpen   = "open"
	discussionStateClosed = "closed"
	discussionStateOff    = "off"
)

// postTypeSupportsComments is the post type's Comments field (12.2): "comments" in
// post_types.supports. 000061 adds it to post.
const postTypeSupportsComments = "comments"

// discussionSite is what the state rule reads from settings (12.1).
type discussionSite struct {
	Enabled        bool
	CloseAfterDays int32
}

// discussionType is what it reads from the post's type: whether the site serves the
// type (public and active) and its supports (12.2).
type discussionType struct {
	Public   bool
	Supports []string
}

// discussionPost is what it reads from the post (12.3, 6.1).
type discussionPost struct {
	Discussion       string
	FirstPublishedAt *time.Time
}

// DiscussionSetting is the clock-free half of the rule: what a cached /public answer may
// carry (problem 8). State is open, closed or off; ClosesAt is when an open state ends
// ("close after N days"), or nil.
type DiscussionSetting struct {
	State    string     `json:"state"`
	ClosesAt *time.Time `json:"closes_at"`
}

// discussionSetting is 12.4's rule without the clock. The TypeScript twin is
// discussionSetting in web/src/lib/discussion.ts; both run
// web/src/lib/discussionStateVectors.json.
//
//	off     if !site.comments_enabled, or post.discussion = 'off',
//	        or (post.discussion = 'default' and 'comments' ∉ type.supports),
//	        or the type is not public
//	closed  if post.discussion = 'closed'
//	open    otherwise, closing at first_published_at + close_after_days when the
//	        post follows the default and the site sets a limit
//
// An explicit Open ignores the timer, so a post can stay open on purpose.
func discussionSetting(site discussionSite, typ discussionType, post discussionPost) DiscussionSetting {
	switch {
	case !site.Enabled, !typ.Public, post.Discussion == postDiscussionOff:
		return DiscussionSetting{State: discussionStateOff}
	case post.Discussion == postDiscussionClosed:
		return DiscussionSetting{State: discussionStateClosed}
	case post.Discussion == postDiscussionOpen:
		return DiscussionSetting{State: discussionStateOpen}
	case post.Discussion != postDiscussionDefault, !slices.Contains(typ.Supports, postTypeSupportsComments):
		// An unknown choice (the column's CHECK refuses one) is treated as off.
		return DiscussionSetting{State: discussionStateOff}
	}
	setting := DiscussionSetting{State: discussionStateOpen}
	if site.CloseAfterDays > 0 && post.FirstPublishedAt != nil {
		closes := post.FirstPublishedAt.UTC().Add(time.Duration(site.CloseAfterDays) * 24 * time.Hour)
		setting.ClosesAt = &closes
	}
	return setting
}

// discussionState applies the clock to a setting: closed once now reaches closes_at.
// The write path, the admin and the renderer call it; a cached read never does.
func discussionState(setting DiscussionSetting, now time.Time) string {
	if setting.State == discussionStateOpen && setting.ClosesAt != nil && !now.Before(*setting.ClosesAt) {
		return discussionStateClosed
	}
	return setting.State
}

// discussionInputs are the rule's inputs read from rows.
func discussionInputs(settings db.Setting, postType db.PostType, post db.Post) (discussionSite, discussionType, discussionPost) {
	site := discussionSite{Enabled: settings.CommentsEnabled, CloseAfterDays: settings.CommentsCloseAfterDays}
	typ := discussionType{
		Public:   postType.Public && postType.IsActive,
		Supports: toPostTypeResponse(postType).Supports,
	}
	p := discussionPost{Discussion: post.Discussion}
	if post.FirstPublishedAt.Valid {
		first := post.FirstPublishedAt.Time
		p.FirstPublishedAt = &first
	}
	return site, typ, p
}

// postDiscussionSetting reads the site settings and the post's type and applies the rule
// to post. A type that no longer exists is not public: off.
func (server *Server) postDiscussionSetting(ctx context.Context, post db.Post) (DiscussionSetting, error) {
	settings, err := server.store.GetSettings(ctx)
	if err != nil {
		return DiscussionSetting{}, err
	}
	postType, err := server.store.GetPostType(ctx, post.PostType)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return DiscussionSetting{}, err
	}
	site, typ, p := discussionInputs(settings, postType, post)
	return discussionSetting(site, typ, p), nil
}

// discussionNetworkLabel is the HKDF label of the network hash key (7.2).
const discussionNetworkLabel = "golive.discussion-network"

// discussionNetworkHash is a comment's network_hash (7.2): HMAC-SHA256 of the client's
// rate-limit identity (clientKey: the address, or its /64 for IPv6) under a key derived
// from the PASETO local key with HKDF, so there is no new secret to manage. The address
// itself is never stored; rotating the PASETO key only stops new comments matching old
// ones. The write path (#524) stores it; RunDiscussionMaintenance NULLs it after 30 days.
func discussionNetworkHash(localKeyHex, ip string) ([]byte, error) {
	secret, err := hex.DecodeString(localKeyHex)
	if err != nil || len(secret) == 0 {
		return nil, errors.New("discussion: the PASETO local key is not usable")
	}
	key, err := hkdf.Key(sha256.New, secret, nil, discussionNetworkLabel, sha256.Size)
	if err != nil {
		return nil, err
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(clientKey(ip)))
	return mac.Sum(nil), nil
}
