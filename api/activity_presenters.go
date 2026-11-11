package api

import (
	"encoding/json"
	"time"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// ActivityPerson is a member named by an event: its actor, or the member a
// role change or removal was about. Joined at read time; null once removed.
type ActivityPerson struct {
	ID       int64  `json:"id"`
	Username string `json:"username"`
	FullName string `json:"full_name"`
}

// ActivityPost is the post an event is about, as it is now.
type ActivityPost struct {
	ID         int64  `json:"id"`
	Title      string `json:"title"`
	PostType   string `json:"post_type"`
	PostStatus string `json:"post_status"`
}

// ActivityMedia is the media file an event is about, as it is now.
type ActivityMedia struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// ActivityPlugin is the plugin an event is about (#455), as it is now.
type ActivityPlugin struct {
	ID   int64  `json:"id"`
	Slug string `json:"slug"`
	Name string `json:"name"`
}

// ActivityResponse is one event of GET /activity. post, media, user and plugin are set
// for that object type while the object exists; a deleted one leaves them out,
// and object_type/object_id still say what it was.
type ActivityResponse struct {
	ID         int64           `json:"id"`
	Verb       string          `json:"verb"`
	ObjectType string          `json:"object_type"`
	ObjectID   int64           `json:"object_id"`
	CreatedAt  time.Time       `json:"created_at"`
	Actor      *ActivityPerson `json:"actor"`
	Post       *ActivityPost   `json:"post,omitempty"`
	Media      *ActivityMedia  `json:"media,omitempty"`
	User       *ActivityPerson `json:"user,omitempty"`
	Plugin     *ActivityPlugin `json:"plugin,omitempty"`
	// Subject is the member an edit access event is about (#321: the requester
	// of a grant or decline, whose grant was revoked), while they exist.
	Subject *ActivityPerson `json:"subject,omitempty"`
	// Payload: the event's details (a role, a version number, setting names).
	Payload json.RawMessage `json:"payload"`
}

func toActivityResponse(row db.ListActivityRow) ActivityResponse {
	rsp := ActivityResponse{
		ID:         row.ID,
		Verb:       row.Verb,
		ObjectType: row.ObjectType,
		ObjectID:   row.ObjectID,
		CreatedAt:  row.CreatedAt,
		Payload:    row.Payload,
	}
	if len(rsp.Payload) == 0 {
		rsp.Payload = json.RawMessage(`{}`)
	}
	if row.ActorID.Valid && row.ActorUsername.Valid {
		rsp.Actor = &ActivityPerson{ID: row.ActorID.Int64, Username: row.ActorUsername.String, FullName: row.ActorFullName.String}
	}
	if row.SubjectID.Valid && row.SubjectUsername.Valid {
		rsp.Subject = &ActivityPerson{ID: row.SubjectID.Int64, Username: row.SubjectUsername.String, FullName: row.SubjectFullName.String}
	}
	switch row.ObjectType {
	case db.ActivityObjectPost:
		if row.PostTitle.Valid {
			rsp.Post = &ActivityPost{ID: row.ObjectID, Title: row.PostTitle.String, PostType: row.PostType.String, PostStatus: row.PostStatus.String}
		}
	case db.ActivityObjectMedia:
		if row.MediaName.Valid {
			rsp.Media = &ActivityMedia{ID: row.ObjectID, Name: row.MediaName.String}
		}
	case db.ActivityObjectUser:
		if row.TargetUsername.Valid {
			rsp.User = &ActivityPerson{ID: row.ObjectID, Username: row.TargetUsername.String, FullName: row.TargetFullName.String}
		}
	case db.ActivityObjectPlugin:
		if row.PluginSlug.Valid {
			rsp.Plugin = &ActivityPlugin{ID: row.ObjectID, Slug: row.PluginSlug.String, Name: row.PluginName.String}
		}
	}
	return rsp
}

// ContinueEditingPost is one card of Home's "Continue where you left off".
type ContinueEditingPost struct {
	ID         int64      `json:"id"`
	Title      string     `json:"title"`
	PostType   string     `json:"post_type"`
	PostStatus string     `json:"post_status"`
	PublishAt  *time.Time `json:"publish_at,omitempty"`
	// UpdateAt is a pending scheduled Update's time (#335).
	UpdateAt              *time.Time `json:"update_at,omitempty"`
	HasUnpublishedChanges bool       `json:"has_unpublished_changes,omitempty"`
	ScheduleFailed        bool       `json:"schedule_failed,omitempty"`
	// EditedAt is when the caller last worked on it.
	EditedAt time.Time `json:"edited_at"`
}

func toContinueEditingPost(row db.ListContinueEditingRow) ContinueEditingPost {
	return ContinueEditingPost{
		ID:                    row.ID,
		Title:                 row.Title,
		PostType:              row.PostType,
		PostStatus:            row.PostStatus,
		PublishAt:             nullTimePtr(row.PublishAt),
		UpdateAt:              nullTimePtr(row.UpdateAt),
		HasUnpublishedChanges: row.HasUnpublishedChanges,
		ScheduleFailed:        row.PostStatus == postStatusScheduled && row.PublishFailedAt.Valid,
		EditedAt:              row.EditedAt,
	}
}

// FailedSchedule is a scheduled post whose last publish attempt failed.
type FailedSchedule struct {
	ID        int64      `json:"id"`
	Title     string     `json:"title"`
	PostType  string     `json:"post_type"`
	PublishAt *time.Time `json:"publish_at,omitempty"`
	FailedAt  *time.Time `json:"failed_at,omitempty"`
	// Reason is the scheduler's reason code (schedule_failure.reason on the post).
	Reason   string `json:"reason"`
	Attempts int32  `json:"attempts"`
}

// UnpublishedChangesPost is a published post whose working copy differs.
type UnpublishedChangesPost struct {
	ID         int64           `json:"id"`
	Title      string          `json:"title"`
	PostType   string          `json:"post_type"`
	ChangedAt  time.Time       `json:"changed_at"`
	LastEditor *ActivityPerson `json:"last_editor"`
}

// AttentionList is up to a few items and how many there are in all.
type AttentionList[T any] struct {
	Total int64 `json:"total"`
	Posts []T   `json:"posts"`
}

// MissingAltSummary is GET /media/missing-alt's answer.
type MissingAltSummary struct {
	MediaCount         int64 `json:"media_count"`
	PublishedPostCount int64 `json:"published_post_count"`
}

// NeedsAttentionResponse is GET /home/needs-attention. Sections a role can't
// act on are null (see getNeedsAttention).
type NeedsAttentionResponse struct {
	FailedSchedules    AttentionList[FailedSchedule]          `json:"failed_schedules"`
	UnpublishedChanges *AttentionList[UnpublishedChangesPost] `json:"unpublished_changes"`
	MissingAlt         *MissingAltSummary                     `json:"missing_alt"`
	// AccessRequests are open edit access requests the caller may answer (#321).
	AccessRequests AttentionList[AttentionAccessRequest] `json:"access_requests"`
	// ReviewRequests (#323): open review requests the caller should review (editors
	// and admins; null otherwise), see ListReviewRequestsForReviewer.
	ReviewRequests *AttentionList[ReviewRequestAttention] `json:"review_requests"`
}

// AttentionAccessRequest is an open edit access request (#321): who asked, for
// which post. The item lists posts, so the request is keyed by its post.
type AttentionAccessRequest struct {
	RequestID int64          `json:"request_id"`
	ID        int64          `json:"id"`
	Title     string         `json:"title"`
	PostType  string         `json:"post_type"`
	Message   string         `json:"message"`
	CreatedAt time.Time      `json:"created_at"`
	Requester ActivityPerson `json:"requester"`
}

func toAttentionAccessRequests(rows []db.ListPendingAccessRequestsForReviewerRow) AttentionList[AttentionAccessRequest] {
	list := AttentionList[AttentionAccessRequest]{Posts: make([]AttentionAccessRequest, len(rows))}
	for i, row := range rows {
		list.Total = row.Total
		list.Posts[i] = AttentionAccessRequest{
			RequestID: row.ID,
			ID:        row.PostID,
			Title:     row.PostTitle,
			PostType:  row.PostType,
			Message:   row.Message,
			CreatedAt: row.CreatedAt,
			Requester: ActivityPerson{ID: row.RequesterID, Username: row.RequesterUsername, FullName: row.RequesterFullName},
		}
	}
	return list
}

func toFailedSchedules(rows []db.ListFailedScheduledPostsRow) AttentionList[FailedSchedule] {
	list := AttentionList[FailedSchedule]{Posts: make([]FailedSchedule, len(rows))}
	for i, row := range rows {
		list.Total = row.Total
		list.Posts[i] = FailedSchedule{
			ID:        row.ID,
			Title:     row.Title,
			PostType:  row.PostType,
			PublishAt: nullTimePtr(row.PublishAt),
			FailedAt:  nullTimePtr(row.PublishFailedAt),
			Reason:    row.PublishError.String,
			Attempts:  row.PublishAttempts,
		}
	}
	return list
}

func toUnpublishedChanges(rows []db.ListPostsWithUnpublishedChangesRow) *AttentionList[UnpublishedChangesPost] {
	list := AttentionList[UnpublishedChangesPost]{Posts: make([]UnpublishedChangesPost, len(rows))}
	for i, row := range rows {
		list.Total = row.Total
		post := UnpublishedChangesPost{ID: row.ID, Title: row.Title, PostType: row.PostType, ChangedAt: row.ChangedAt}
		if row.LastEditorID.Valid {
			post.LastEditor = &ActivityPerson{ID: row.LastEditorID.Int64, Username: row.LastEditorUsername.String, FullName: row.LastEditorFullName.String}
		}
		list.Posts[i] = post
	}
	return &list
}
