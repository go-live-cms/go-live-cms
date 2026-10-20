package api

// createCollabTicketRequest names the collab document (e.g. "post-12") the
// ticket opens. The collab server rejects the ticket for any other document.
type createCollabTicketRequest struct {
	Doc string `json:"doc" binding:"required,max=128"`
}
