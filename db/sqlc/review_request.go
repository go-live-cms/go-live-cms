package db

// Review request statuses (#323, 000044's review_requests_status CHECK). "published"
// is set only by the publish trigger.
const (
	ReviewStatusOpen             = "open"
	ReviewStatusPublished        = "published"
	ReviewStatusDismissed        = "dismissed"
	ReviewStatusChangesRequested = "changes_requested"
)
