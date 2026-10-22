// media_variants.go generates the resized copies ("variants") of uploaded
// images (#255): thumb, medium and large, by long edge, keeping the aspect
// ratio and never upscaling.
//
// # Storage
//
// Variants live next to the original under UploadPath, in a directory named
// after the original's file name:
//
//	uploads/media/hero.jpg
//	uploads/media/_variants/hero.jpg/thumb.jpg
//	uploads/media/_variants/hero.jpg/medium.jpg
//
// Stored upload names never start with "_" (cleanFilename trims it), so the
// _variants directory can't collide with an upload. Replace keeps media_path,
// so the variant URLs stay stable across a replace too. The media row's
// variants column records what was generated (MediaVariants).
//
// # Formats
//
// JPEG, PNG, GIF, WebP and BMP are decoded in pure Go (no CGO). Variants are
// JPEG when the image is opaque and PNG when it has transparency. Animated
// GIFs get no variants (a still copy would lose the animation), and neither
// do images over maxVariantSourcePixels (decoding them would need too much
// memory). Re-encoding drops all metadata (EXIF, GPS, XMP); a JPEG's EXIF
// orientation is applied to the pixels first so variants display upright.
//
// # Lifecycle
//
// stageImageVariants writes the variants to a temporary directory; commit
// moves them into place (replacing any older set) once the database agrees,
// and discard throws them away. That keeps a failed upload or replace from
// leaving variants that don't match the row. Delete removes the directory
// with the original (removeMediaVariants).
package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/sqlc-dev/pqtype"
	_ "golang.org/x/image/bmp"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

const (
	// variantsDirName is the directory, inside the original's directory,
	// that holds every image's variants.
	variantsDirName = "_variants"
	// maxVariantSourcePixels caps the images that get variants: decoding
	// needs about 4 bytes per pixel, so 40 MP is ~160 MB.
	maxVariantSourcePixels = 40_000_000
	variantJPEGQuality     = 82
)

// imageVariantSpec is one variant size, by the long edge in pixels.
type imageVariantSpec struct {
	Name     string
	LongEdge int
}

// imageVariantSpecs are generated largest first, each scaled from the one
// before it (cheaper than scaling the original every time).
var imageVariantSpecs = []imageVariantSpec{
	{"large", 1600},
	{"medium", 800},
	{"thumb", 320},
}

// MediaVariant is one generated variant, as stored in media.variants and
// returned in media responses. Path has the same form as media_path.
type MediaVariant struct {
	Path     string `json:"path"`
	Width    int32  `json:"width"`
	Height   int32  `json:"height"`
	MimeType string `json:"mime_type"`
	FileSize int64  `json:"file_size"`
}

// MediaVariants maps a variant name (thumb, medium, large) to its file. An
// image smaller than a size has no variant of that size.
type MediaVariants map[string]MediaVariant

// publicVariants returns variants with each path mapped to its public URL
// path (publicMediaPath): variant paths are stored in media_path's
// filesystem form. Never nil, so responses always carry an object.
func publicVariants(uploadPath string, variants MediaVariants) MediaVariants {
	out := make(MediaVariants, len(variants))
	for name, v := range variants {
		v.Path = publicMediaPath(uploadPath, v.Path)
		out[name] = v
	}
	return out
}

// parseMediaVariants decodes the variants column. Anything unreadable is
// treated as no variants: they are derived data.
func parseMediaVariants(raw json.RawMessage) MediaVariants {
	if len(raw) == 0 {
		return nil
	}
	var variants MediaVariants
	if err := json.Unmarshal(raw, &variants); err != nil || len(variants) == 0 {
		return nil
	}
	return variants
}

// Reasons an image gets no variants. They are not upload errors: the
// original is kept and served as is.
var (
	errImageTooLargeToResize = errors.New("image too large to generate variants")
	errAnimatedImage         = errors.New("animated image")
	// errImageTooSmall is internal to stageImageVariants: such an image just
	// has no variants.
	errImageTooSmall = errors.New("image smaller than the smallest variant")
)

