package devModeUtil

import (
	"bytes"
	"context"
	"embed"
	"errors"
	"fmt"
	"image"
	_ "image/jpeg"
	"io/fs"
	"log"
	"os"
	"path"
	"path/filepath"
	"strings"

	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

// sampleImageCount is how many sample images createDummyMedia stores.
const sampleImageCount = 12

// sampleImageFS holds the seed's media files (see sampleimages/README.md for
// their source and license). They are embedded so seeding needs no network
// access and works from any working directory.
//
//go:embed sampleimages/*.jpg
var sampleImageFS embed.FS

// sampleImageName is the file name of the n-th sample image (1-based). Media
// rows from older seeds use the same names, so RestoreSampleMediaFiles can
// restore their files.
func sampleImageName(n int) string {
	return fmt.Sprintf("sample-image-%d.jpg", n)
}

// sampleImage returns the bytes and dimensions of the n-th sample image.
func sampleImage(n int) ([]byte, image.Config, error) {
	data, err := sampleImageFS.ReadFile(path.Join("sampleimages", sampleImageName(n)))
	if err != nil {
		return nil, image.Config{}, err
	}
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, image.Config{}, fmt.Errorf("decode %s: %w", sampleImageName(n), err)
	}
	return data, cfg, nil
}

// sampleMediaPath is the media_path stored for a seeded file. It has the
// same form as a real upload's (saveUploadedFileWithOriginalName in api):
// UPLOAD_PATH, a slash, the file name.
func sampleMediaPath(uploadPath, filename string) string {
	return fmt.Sprintf("%s/%s", uploadPath, filename)
}

// sampleMediaURL is the public URL of a seeded file. The API serves the parent
// of UPLOAD_PATH at /uploads, so ./uploads/media/x.jpg is /uploads/media/x.jpg.
func sampleMediaURL(uploadPath, filename string) string {
	return fmt.Sprintf("/uploads/%s/%s", filepath.Base(uploadPath), filename)
}

// maxSampleNameAttempts bounds the alternative names storeSampleImage tries.
const maxSampleNameAttempts = 100

// storeSampleImage puts the n-th sample image into uploadPath and returns the
// file name it is stored under. It reuses a file that already holds exactly
// this image (an earlier seed's), and never touches a different file with
// the same name (e.g. someone's upload): it moves on to sample-image-N_1.jpg
// and so on instead, like uploads do on a name clash.
func storeSampleImage(uploadPath string, n int) (string, error) {
	data, _, err := sampleImage(n)
	if err != nil {
		return "", err
	}
	// uploadPath is used as given, like real uploads do: joining it onto "."
	// would turn an absolute UPLOAD_PATH (/app/uploads/media in compose) into
	// a relative one, and the files would land where nothing serves them.
	if err := os.MkdirAll(uploadPath, 0755); err != nil {
		return "", err
	}

	base := strings.TrimSuffix(sampleImageName(n), ".jpg")
	for attempt := 0; attempt < maxSampleNameAttempts; attempt++ {
		filename := base + ".jpg"
		if attempt > 0 {
			filename = fmt.Sprintf("%s_%d.jpg", base, attempt)
		}
		target := filepath.Join(uploadPath, filename)

		written, err := writeNewFile(target, data)
		if err != nil {
			return "", err
		}
		if written {
			return filename, nil
		}
		existing, err := os.ReadFile(target)
		if err != nil {
			return "", err
		}
		if bytes.Equal(existing, data) {
			return filename, nil
		}
	}
	return "", fmt.Errorf("no free file name for %s in %s", sampleImageName(n), uploadPath)
}

// writeNewFile creates target with data. It reports false, and writes
// nothing, if target already exists.
func writeNewFile(target string, data []byte) (bool, error) {
	f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if errors.Is(err, fs.ErrExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(target)
		return false, err
	}
	if err := f.Close(); err != nil {
		os.Remove(target)
		return false, err
	}
	return true, nil
}

// RestoreSampleMediaFiles writes back the sample images that a media row
// still references but that are missing from uploadPath, and returns how many
// it wrote. Before #201 the seed downloaded these files and often stored them
// where /uploads doesn't serve from, so cmd/seed runs this to fix the broken
// images of a database seeded by an older version. Files no row references
// (e.g. media deleted in the admin) are not recreated, and existing files are
// never overwritten.
func RestoreSampleMediaFiles(ctx context.Context, store db.Store, uploadPath string) (int, error) {
	byPath := make(map[string]int, sampleImageCount)
	paths := make([]string, 0, sampleImageCount)
	for n := 1; n <= sampleImageCount; n++ {
		p := sampleMediaPath(uploadPath, sampleImageName(n))
		byPath[p] = n
		paths = append(paths, p)
	}

	referenced, err := store.ListMediaPathsIn(ctx, paths)
	if err != nil {
		return 0, fmt.Errorf("look up seeded media rows: %w", err)
	}

	written := 0
	for _, p := range referenced {
		n := byPath[p]
		data, _, err := sampleImage(n)
		if err != nil {
			return written, err
		}
		if err := os.MkdirAll(uploadPath, 0755); err != nil {
			return written, err
		}
		ok, err := writeNewFile(filepath.Join(uploadPath, sampleImageName(n)), data)
		if err != nil {
			return written, fmt.Errorf("write %s: %w", sampleImageName(n), err)
		}
		if ok {
			written++
		}
	}
	if written > 0 {
		log.Printf("✅ Restored %d missing sample media files in %s", written, uploadPath)
	}
	return written, nil
}
