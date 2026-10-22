package api

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"hash/crc32"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"

	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
)

var discardLog = slog.New(slog.NewTextHandler(io.Discard, nil))

// writeUpload stores content as name in a fresh upload directory and
// returns (uploadPath, mediaPath).
func writeUpload(t *testing.T, name string, content []byte) (string, string) {
	t.Helper()
	uploadPath := filepath.Join(t.TempDir(), "uploads")
	require.NoError(t, os.MkdirAll(uploadPath, 0755))
	mediaPath := filepath.Join(uploadPath, name)
	require.NoError(t, os.WriteFile(mediaPath, content, 0644))
	return uploadPath, mediaPath
}

// decodedSize returns the dimensions of the image file at path.
func decodedSize(t *testing.T, path string) (int, int, string) {
	t.Helper()
	f, err := os.Open(path)
	require.NoError(t, err)
	defer f.Close()
	cfg, format, err := image.DecodeConfig(f)
	require.NoError(t, err)
	return cfg.Width, cfg.Height, format
}

func variantFile(mediaPath, file string) string {
	return filepath.Join(filepath.Dir(mediaPath), variantsDirName, filepath.Base(mediaPath), file)
}

func TestScaledSize(t *testing.T) {
	cases := []struct{ w, h, edge, wantW, wantH int }{
		{2000, 1000, 1600, 1600, 800},
		{1000, 2000, 800, 400, 800},
		{1000, 1000, 320, 320, 320},
		{3000, 7, 320, 320, 1}, // never 0
	}
	for _, c := range cases {
		w, h := scaledSize(c.w, c.h, c.edge)
		require.Equal(t, c.wantW, w, "%v", c)
		require.Equal(t, c.wantH, h, "%v", c)
	}
}

// The core case: every size below the original, aspect ratio kept, paths in
// media_path's form, and nothing in place until commit.
func TestStageImageVariantsDimensions(t *testing.T) {
	uploadPath, mediaPath := writeUpload(t, "hero.jpg", testJPEG(t, 2000, 1000))

	staged, err := stageImageVariants(uploadPath, mediaPath)
	require.NoError(t, err)
	require.NotNil(t, staged)

	want := map[string][2]int32{"large": {1600, 800}, "medium": {800, 400}, "thumb": {320, 160}}
	require.Len(t, staged.variants, 3)
	for name, size := range want {
		v := staged.variants[name]
		require.Equal(t, size[0], v.Width, name)
		require.Equal(t, size[1], v.Height, name)
		require.Equal(t, "image/jpeg", v.MimeType, name)
		require.Equal(t, filepath.Dir(mediaPath)+"/"+variantsDirName+"/hero.jpg/"+name+".jpg", v.Path, name)
		require.Positive(t, v.FileSize, name)
	}
	_, err = os.Stat(variantFile(mediaPath, "thumb.jpg"))
	require.True(t, os.IsNotExist(err), "nothing is in place before commit")

	require.NoError(t, staged.commit())
	for name, size := range want {
		w, h, format := decodedSize(t, variantFile(mediaPath, name+".jpg"))
		require.Equal(t, "jpeg", format)
		require.Equal(t, int(size[0]), w, name)
		require.Equal(t, int(size[1]), h, name)
	}

	// The column round-trips into the response shape.
	column := staged.column()
	require.True(t, column.Valid)
	require.Equal(t, staged.variants, parseMediaVariants(column.RawMessage))

	entries, err := os.ReadDir(filepath.Join(uploadPath, variantsDirName))
	require.NoError(t, err)
	require.Len(t, entries, 1, "no staging directory left behind")
}

