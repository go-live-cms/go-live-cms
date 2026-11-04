// avatar_handlers_write sets and removes the caller's own avatar (#334). See
// avatar_utils.go for the pipeline and storage.
package api

import (
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"

	"github.com/gin-gonic/gin"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// uploadAvatar sets the caller's avatar from an uploaded image.
//
// Multipart form: file (JPEG, PNG, GIF or WebP, at most avatarMaxBytes; a GIF's
// first frame), and optionally focal_x and focal_y (both or neither, 0..1 of the
// width and height as displayed), which the square crop is centered on.
//
// Returns:
//   - 200 OK: {"user": ...} with the new avatar
//   - 400 Bad Request: no file, a type that isn't allowed, an unreadable image,
//     too many pixels, or a bad focal point
//   - 413 Request Entity Too Large: over avatarMaxBytes
func (server *Server) uploadAvatar(c *gin.Context) {
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}

	limitUploadBody(c, avatarMaxBytes, 1)
	file, header, err := c.Request.FormFile("file")
	if err != nil {
		if isBodyTooLarge(err) {
			respondAvatarTooLarge(c)
			return
		}
		c.JSON(http.StatusBadRequest, gin.H{"error": "choose an image to upload", "fields": gin.H{"file": "required"}})
		return
	}
	defer file.Close()
	if header.Size > avatarMaxBytes {
		respondAvatarTooLarge(c)
		return
	}
	focal, ok := avatarFocalFromForm(c)
	if !ok {
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, avatarMaxBytes+1))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "failed to read the uploaded file"})
		return
	}
	if int64(len(data)) > avatarMaxBytes {
		respondAvatarTooLarge(c)
		return
	}

	release := acquireImagePipeline()
	encoded, ext, err := renderAvatar(data, focal)
	release()
	if err != nil {
		switch {
		case errors.Is(err, errAvatarType):
			c.JSON(http.StatusBadRequest, gin.H{"error": "use a JPEG, PNG, GIF or WebP image", "code": "avatar_type"})
		case errors.Is(err, errAvatarTooLarge):
			c.JSON(http.StatusBadRequest, gin.H{"error": "the image has too many pixels; use a smaller one", "code": "avatar_dimensions"})
		case errors.Is(err, errAvatarUnreadable):
			c.JSON(http.StatusBadRequest, gin.H{"error": "the file isn't a readable image", "code": "avatar_unreadable"})
		default:
			server.requestLog(c).Error("avatar encoding failed", "user_id", caller.ID, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to process the image"})
		}
		return
	}

	url, stored, err := saveAvatarFile(server.config.UploadPath, encoded, ext)
	if err != nil {
		server.requestLog(c).Error("avatar save failed", "user_id", caller.ID, "error", err)
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to save the image"})
		return
	}
	previous, err := server.store.SetUserAvatar(c.Request.Context(), db.SetUserAvatarParams{UserID: caller.ID, AvatarUrl: url})
	if err != nil {
		removeFileQuietly(stored)
		server.respondAvatarStoreError(c, caller.ID, err)
		return
	}
	server.removeOldAvatar(c, caller.ID, previous)

	caller.AvatarUrl = url
	c.JSON(http.StatusOK, gin.H{"user": toPrivateUser(caller)})
}

// deleteAvatar removes the caller's avatar; the initial is shown again.
//
// Returns 200 {"user": ...}, also when there was none.
func (server *Server) deleteAvatar(c *gin.Context) {
	caller, ok := server.callerUser(c)
	if !ok {
		return
	}
	previous, err := server.store.SetUserAvatar(c.Request.Context(), db.SetUserAvatarParams{UserID: caller.ID, AvatarUrl: ""})
	if err != nil {
		server.respondAvatarStoreError(c, caller.ID, err)
		return
	}
	server.removeOldAvatar(c, caller.ID, previous)

	caller.AvatarUrl = ""
	c.JSON(http.StatusOK, gin.H{"user": toPrivateUser(caller)})
}

// avatarFocalFromForm reads the optional focal_x/focal_y form fields.
func avatarFocalFromForm(c *gin.Context) (*FocalPoint, bool) {
	xs, ys := c.PostForm("focal_x"), c.PostForm("focal_y")
	if xs == "" && ys == "" {
		return nil, true
	}
	x, errX := strconv.ParseFloat(xs, 64)
	y, errY := strconv.ParseFloat(ys, 64)
	if errX != nil || errY != nil || x < 0 || x > 1 || y < 0 || y > 1 {
		c.JSON(http.StatusBadRequest, gin.H{
			"error":  "focal_x and focal_y must both be numbers from 0 to 1",
			"fields": gin.H{"focal_x": "0..1", "focal_y": "0..1"},
		})
		return nil, false
	}
	return &FocalPoint{X: x, Y: y}, true
}

func respondAvatarTooLarge(c *gin.Context) {
	c.JSON(http.StatusRequestEntityTooLarge, gin.H{
		"error": fmt.Sprintf("the image is too large. Maximum size is %d MB", avatarMaxBytes>>20),
		"code":  "avatar_too_large",
	})
}

func (server *Server) respondAvatarStoreError(c *gin.Context, userID int64, err error) {
	if errors.Is(err, sql.ErrNoRows) {
		// Removed meanwhile (authMiddleware loaded the row moments ago).
		c.JSON(http.StatusForbidden, gin.H{"error": "user no longer exists"})
		return
	}
	server.requestLog(c).Error("avatar update failed", "user_id", userID, "error", err)
	c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update the avatar"})
}

// removeOldAvatar deletes the replaced avatar's file. The change is committed, so a
// failure only leaves an orphaned file behind: logged, not reported.
func (server *Server) removeOldAvatar(c *gin.Context, userID int64, previous string) {
	if err := removeAvatarFile(server.config.UploadPath, previous); err != nil {
		server.requestLog(c).Warn("old avatar file not removed", "user_id", userID, "error", err)
	}
}

// removeFileQuietly deletes a file this request wrote and no longer needs.
func removeFileQuietly(file string) {
	_ = os.Remove(file)
}