// smallestVariantEdge is the long edge at or below which an image gets no
// variants at all.
func smallestVariantEdge() int {
	return imageVariantSpecs[len(imageVariantSpecs)-1].LongEdge
}

// imagePipelineSlots bounds how many images are decoded and resized at once
// (uploads, replaces and the backfill share it). A 40 MP image needs ~160 MB
// decoded plus the scaled copies, so unbounded parallel uploads could run the
// process out of memory; the rest wait their turn.
var imagePipelineSlots = make(chan struct{}, 2)

func acquireImagePipeline() func() {
	imagePipelineSlots <- struct{}{}
	return func() { <-imagePipelineSlots }
}

// stagedVariants is a set of generated variants waiting for the database.
// A nil *stagedVariants is valid and does nothing.
type stagedVariants struct {
	final    string // the original's variant directory
	staging  string // temporary directory holding the new files; "" if none
	variants MediaVariants
}

// column is the value for the variants column: NULL (stored as {}) when
// there are none.
func (s *stagedVariants) column() pqtype.NullRawMessage {
	if s == nil || len(s.variants) == 0 {
		return pqtype.NullRawMessage{}
	}
	raw, err := json.Marshal(s.variants)
	if err != nil {
		return pqtype.NullRawMessage{}
	}
	return pqtype.NullRawMessage{RawMessage: raw, Valid: true}
}

// commit replaces whatever variants the original had with the staged ones
// (none, if nothing was generated).
func (s *stagedVariants) commit() error {
	if s == nil {
		return nil
	}
	if err := os.RemoveAll(s.final); err != nil {
		return err
	}
	if s.staging == "" {
		return nil
	}
	return os.Rename(s.staging, s.final)
}

// commitForNewRow moves the variants into place before a new row is
// inserted (there is nothing older to keep) and returns the column value:
// NULL if the move failed, so the row never lists files that aren't there.
// If the insert then fails, removeMediaVariants cleans up.
func (s *stagedVariants) commitForNewRow(log interface{ Warn(string, ...any) }) pqtype.NullRawMessage {
	if s == nil {
		return pqtype.NullRawMessage{}
	}
	if err := s.commit(); err != nil {
		log.Warn("media: moving variants into place failed", "path", s.final, "error", err)
		s.discard()
		return pqtype.NullRawMessage{}
	}
	return s.column()
}

// discard removes the staged files and leaves the current variants alone.
func (s *stagedVariants) discard() {
	if s != nil && s.staging != "" {
		os.RemoveAll(s.staging)
	}
}

// variantDirFor is the variant directory of the original stored at target.
func variantDirFor(target string) string {
	return filepath.Join(filepath.Dir(target), variantsDirName, filepath.Base(target))
}

// variantMediaPath is the media_path-style path of a variant file of the
// original at mediaPath, built by string so it keeps mediaPath's form
// ("./uploads/x.jpg", "/app/uploads/media/x.jpg", ...).
func variantMediaPath(mediaPath, file string) string {
	base := filepath.Base(filepath.FromSlash(mediaPath))
	dir := strings.TrimSuffix(mediaPath, base)
	return dir + variantsDirName + "/" + base + "/" + file
}