func TestStageImageVariantsNeverUpscales(t *testing.T) {
	t.Run("OnlySmallerSizes", func(t *testing.T) {
		uploadPath, mediaPath := writeUpload(t, "mid.png", testPNG(t, 500, 300))
		staged, err := stageImageVariants(uploadPath, mediaPath)
		require.NoError(t, err)
		require.Len(t, staged.variants, 1)
		thumb := staged.variants["thumb"]
		require.Equal(t, int32(320), thumb.Width)
		require.Equal(t, int32(192), thumb.Height)
		require.NoError(t, staged.commit())
	})

	t.Run("SmallerThanThumbGetsNone", func(t *testing.T) {
		uploadPath, mediaPath := writeUpload(t, "tiny.png", testPNG(t, 320, 100))
		staged, err := stageImageVariants(uploadPath, mediaPath)
		require.NoError(t, err)
		require.NotNil(t, staged)
		require.Empty(t, staged.variants)
		require.False(t, staged.column().Valid, "stored as {}")
		require.NoError(t, staged.commit())
		_, err = os.Stat(filepath.Join(uploadPath, variantsDirName))
		require.True(t, os.IsNotExist(err), "no _variants directory for an image without variants")
	})
}

func TestStageImageVariantsTransparencyKeepsPNG(t *testing.T) {
	img := image.NewNRGBA(image.Rect(0, 0, 640, 480))
	img.Set(10, 10, color.NRGBA{R: 255, A: 128})
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	uploadPath, mediaPath := writeUpload(t, "logo.png", buf.Bytes())

	staged, err := stageImageVariants(uploadPath, mediaPath)
	require.NoError(t, err)
	require.NoError(t, staged.commit())
	thumb := staged.variants["thumb"]
	require.Equal(t, "image/png", thumb.MimeType)
	_, _, format := decodedSize(t, variantFile(mediaPath, "thumb.png"))
	require.Equal(t, "png", format)
}

func TestStageImageVariantsSkips(t *testing.T) {
	t.Run("AnimatedGIF", func(t *testing.T) {
		frame := func() *image.Paletted {
			return image.NewPaletted(image.Rect(0, 0, 400, 400), color.Palette{color.Black, color.White})
		}
		var buf bytes.Buffer
		require.NoError(t, gif.EncodeAll(&buf, &gif.GIF{Image: []*image.Paletted{frame(), frame()}, Delay: []int{10, 10}}))
		uploadPath, mediaPath := writeUpload(t, "anim.gif", buf.Bytes())

		staged, err := stageImageVariants(uploadPath, mediaPath)
		require.ErrorIs(t, err, errAnimatedImage)
		require.True(t, noVariantsReason(err))
		require.NotNil(t, staged)
		require.Empty(t, staged.variants)
	})

	t.Run("TooManyPixels", func(t *testing.T) {
		// Only the header is read before refusing, so a header is enough.
		uploadPath, mediaPath := writeUpload(t, "huge.png", pngHeaderOnly(10000, 10000))
		staged, err := stageImageVariants(uploadPath, mediaPath)
		require.ErrorIs(t, err, errImageTooLargeToResize)
		require.NotNil(t, staged)
	})

	t.Run("NotAnImage", func(t *testing.T) {
		uploadPath, mediaPath := writeUpload(t, "notes.txt", []byte("hello"))
		staged, err := stageImageVariants(uploadPath, mediaPath)
		require.NoError(t, err)
		require.Empty(t, staged.variants)
	})

	t.Run("OutsideUploadDir", func(t *testing.T) {
		uploadPath := t.TempDir()
		outside := filepath.Join(t.TempDir(), "elsewhere.jpg")
		require.NoError(t, os.WriteFile(outside, testJPEG(t, 1000, 1000), 0644))
		staged, err := stageImageVariants(uploadPath, outside)
		require.NoError(t, err)
		require.Nil(t, staged, "files the API doesn't manage get no variants")
		require.NoError(t, staged.commit(), "nil is a no-op")
		staged.discard()
	})
}

