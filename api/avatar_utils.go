// avatar_utils turns an uploaded picture into a profile avatar (#334).
//
// # Storage
//
// An avatar is a dedicated upload, not a media item: it isn't content, so it stays
// out of the library (where editors could delete or reuse it) and out of post_media.
// The API decodes the upload, crops a square around the focal point (the center by
// default), scales it to avatarEdge and encodes it again, as JPEG (PNG when it has
// transparency). The stored file is pixels only: no EXIF, GPS, XMP or text chunk of
// the original survives, and nothing a client sent is served back as is.
//
// Files live in <UPLOAD_PATH>/_avatars/ (inside UPLOAD_PATH, so backups take them),
// named "avatar-<32 hex>.<ext>" through saveUploadedFile (#399: 128 random bits,
// O_EXCL). users.avatar_url holds the /uploads URL path publicMediaPath gives it, so
// every response, bylines built in SQL included, returns it unchanged. Replacing or
// removing one deletes the old file after the database agrees; only a path that
// parses as one of ours is ever deleted (avatarFilePath).
package api

import (
	"bytes"
	"errors"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"golang.org/x/image/draw"
)

const (
	// avatarMaxBytes caps an avatar upload: a phone photo fits, and the API
	// decodes it whole.
	avatarMaxBytes int64 = 5 << 20
	// avatarEdge is the stored square's side. Avatars are shown at 20-64 CSS px,
	// so this covers 4x screens; a smaller source is never upscaled.
	avatarEdge = 256
	// avatarDirName is the avatars' directory inside UPLOAD_PATH.
	avatarDirName = "_avatars"
)

var (
	errAvatarType       = errors.New("unsupported image type")
	errAvatarUnreadable = errors.New("unreadable image")
	errAvatarTooLarge   = errors.New("image dimensions too large")
)

// avatarFileName matches the names saveAvatarFile writes.
var avatarFileName = regexp.MustCompile(`^avatar-[0-9a-f]{32}\.(jpg|png)$`)

// avatarFormats are the accepted uploads: what the browser shows and Go decodes.
// The key is http.DetectContentType's answer; the value image.DecodeConfig's format
// name, which must agree.
var avatarFormats = map[string]string{
	"image/jpeg": "jpeg",
	"image/png":  "png",
	"image/gif":  "gif",
	"image/webp": "webp",
}

// renderAvatar validates an uploaded image and returns the stored avatar: the
// square around focal (displayed coordinates; nil = center), at most avatarEdge
// on a side, encoded as JPEG or (with transparency) PNG, and the file extension.
func renderAvatar(data []byte, focal *FocalPoint) ([]byte, string, error) {
	sniffed, _, _ := strings.Cut(http.DetectContentType(data), ";")
	format, ok := avatarFormats[sniffed]
	if !ok {
		return nil, "", errAvatarType
	}
	cfg, decoded, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || decoded != format {
		return nil, "", errAvatarUnreadable
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxVariantSourcePixels {
		return nil, "", errAvatarTooLarge
	}

	var img image.Image
	if format == "gif" {
		img, err = gif.Decode(bytes.NewReader(data)) // the first frame
	} else {
		img, _, err = image.Decode(bytes.NewReader(data))
	}
	if err != nil {
		return nil, "", errAvatarUnreadable
	}
	orientation := 1
	if format == "jpeg" {
		orientation = jpegOrientation(data)
	}

	crop := avatarCrop(img.Bounds(), orientation, focal)
	edge := min(crop.Dx(), avatarEdge)
	scaled := image.NewRGBA(image.Rect(0, 0, edge, edge))
	draw.CatmullRom.Scale(scaled, scaled.Bounds(), img, crop, draw.Src, nil)
	out := applyOrientation(scaled, orientation)

	var buf bytes.Buffer
	ext := ".jpg"
	if isOpaque(scaled) {
		err = jpeg.Encode(&buf, out, &jpeg.Options{Quality: variantJPEGQuality})
	} else {
		ext = ".png"
		err = png.Encode(&buf, out)
	}
	if err != nil {
		return nil, "", err
	}
	return buf.Bytes(), ext, nil
}

// avatarCrop is the largest square of an image whose stored pixels are bounds,
// centered on the focal point as displayed (after its EXIF orientation) and kept
// inside the image. A square is the same size in either orientation, so only the
// focal point needs mapping onto the stored pixels.
func avatarCrop(bounds image.Rectangle, orientation int, focal *FocalPoint) image.Rectangle {
	w, h := bounds.Dx(), bounds.Dy()
	side := min(w, h)
	fx, fy := 0.5, 0.5
	if focal != nil {
		fx, fy = focal.X, focal.Y
	}
	sx, sy := storedFocal(orientation, fx, fy)
	x0 := clampInt(int(sx*float64(w)+0.5)-side/2, 0, w-side)
	y0 := clampInt(int(sy*float64(h)+0.5)-side/2, 0, h-side)
	return image.Rect(x0, y0, x0+side, y0+side).Add(bounds.Min)
}

// avatarDir is where avatars are stored.
func avatarDir(uploadPath string) string {
	return filepath.Join(uploadPath, avatarDirName)
}

// saveAvatarFile writes an encoded avatar under a new unguessable name and returns
// its /uploads URL path and its file path.
func saveAvatarFile(uploadPath string, encoded []byte, ext string) (url, file string, err error) {
	stored, err := saveUploadedFile(bytes.NewReader(encoded), "avatar"+ext, avatarDir(uploadPath))
	if err != nil {
		return "", "", err
	}
	return publicMediaPath(uploadPath, stored), stored, nil
}

// avatarFilePath maps an avatar_url back to its file, or "" when it isn't one this
// API wrote (a different prefix, a name that isn't ours, anything with a separator),
// so removing an avatar can never delete another file.
func avatarFilePath(uploadPath, url string) string {
	if url == "" {
		return ""
	}
	name := path.Base(url)
	if !avatarFileName.MatchString(name) {
		return ""
	}
	file := filepath.Join(avatarDir(uploadPath), name)
	if publicMediaPath(uploadPath, file) != url {
		return ""
	}
	return file
}

// removeAvatarFile deletes the file behind an avatar_url (see avatarFilePath). An
// already-missing file, or a URL that isn't ours, is not an error.
func removeAvatarFile(uploadPath, url string) error {
	file := avatarFilePath(uploadPath, url)
	if file == "" {
		return nil
	}
	if err := os.Remove(file); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// avatarResponse is the avatar field of a user shape: its URL, or null.
func avatarResponse(url string) *string {
	if url == "" {
		return nil
	}
	return &url
}