// stageImageVariants generates the variants of the image stored at
// mediaPath. It returns nil for a path outside uploadPath (seeded or legacy
// rows, whose files the API doesn't manage). Otherwise the result is never
// nil: when no variants can be made (not an image, too large, animated,
// undecodable) it holds none, so committing it still clears stale ones, and
// the reason is returned alongside it.
func stageImageVariants(uploadPath, mediaPath string) (*stagedVariants, error) {
	target, err := resolveInUploadDir(uploadPath, mediaPath)
	if err != nil {
		return nil, nil
	}
	staged := &stagedVariants{final: variantDirFor(target)}
	if !isImageFile(target) {
		return staged, nil
	}

	src, err := decodeForVariants(target)
	if errors.Is(err, errImageTooSmall) {
		return staged, nil // smaller than the smallest variant
	}
	if err != nil {
		return staged, err
	}

	parent := filepath.Dir(staged.final)
	if err := os.MkdirAll(parent, 0755); err != nil {
		return staged, err
	}
	staging, err := os.MkdirTemp(parent, ".staging-*")
	if err != nil {
		return staged, err
	}
	// MkdirTemp creates 0700; this directory becomes the public variant
	// directory, so give it the same mode as the rest of the upload tree.
	if err := os.Chmod(staging, 0755); err != nil {
		os.RemoveAll(staging)
		return staged, err
	}

	variants, err := writeImageVariants(src, staging, mediaPath)
	if err != nil {
		os.RemoveAll(staging)
		return staged, err
	}
	if len(variants) == 0 {
		os.RemoveAll(staging)
		return staged, nil
	}
	staged.staging = staging
	staged.variants = variants
	return staged, nil
}

// orientedImage is a decoded image plus the EXIF orientation (1-8) its
// pixels still need.
type orientedImage struct {
	img         image.Image
	orientation int
}

// decodeForVariants decodes the image at path after checking that it is
// small enough and not animated.
func decodeForVariants(path string) (orientedImage, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return orientedImage{}, err
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return orientedImage{}, err
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > maxVariantSourcePixels {
		return orientedImage{}, errImageTooLargeToResize
	}
	// The header is enough to know an image gets no variants; don't decode it.
	if max(cfg.Width, cfg.Height) <= smallestVariantEdge() {
		return orientedImage{}, errImageTooSmall
	}

	var img image.Image
	if format == "gif" {
		anim, err := gif.DecodeAll(bytes.NewReader(data))
		if err != nil {
			return orientedImage{}, err
		}
		if len(anim.Image) > 1 {
			return orientedImage{}, errAnimatedImage
		}
		img = anim.Image[0]
	} else {
		img, _, err = image.Decode(bytes.NewReader(data))
		if err != nil {
			return orientedImage{}, err
		}
	}

	orientation := 1
	if format == "jpeg" {
		orientation = jpegOrientation(data)
	}
	return orientedImage{img: img, orientation: orientation}, nil
}

// writeImageVariants scales src to every size smaller than it and writes the
// files to dir, returning them keyed by name.
func writeImageVariants(src orientedImage, dir, mediaPath string) (MediaVariants, error) {
	bounds := src.img.Bounds()
	// Orientations 5-8 swap the axes: scale in the stored orientation, to the
	// swapped size, then rotate the (small) result.
	swap := src.orientation >= 5 && src.orientation <= 8
	w, h := bounds.Dx(), bounds.Dy()
	if swap {
		w, h = h, w
	}
	longEdge := max(w, h)

	opaque := isOpaque(src.img)
	ext, mimeType := ".png", "image/png"
	if opaque {
		ext, mimeType = ".jpg", "image/jpeg"
	}

	variants := MediaVariants{}
	from := src.img
	for _, spec := range imageVariantSpecs {
		if longEdge <= spec.LongEdge {
			continue // never upscale; the original covers this size
		}
		vw, vh := scaledSize(w, h, spec.LongEdge)
		sw, sh := vw, vh
		if swap {
			sw, sh = vh, vw
		}
		scaled := image.NewRGBA(image.Rect(0, 0, sw, sh))
		draw.CatmullRom.Scale(scaled, scaled.Bounds(), from, from.Bounds(), draw.Src, nil)
		from = scaled

		out := applyOrientation(scaled, src.orientation)
		file := spec.Name + ext
		size, err := encodeVariant(filepath.Join(dir, file), out, opaque)
		if err != nil {
			return nil, err
		}
		variants[spec.Name] = MediaVariant{
			Path:     variantMediaPath(mediaPath, file),
			Width:    int32(out.Bounds().Dx()),
			Height:   int32(out.Bounds().Dy()),
			MimeType: mimeType,
			FileSize: size,
		}
	}
	return variants, nil
}