// pngHeaderOnly is a PNG signature plus a valid IHDR for w×h, enough for
// image.DecodeConfig.
func pngHeaderOnly(w, h uint32) []byte {
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], w)
	binary.BigEndian.PutUint32(ihdr[4:], h)
	ihdr[8], ihdr[9] = 8, 2 // 8-bit RGB
	chunk := append([]byte("IHDR"), ihdr...)
	out := append([]byte{}, pngSignature...)
	out = binary.BigEndian.AppendUint32(out, 13)
	out = append(out, chunk...)
	out = binary.BigEndian.AppendUint32(out, crc32.ChecksumIEEE(chunk))
	return out
}

// jpegWithEXIF inserts an APP1 EXIF segment with the given orientation and
// a fake GPS marker string after the SOI of a JPEG.
func jpegWithEXIF(t *testing.T, jpg []byte, orientation int) []byte {
	t.Helper()
	tiff := []byte{'I', 'I', 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, // little-endian, IFD0 at 8
		0x01, 0x00, // one entry
		0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, byte(orientation), 0x00, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00,
	}
	tiff = append(tiff, []byte("GPS 52.3676N 4.9041E secret-serial-123")...)
	payload := append([]byte("Exif\x00\x00"), tiff...)
	seg := []byte{0xFF, 0xE1}
	seg = binary.BigEndian.AppendUint16(seg, uint16(len(payload)+2))
	seg = append(seg, payload...)

	out := append([]byte{}, jpg[:2]...)
	out = append(out, seg...)
	out = append(out, []byte{0xFF, 0xFE, 0x00, 0x0A, 'c', 'o', 'm', 'm', 'e', 'n', 't', '!'}...) // COM
	return append(out, jpg[2:]...)
}

func TestVariantsHaveNoMetadataAndAreUpright(t *testing.T) {
	// Stored 1000×500 with orientation 6 (rotate 90° clockwise to display):
	// displayed 500×1000, so medium is 400×800 and the thumb 160×320.
	jpg := jpegWithEXIF(t, testJPEG(t, 1000, 500), 6)
	require.Equal(t, 6, jpegOrientation(jpg))
	uploadPath, mediaPath := writeUpload(t, "phone.jpg", jpg)

	staged, err := stageImageVariants(uploadPath, mediaPath)
	require.NoError(t, err)
	require.NoError(t, staged.commit())

	medium := staged.variants["medium"]
	require.Equal(t, int32(400), medium.Width)
	require.Equal(t, int32(800), medium.Height)
	thumb := staged.variants["thumb"]
	require.Equal(t, int32(160), thumb.Width)
	require.Equal(t, int32(320), thumb.Height)

	for _, file := range []string{"thumb.jpg", "medium.jpg"} {
		data, err := os.ReadFile(variantFile(mediaPath, file))
		require.NoError(t, err)
		require.NotContains(t, string(data), "Exif", file)
		require.NotContains(t, string(data), "GPS", file)
		require.NotContains(t, string(data), "secret-serial", file)
		require.Equal(t, 1, jpegOrientation(data), file)
	}
}

func TestApplyOrientation(t *testing.T) {
	// A 2×1 image, red then blue, through each orientation.
	src := image.NewRGBA(image.Rect(0, 0, 2, 1))
	red, blue := color.RGBA{R: 255, A: 255}, color.RGBA{B: 255, A: 255}
	src.SetRGBA(0, 0, red)
	src.SetRGBA(1, 0, blue)

	at := func(img image.Image, x, y int) color.RGBA {
		return img.(*image.RGBA).RGBAAt(x, y)
	}
	require.Same(t, src, applyOrientation(src, 1).(*image.RGBA))
	require.Equal(t, blue, at(applyOrientation(src, 2), 0, 0)) // mirrored
	require.Equal(t, blue, at(applyOrientation(src, 3), 0, 0)) // 180
	rot := applyOrientation(src, 6)                            // 90 clockwise: 1×2, red on top
	require.Equal(t, image.Rect(0, 0, 1, 2), rot.Bounds())
	require.Equal(t, red, at(rot, 0, 0))
	require.Equal(t, blue, at(rot, 0, 1))
	rot = applyOrientation(src, 8) // 90 counter-clockwise: blue on top
	require.Equal(t, blue, at(rot, 0, 0))
	require.Equal(t, red, at(rot, 0, 1))
}

