package api

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// The dev seed stores devModeUtil/sampleimages/*.jpg as media (#201). They
// must pass the same content checks as a real upload, so a seeded row is
// indistinguishable from an uploaded one (replace, for example, keeps the type).
func TestSeedSampleImagesPassUploadValidation(t *testing.T) {
	paths, err := filepath.Glob(filepath.Join("..", "devModeUtil", "sampleimages", "*.jpg"))
	require.NoError(t, err)
	require.Len(t, paths, 12)

	for _, path := range paths {
		content, err := os.ReadFile(path)
		require.NoError(t, err)

		request := fileUploadRequest(t, "/", filepath.Base(path), content)
		require.NoError(t, request.ParseMultipartForm(1<<20))
		file, header, err := request.FormFile("file")
		require.NoError(t, err)

		mime, err := validateMediaUpload(file, header, 10<<20)
		file.Close()
		require.NoError(t, err, path)
		require.Equal(t, "image/jpeg", mime, path)
	}
}
