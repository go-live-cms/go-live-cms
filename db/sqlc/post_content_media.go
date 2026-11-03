package db

import "context"

// ContentMediaUse is one content block showing a media (#176): the image
// block blockID, of Block Spec type BlockType, shows media MediaID. The api
// package reads them from a block doc in document order; a media shown by two
// blocks gives two uses.
type ContentMediaUse struct {
	MediaID   int64
	BlockID   string
	BlockType string
}

// syncContentMedia syncs post postID's content media links (post_media) to
// uses with SyncPostContentMedia, which takes the uses as parallel arrays.
func syncContentMedia(ctx context.Context, q *Queries, postID int64, uses []ContentMediaUse) error {
	arg := SyncPostContentMediaParams{
		PostID:     postID,
		MediaIds:   make([]int64, len(uses)),
		BlockIds:   make([]string, len(uses)),
		BlockTypes: make([]string, len(uses)),
	}
	for i, use := range uses {
		arg.MediaIds[i] = use.MediaID
		arg.BlockIds[i] = use.BlockID
		arg.BlockTypes[i] = use.BlockType
	}
	return q.SyncPostContentMedia(ctx, arg)
}