func TestStripJPEGMetadata(t *testing.T) {
	t.Run("KeepsOnlyOrientation", func(t *testing.T) {
		jpg := jpegWithEXIF(t, testJPEG(t, 40, 20), 6)
		clean, err := stripJPEGMetadata(jpg)
		require.NoError(t, err)
		require.NotContains(t, string(clean), "GPS")
		require.NotContains(t, string(clean), "secret-serial")
		require.NotContains(t, string(clean), "comment!")
		require.Equal(t, 6, jpegOrientation(clean), "orientation survives so the original still displays upright")
		_, err = jpeg.Decode(bytes.NewReader(clean))
		require.NoError(t, err)
	})

	t.Run("UprightDropsEXIFEntirely", func(t *testing.T) {
		clean, err := stripJPEGMetadata(jpegWithEXIF(t, testJPEG(t, 40, 20), 1))
		require.NoError(t, err)
		require.NotContains(t, string(clean), "Exif")
		_, err = jpeg.Decode(bytes.NewReader(clean))
		require.NoError(t, err)
	})

	t.Run("NoMetadataUnchanged", func(t *testing.T) {
		jpg := testJPEG(t, 40, 20)
		clean, err := stripJPEGMetadata(jpg)
		require.NoError(t, err)
		require.Equal(t, jpg, clean)
	})

	t.Run("Malformed", func(t *testing.T) {
		_, err := stripJPEGMetadata([]byte{0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF})
		require.ErrorIs(t, err, errMalformedImage)
	})
}

func TestStripPNGMetadata(t *testing.T) {
	plain := testPNG(t, 4, 4)
	// Insert a tEXt chunk right after IHDR (signature 8 + IHDR 25 bytes).
	text := append([]byte("tEXt"), []byte("GPS\x0052.3676N 4.9041E")...)
	chunk := binary.BigEndian.AppendUint32(nil, uint32(len(text)-4))
	chunk = append(chunk, text...)
	chunk = binary.BigEndian.AppendUint32(chunk, crc32.ChecksumIEEE(text))
	withText := append(append(append([]byte{}, plain[:33]...), chunk...), plain[33:]...)
	_, err := png.Decode(bytes.NewReader(withText))
	require.NoError(t, err, "fixture is a valid PNG")

	clean, err := stripPNGMetadata(withText)
	require.NoError(t, err)
	require.Equal(t, plain, clean)
}

func TestStripWebPMetadata(t *testing.T) {
	chunk := func(kind string, payload []byte) []byte {
		out := append([]byte(kind), binary.LittleEndian.AppendUint32(nil, uint32(len(payload)))...)
		out = append(out, payload...)
		if len(payload)%2 == 1 {
			out = append(out, 0)
		}
		return out
	}
	vp8x := make([]byte, 10)
	vp8x[0] = webpFlagEXIF | webpFlagXMP | 0x10 // + alpha
	body := append([]byte("WEBP"), chunk("VP8X", vp8x)...)
	body = append(body, chunk("VP8L", []byte{1, 2, 3})...)
	body = append(body, chunk("EXIF", []byte("GPS secret"))...)
	body = append(body, chunk("XMP ", []byte("<xmp/>"))...)
	riff := append([]byte("RIFF"), binary.LittleEndian.AppendUint32(nil, uint32(len(body)))...)
	riff = append(riff, body...)

	clean, err := stripWebPMetadata(riff)
	require.NoError(t, err)
	require.NotContains(t, string(clean), "EXIF")
	require.NotContains(t, string(clean), "GPS")
	require.NotContains(t, string(clean), "xmp")
	require.Equal(t, byte(0x10), clean[20], "metadata flags cleared, alpha kept")
	require.Equal(t, uint32(len(clean)-8), binary.LittleEndian.Uint32(clean[4:]))
	require.Contains(t, string(clean), "VP8L")
}