// scaledSize fits w x h to longEdge on its longer side, keeping the aspect
// ratio (each side at least 1px).
func scaledSize(w, h, longEdge int) (int, int) {
	if w >= h {
		return longEdge, max(1, (h*longEdge+w/2)/w)
	}
	return max(1, (w*longEdge+h/2)/h), longEdge
}

// encodeVariant writes img as JPEG (opaque) or PNG and returns the size.
func encodeVariant(path string, img image.Image, opaque bool) (int64, error) {
	f, err := os.Create(path)
	if err != nil {
		return 0, err
	}
	if opaque {
		err = jpeg.Encode(f, img, &jpeg.Options{Quality: variantJPEGQuality})
	} else {
		err = png.Encode(f, img)
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return 0, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}

// isOpaque reports whether every pixel of img is fully opaque.
func isOpaque(img image.Image) bool {
	if o, ok := img.(interface{ Opaque() bool }); ok {
		return o.Opaque()
	}
	b := img.Bounds()
	for y := b.Min.Y; y < b.Max.Y; y++ {
		for x := b.Min.X; x < b.Max.X; x++ {
			if _, _, _, a := img.At(x, y).RGBA(); a != 0xffff {
				return false
			}
		}
	}
	return true
}

// applyOrientation returns img transformed per an EXIF orientation value
// (1 = as stored; 2-8 flip and/or rotate), so it displays upright without
// the tag.
func applyOrientation(img *image.RGBA, orientation int) image.Image {
	if orientation < 2 || orientation > 8 {
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	dw, dh := w, h
	if orientation >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			var dx, dy int
			switch orientation {
			case 2: // mirrored horizontally
				dx, dy = w-1-x, y
			case 3: // rotated 180
				dx, dy = w-1-x, h-1-y
			case 4: // mirrored vertically
				dx, dy = x, h-1-y
			case 5: // transposed
				dx, dy = y, x
			case 6: // needs 90 clockwise
				dx, dy = h-1-y, x
			case 7: // transversed
				dx, dy = h-1-y, w-1-x
			case 8: // needs 90 counter-clockwise
				dx, dy = y, w-1-x
			}
			dst.SetRGBA(dx, dy, img.RGBAAt(b.Min.X+x, b.Min.Y+y))
		}
	}
	return dst
}

// removeMediaVariants deletes the variant directory of the original at
// mediaPath, with the same upload-directory check as removeMediaFile.
func removeMediaVariants(uploadPath, mediaPath string) error {
	target, err := resolveInUploadDir(uploadPath, mediaPath)
	if err != nil {
		return err
	}
	return os.RemoveAll(variantDirFor(target))
}

// noVariantsReason reports whether err from stageImageVariants is an
// expected reason to skip variants (logged at info, not as a failure).
func noVariantsReason(err error) bool {
	return errors.Is(err, errImageTooLargeToResize) || errors.Is(err, errAnimatedImage)
}

