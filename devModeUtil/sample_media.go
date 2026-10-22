package devModeUtil

import (
	"bytes"
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
// rows from older seeds use the same names, so EnsureSampleMediaFiles can
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

// writeSampleImage writes the n-th sample image into uploadPath unless a file
// with its name is already there, and returns the file's path.
func writeSampleImage(uploadPath string, n int) (string, error) {
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
	target := filepath.Join(uploadPath, sampleImageName(n))
	f, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if errors.Is(err, fs.ErrExist) {
		return target, nil
	}
	if err != nil {
		return "", err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(target)
		return "", err
	}
	if err := f.Close(); err != nil {
		os.Remove(target)
		return "", err
	}
	return target, nil
}

// EnsureSampleMediaFiles writes any sample image missing from uploadPath and
// returns how many it wrote. Seeded media rows point at these files; before
// #201 they were downloaded at seed time and often never stored where
// /uploads serves from, so rerunning the seed on an existing database fixes
// its broken images. Existing files are left alone.
func EnsureSampleMediaFiles(uploadPath string) (int, error) {
	written := 0
	for n := 1; n <= sampleImageCount; n++ {
		target := filepath.Join(uploadPath, sampleImageName(n))
		if _, err := os.Stat(target); err == nil {
			continue
		}
		if _, err := writeSampleImage(uploadPath, n); err != nil {
			return written, fmt.Errorf("write %s: %w", sampleImageName(n), err)
		}
		written++
	}
	if written > 0 {
		log.Printf("✅ Restored %d missing sample media files in %s", written, uploadPath)
	}
	return written, nil
}