func TestStripImageMetadataFile(t *testing.T) {
	_, path := writeUpload(t, "a.jpg", jpegWithEXIF(t, testJPEG(t, 40, 20), 1))
	require.NoError(t, stripImageMetadataFile(path, "image/jpeg"))
	data, err := os.ReadFile(path)
	require.NoError(t, err)
	require.NotContains(t, string(data), "GPS")

	// Unhandled types are left alone.
	_, gifPath := writeUpload(t, "a.gif", []byte("GIF89a..."))
	require.NoError(t, stripImageMetadataFile(gifPath, "image/gif"))

	// A broken file is reported and left untouched.
	broken := []byte{0xFF, 0xD8, 0xFF, 0xE1, 0xFF, 0xFF}
	_, brokenPath := writeUpload(t, "b.jpg", broken)
	require.Error(t, stripImageMetadataFile(brokenPath, "image/jpeg"))
	data, err = os.ReadFile(brokenPath)
	require.NoError(t, err)
	require.Equal(t, broken, data)
}

func TestPrepareStoredImageStripsOriginal(t *testing.T) {
	jpg := jpegWithEXIF(t, testJPEG(t, 1000, 500), 1)
	uploadPath, mediaPath := writeUpload(t, "trip.jpg", jpg)

	size, staged := prepareStoredImage(discardLog, uploadPath, mediaPath, "image/jpeg", int64(len(jpg)))
	stored, err := os.ReadFile(mediaPath)
	require.NoError(t, err)
	require.NotContains(t, string(stored), "GPS", "the original is stripped too")
	require.Equal(t, int64(len(stored)), size, "size is the stored file's, after stripping")
	require.Less(t, size, int64(len(jpg)))
	require.Len(t, staged.variants, 2) // medium + thumb
}

func TestStagedVariantsCommitReplacesAndDiscardKeeps(t *testing.T) {
	uploadPath, mediaPath := writeUpload(t, "hero.jpg", testJPEG(t, 2000, 1000))
	first, err := stageImageVariants(uploadPath, mediaPath)
	require.NoError(t, err)
	require.NoError(t, first.commit())

	// A smaller replacement: discarding it keeps the old set...
	require.NoError(t, os.WriteFile(mediaPath, testJPEG(t, 600, 300), 0644))
	second, err := stageImageVariants(uploadPath, mediaPath)
	require.NoError(t, err)
	second.discard()
	_, err = os.Stat(variantFile(mediaPath, "large.jpg"))
	require.NoError(t, err)

	// ...committing it removes the sizes the new file doesn't have.
	third, err := stageImageVariants(uploadPath, mediaPath)
	require.NoError(t, err)
	require.NoError(t, third.commit())
	_, err = os.Stat(variantFile(mediaPath, "large.jpg"))
	require.True(t, os.IsNotExist(err))
	w, _, _ := decodedSize(t, variantFile(mediaPath, "thumb.jpg"))
	require.Equal(t, 320, w)

	entries, err := os.ReadDir(filepath.Join(uploadPath, variantsDirName))
	require.NoError(t, err)
	require.Len(t, entries, 1, "staging directories are gone")
}

func TestRemoveMediaVariants(t *testing.T) {
	uploadPath, mediaPath := writeUpload(t, "hero.jpg", testJPEG(t, 1000, 500))
	staged, err := stageImageVariants(uploadPath, mediaPath)
	require.NoError(t, err)
	require.NoError(t, staged.commit())

	require.NoError(t, removeMediaVariants(uploadPath, mediaPath))
	_, err = os.Stat(variantDirFor(mediaPath))
	require.True(t, os.IsNotExist(err))
	require.NoError(t, removeMediaVariants(uploadPath, mediaPath), "already gone is fine")

	require.ErrorIs(t, removeMediaVariants(uploadPath, filepath.Join(t.TempDir(), "x.jpg")), errOutsideUploadDir)
}