// prepareStoredImage runs the image pipeline on a file just written under
// UploadPath: strips the original's metadata (EXIF, GPS, XMP, text chunks)
// and stages its variants. Both are best effort, so a failure is logged and
// the upload goes on. It returns the stored file's size afterwards
// (fallbackSize if it can't be read) and the staged variants (nil-safe).
func prepareStoredImage(log *slog.Logger, uploadPath, storedPath, mimeType string, fallbackSize int64) (int64, *stagedVariants) {
	size := fallbackSize
	if _, err := resolveInUploadDir(uploadPath, storedPath); err != nil {
		return size, nil
	}
	if !strings.HasPrefix(mimeType, "image/") {
		// Still staged, so a replace that changes nothing image-wise clears
		// stale variants on commit.
		staged, _ := stageImageVariants(uploadPath, storedPath)
		return size, staged
	}
	defer acquireImagePipeline()()

	if err := stripImageMetadataFile(storedPath, mimeType); err != nil {
		log.Warn("media: stripping image metadata failed; original kept as uploaded", "media_path", storedPath, "error", err)
	}
	if info, err := os.Stat(storedPath); err == nil {
		size = info.Size()
	}
	staged, err := stageImageVariants(uploadPath, storedPath)
	switch {
	case err == nil:
	case noVariantsReason(err):
		log.Info("media: no variants generated", "media_path", storedPath, "reason", err.Error())
	default:
		log.Warn("media: generating variants failed", "media_path", storedPath, "error", err)
	}
	return size, staged
}

// VariantBackfillStats summarizes a BackfillMediaVariants run.
type VariantBackfillStats struct {
	Scanned   int
	Generated int
	Skipped   int
	Failed    int
}

// BackfillMediaVariants generates variants for image media stored before
// #255 (and seeded media). Without all it only visits rows that have none
// and are large enough to get some (the query filters the rest), so a
// repeated run is one query. With all it regenerates every image's variants,
// e.g. after the sizes change. Rows whose files lie outside uploadPath are
// skipped. Originals are not rewritten (their metadata is only stripped on
// upload and replace).
//
// Each row's files and variants column are written in SetMediaVariantsTx,
// with the row locked and only if it still describes the file the variants
// came from, so a replace running in the API at the same time always wins.
func BackfillMediaVariants(ctx context.Context, store db.Store, uploadPath string, all bool, log *slog.Logger) (VariantBackfillStats, error) {
	var stats VariantBackfillStats
	var after int64
	for {
		page, err := store.ListImageMediaAfter(ctx, db.ListImageMediaAfterParams{
			AfterID:     after,
			OnlyMissing: !all,
			MinLongEdge: int32(smallestVariantEdge()),
			PageSize:    100,
		})
		if err != nil {
			return stats, err
		}
		if len(page) == 0 {
			return stats, nil
		}
		for _, media := range page {
			after = media.ID
			stats.Scanned++
			if err := ctx.Err(); err != nil {
				return stats, err
			}
			if err := backfillOne(ctx, store, uploadPath, media, &stats); err != nil {
				log.Warn("media variant backfill: skipped", "media_id", media.ID, "error", err)
				stats.Failed++
			}
		}
	}
}

// backfillOne generates and stores one row's variants. It returns an error
// for a row it couldn't process (counted as failed); skips and successes
// update stats directly.
func backfillOne(ctx context.Context, store db.Store, uploadPath string, media db.Medium, stats *VariantBackfillStats) error {
	release := acquireImagePipeline()
	staged, err := stageImageVariants(uploadPath, media.MediaPath)
	release()
	if staged == nil {
		stats.Skipped++
		return nil
	}
	if err != nil && !noVariantsReason(err) {
		staged.discard()
		return err
	}

	column := staged.column()
	raw := json.RawMessage(`{}`)
	if column.Valid {
		raw = column.RawMessage
	}
	_, err = store.SetMediaVariantsTx(ctx, db.SetMediaVariantsTxParams{
		ID:          media.ID,
		MediaPath:   media.MediaPath,
		ChangedAt:   media.ChangedAt,
		Variants:    raw,
		CommitFiles: staged.commit,
	})
	switch {
	case errors.Is(err, db.ErrMediaChanged), errors.Is(err, sql.ErrNoRows):
		// Replaced, edited or deleted meanwhile: whatever happened is newer.
		staged.discard()
		stats.Skipped++
		return nil
	case err != nil:
		staged.discard()
		return fmt.Errorf("saving variants: %w", err)
	}
	if column.Valid {
		stats.Generated++
	} else {
		stats.Skipped++
	}
	return nil
}
