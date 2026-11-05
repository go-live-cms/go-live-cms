package db

// The activity log's vocabulary (#324, 000036). Verbs and object types are plain
// text in the table (checked only for their format), so a new reader or writer
// (#323 review requests, #321 access requests, #328) adds its own here; the API's
// feed passes unknown verbs through, and the admin shows a generic line for them.
const (
	ActivityObjectPost       = "post"
	ActivityObjectMedia      = "media"
	ActivityObjectUser       = "user"
	ActivityObjectInvitation = "invitation"
	ActivityObjectSettings   = "settings"
)

const (
	// Posts.
	ActivityCreated       = "created"
	ActivityUpdated       = "updated" // details/SEO/featured image saved (throttled)
	ActivityEdited        = "edited"  // body edited through the collab server (throttled)
	ActivityPublished     = "published"
	ActivityUnpublished   = "unpublished"
	ActivityScheduled     = "scheduled"
	ActivityUnscheduled   = "unscheduled"
	ActivityDeleted       = "deleted"
	ActivityStatusChanged = "status_changed" // PUT /posts/:id set another status

	// A published post's Update, scheduled (#335); applying it is "published".
	ActivityUpdateScheduled   = "update_scheduled"
	ActivityUpdateUnscheduled = "update_unscheduled"
	ActivityVersionRestored   = "version_restored"

	// The trash (#327): moved there, and back out. Deleting one for good is
	// ActivityDeleted, as the hard delete was before the trash.
	ActivityTrashed  = "trashed"
	ActivityRestored = "restored"

	// Review requests (#323, 000039), on the post. Payload: request_id, plus
	// reviewer_id on a request, resolution ("published") on review_resolved, which
	// 000039's publish trigger writes, and withdrawn on a requester's dismissal. Never
	// the notes (content).
	ActivityReviewRequested        = "review_requested"
	ActivityReviewResolved         = "review_resolved"
	ActivityReviewDismissed        = "review_dismissed"
	ActivityReviewChangesRequested = "review_changes_requested"

	// Media (ActivityDeleted too).
	ActivityUploaded = "uploaded"
	ActivityReplaced = "replaced"

	// Members and invitations (ActivityCreated too: an admin adding a member).
	ActivityInvited           = "invited"
	ActivityInvitationRevoked = "invitation_revoked"
	ActivityJoined            = "joined"
	ActivityRoleChanged       = "role_changed"
	ActivityRemoved           = "removed"

	// Site settings.
	ActivitySettingsUpdated = "settings_updated"
)