func TestVariantMediaPath(t *testing.T) {
	require.Equal(t, "./uploads/_variants/a.jpg/thumb.jpg", variantMediaPath("./uploads/a.jpg", "thumb.jpg"))
	require.Equal(t, "/app/uploads/media/_variants/a.jpg/thumb.jpg", variantMediaPath("/app/uploads/media/a.jpg", "thumb.jpg"))
}

func TestParseMediaVariants(t *testing.T) {
	require.Nil(t, parseMediaVariants(nil))
	require.Nil(t, parseMediaVariants(json.RawMessage(`{}`)))
	require.Nil(t, parseMediaVariants(json.RawMessage(`"garbage"`)))
	got := parseMediaVariants(json.RawMessage(`{"thumb":{"path":"p","width":1,"height":2,"mime_type":"image/jpeg","file_size":3}}`))
	require.Equal(t, MediaVariant{Path: "p", Width: 1, Height: 2, MimeType: "image/jpeg", FileSize: 3}, got["thumb"])
}

func TestBackfillMediaVariants(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)

	uploadPath, bigPath := writeUpload(t, "big.jpg", testJPEG(t, 1200, 600))
	racedPath := filepath.Join(uploadPath, "raced.jpg")
	require.NoError(t, os.WriteFile(racedPath, testJPEG(t, 900, 600), 0644))
	changedAt := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)

	rows := []db.Medium{
		{ID: 1, MediaPath: bigPath, MimeType: "image/jpeg", Width: 1200, Height: 600, ChangedAt: changedAt, Variants: json.RawMessage(`{}`)},
		{ID: 3, MediaPath: "/somewhere/else.jpg", MimeType: "image/jpeg", Variants: json.RawMessage(`{}`)},
		{ID: 5, MediaPath: filepath.Join(uploadPath, "missing.jpg"), MimeType: "image/jpeg", Variants: json.RawMessage(`{}`)},
		{ID: 6, MediaPath: racedPath, MimeType: "image/jpeg", ChangedAt: changedAt, Variants: json.RawMessage(`{}`)},
	}
	// Small images and rows with variants are filtered by the query itself
	// (only_missing + min_long_edge), so a repeated run doesn't decode them.
	gomock.InOrder(
		store.EXPECT().ListImageMediaAfter(gomock.Any(), db.ListImageMediaAfterParams{AfterID: 0, OnlyMissing: true, MinLongEdge: 320, PageSize: 100}).Return(rows, nil),
		store.EXPECT().ListImageMediaAfter(gomock.Any(), db.ListImageMediaAfterParams{AfterID: 6, OnlyMissing: true, MinLongEdge: 320, PageSize: 100}).Return(nil, nil),
	)
	store.EXPECT().SetMediaVariantsTx(gomock.Any(), gomock.Any()).Times(2).
		DoAndReturn(func(_ context.Context, arg db.SetMediaVariantsTxParams) (db.Medium, error) {
			require.Equal(t, changedAt, arg.ChangedAt, "the write is conditional on the row read")
			switch arg.ID {
			case 1:
				v := parseMediaVariants(arg.Variants)
				require.Len(t, v, 2)
				require.Equal(t, int32(800), v["medium"].Width)
				require.NoError(t, arg.CommitFiles(), "files move while the row is locked")
				return db.Medium{ID: 1}, nil
			case 6:
				// Replaced in the API meanwhile: nothing may be committed.
				return db.Medium{}, db.ErrMediaChanged
			}
			t.Fatalf("unexpected SetMediaVariantsTx for %d", arg.ID)
			return db.Medium{}, nil
		})

	stats, err := BackfillMediaVariants(context.Background(), store, uploadPath, false, discardLog)
	require.NoError(t, err)
	require.Equal(t, VariantBackfillStats{Scanned: 4, Generated: 1, Skipped: 2, Failed: 1}, stats)
	_, err = os.Stat(variantFile(bigPath, "medium.jpg"))
	require.NoError(t, err)
	_, err = os.Stat(variantDirFor(racedPath))
	require.True(t, os.IsNotExist(err), "a raced row's staged variants are discarded, not committed")
	entries, err := os.ReadDir(filepath.Join(uploadPath, variantsDirName))
	require.NoError(t, err)
	require.Len(t, entries, 1, "no staging directories left behind")
}

