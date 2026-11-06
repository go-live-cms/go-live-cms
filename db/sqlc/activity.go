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
	// Taxonomies and redirects (#331): admin-only in the feed (ListActivity shows
	// moderators only post and media events).
	ActivityObjectTerm     = "term"
	ActivityObjectRedirect = "redirect"
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

	// Review requests (#323, 000044), on the post. Payload: request_id, plus
	// reviewer_id on a request, resolution ("published") on review_resolved, which
	// 000044's publish trigger writes, and withdrawn on a requester's dismissal. Never
	// the notes (content).
	ActivityReviewRequested        = "review_requested"
	ActivityReviewResolved         = "review_resolved"
	ActivityReviewDismissed        = "review_dismissed"
	ActivityReviewChangesRequested = "review_changes_requested"

	// Ownership (#353): POST /posts/:id/transfer. The payload has the previous and
	// new owner's ids and whether the byline changed. A removal (#333) moves posts
	// too, recorded once as the member's "removed".
	ActivityTransferred = "transferred"

	// Media (ActivityDeleted too).
	ActivityUploaded = "uploaded"
	ActivityReplaced = "replaced"

	// Members and invitations (ActivityCreated too: an admin adding a member).
	ActivityInvited           = "invited"
	ActivityInvitationRevoked = "invitation_revoked"
	ActivityJoined            = "joined"
	ActivitySignedUp          = "signed_up" // open signup (#191): the new member, once the email is confirmed
	ActivityRoleChanged       = "role_changed"
	ActivityRemoved           = "removed"

	// Site settings.
	ActivitySettingsUpdated = "settings_updated"

	// Taxonomies and redirects (#331). terms_merged is on the kept term, payload
	// source_ids, moved_posts and taxonomy; the redirect events have status_code and
	// source (manual). Automatic redirects (slug changes) are part of the change that
	// made them and aren't recorded on their own.
	ActivityTermsMerged     = "terms_merged"
	ActivityRedirectCreated = "redirect_created"
	ActivityRedirectDeleted = "redirect_deleted"

	// Edit access (#321), on the post. The requester is the actor of
	// access_requested; the others are the reviewer's, with the requester (or
	// the member whose grant was revoked) as payload.user_id.
	ActivityAccessRequested = "access_requested"
	ActivityAccessGranted   = "access_granted"
	ActivityAccessDeclined  = "access_declined"
	ActivityAccessRevoked   = "access_revoked"
)