func TestBackfillMediaVariantsAll(t *testing.T) {
	ctrl := gomock.NewController(t)
	store := mockdb.NewMockStore(ctrl)
	store.EXPECT().ListImageMediaAfter(gomock.Any(), db.ListImageMediaAfterParams{AfterID: 0, OnlyMissing: false, MinLongEdge: 320, PageSize: 100}).Return(nil, nil)
	stats, err := BackfillMediaVariants(context.Background(), store, t.TempDir(), true, discardLog)
	require.NoError(t, err)
	require.Zero(t, stats.Scanned)
}

// Variant directories and stripped originals must stay readable like any
// other upload (MkdirTemp/CreateTemp would leave them 0700/0600).
func TestPipelineKeepsUploadPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX permissions")
	}
	jpg := jpegWithEXIF(t, testJPEG(t, 1000, 500), 1)
	uploadPath, mediaPath := writeUpload(t, "perm.jpg", jpg)
	require.NoError(t, os.Chmod(mediaPath, 0644))

	_, staged := prepareStoredImage(discardLog, uploadPath, mediaPath, "image/jpeg", int64(len(jpg)))
	require.NoError(t, staged.commit())

	info, err := os.Stat(mediaPath)
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0644), info.Mode().Perm(), "stripped original keeps its mode")
	dir, err := os.Stat(variantDirFor(mediaPath))
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0755), dir.Mode().Perm(), "variant directory is world-readable")

	swap, err := swapInFile(mediaPath, bytes.NewReader(testJPEG(t, 10, 10)))
	require.NoError(t, err)
	require.NoError(t, swap.commit())
	info, err = os.Stat(mediaPath)
	require.NoError(t, err)
	require.Equal(t, os.FileMode(0644), info.Mode().Perm(), "a replaced file is as readable as an upload")
}

func TestIsBlockDocShape(t *testing.T) {
	ok := func(s string) bool {
		var doc map[string]interface{}
		require.NoError(t, json.Unmarshal([]byte(s), &doc))
		return isBlockDocShape(doc)
	}
	require.True(t, ok(`{"doc_version":1,"blocks_order":["a"],"blocks":{"a":{}}}`))
	require.True(t, ok(`{"doc_version":1,"blocks_order":null,"blocks":{}}`), "null/absent fields decode fine into BlockDocV1 too")
	require.True(t, ok(`{}`))
	require.False(t, ok(`{"doc_version":"1"}`))
	require.False(t, ok(`{"blocks_order":[1]}`))
	require.False(t, ok(`{"blocks":[]}`))
	require.False(t, isBlockDocShape(nil))
}

// Variant paths are stored like media_path (filesystem form) and must reach
// clients as /uploads URL paths, the same mapping media_path gets.
func TestPublicVariants(t *testing.T) {
	uploadPath := filepath.Join(t.TempDir(), "uploads", "media")
	stored := MediaVariants{
		"thumb": {Path: filepath.Join(uploadPath, "_variants", "a.jpg", "thumb.jpg"), Width: 320},
		"large": {Path: "/somewhere/else.jpg", Width: 1600},
	}
	got := publicVariants(uploadPath, stored)
	require.Equal(t, "/uploads/media/_variants/a.jpg/thumb.jpg", got["thumb"].Path)
	require.Equal(t, int32(320), got["thumb"].Width)
	require.Equal(t, "/somewhere/else.jpg", got["large"].Path, "paths outside UploadPath pass through")
	require.Equal(t, filepath.Join(uploadPath, "_variants", "a.jpg", "thumb.jpg"), stored["thumb"].Path, "input not mutated")
	require.NotNil(t, publicVariants(uploadPath, nil))
}
