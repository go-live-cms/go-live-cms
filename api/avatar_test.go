package api

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"testing"

	mockdb "github.com/go-live-cms/go-live-cms/db/mock"
	db "github.com/go-live-cms/go-live-cms/db/sqlc"
	"github.com/golang/mock/gomock"
	"github.com/stretchr/testify/require"
)

// Avatars (#334): the pipeline (type and size checks, the square crop around the
// focal point, re-encoding without metadata) and the routes against a mock store
// with a real upload directory.

// halvesImage is w x h, red on the left half and blue on the right, so a crop's
// side can be read from its center pixel.
func halvesImage(w, h int) *image.RGBA {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := color.RGBA{R: 220, A: 255}
			if x >= w/2 {
				c = color.RGBA{B: 220, A: 255}
			}
			img.Set(x, y, c)
		}
	}
	return img
}

func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, png.Encode(&buf, img))
	return buf.Bytes()
}

func encodeJPEG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	require.NoError(t, jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95}))
	return buf.Bytes()
}

func decodeAvatar(t *testing.T, data []byte) (image.Image, string) {
	t.Helper()
	img, format, err := image.Decode(bytes.NewReader(data))
	require.NoError(t, err)
	return img, format
}

func isBlue(c color.Color) bool {
	r, _, b, _ := c.RGBA()
	return b > 0x8000 && r < 0x4000
}

func isRed(c color.Color) bool {
	r, _, b, _ := c.RGBA()
	return r > 0x8000 && b < 0x4000
}

// withEXIF puts an APP1 Exif segment carrying marker right after a JPEG's SOI.
func withEXIF(jpg []byte, marker string) []byte {
	payload := append([]byte("Exif\x00\x00MM\x00\x2a\x00\x00\x00\x08\x00\x00"), []byte(marker)...)
	segment := []byte{0xFF, 0xE1, 0, 0}
	binary.BigEndian.PutUint16(segment[2:], uint16(len(payload)+2))
	out := append([]byte{}, jpg[:2]...)
	out = append(out, segment...)
	out = append(out, payload...)
	return append(out, jpg[2:]...)
}

func TestRenderAvatar(t *testing.T) {
	t.Run("crops a square, scales it to avatarEdge, JPEG when opaque", func(t *testing.T) {
		out, ext, err := renderAvatar(encodePNG(t, halvesImage(900, 600)), nil)
		require.NoError(t, err)
		require.Equal(t, ".jpg", ext)
		img, format := decodeAvatar(t, out)
		require.Equal(t, "jpeg", format)
		require.Equal(t, image.Rect(0, 0, avatarEdge, avatarEdge), img.Bounds())
	})

	t.Run("never upscales", func(t *testing.T) {
		out, _, err := renderAvatar(encodePNG(t, halvesImage(120, 80)), nil)
		require.NoError(t, err)
		img, _ := decodeAvatar(t, out)
		require.Equal(t, image.Rect(0, 0, 80, 80), img.Bounds())
	})

	t.Run("centers the square on the focal point", func(t *testing.T) {
		src := encodePNG(t, halvesImage(800, 200))
		right, _, err := renderAvatar(src, &FocalPoint{X: 1, Y: 0.5})
		require.NoError(t, err)
		img, _ := decodeAvatar(t, right)
		require.True(t, isBlue(img.At(100, 100)), "focal x=1 keeps the right (blue) side")

		left, _, err := renderAvatar(src, &FocalPoint{X: 0, Y: 0.5})
		require.NoError(t, err)
		img, _ = decodeAvatar(t, left)
		require.True(t, isRed(img.At(100, 100)), "focal x=0 keeps the left (red) side")
	})

	t.Run("keeps transparency as PNG", func(t *testing.T) {
		img := image.NewNRGBA(image.Rect(0, 0, 50, 50))
		img.Set(10, 10, color.NRGBA{G: 200, A: 128})
		out, ext, err := renderAvatar(encodePNG(t, img), nil)
		require.NoError(t, err)
		require.Equal(t, ".png", ext)
		_, format := decodeAvatar(t, out)
		require.Equal(t, "png", format)
	})

	t.Run("drops the original's metadata", func(t *testing.T) {
		src := withEXIF(encodeJPEG(t, halvesImage(300, 300)), "GPS-SECRET-48.85N")
		require.Contains(t, string(src), "GPS-SECRET")
		out, _, err := renderAvatar(src, nil)
		require.NoError(t, err)
		require.NotContains(t, string(out), "GPS-SECRET")
		require.NotContains(t, string(out), "Exif")
	})

	t.Run("a GIF gives its first frame", func(t *testing.T) {
		pal := color.Palette{color.RGBA{R: 255, A: 255}, color.RGBA{B: 255, A: 255}}
		frame := func(i uint8) *image.Paletted {
			f := image.NewPaletted(image.Rect(0, 0, 40, 40), pal)
			for p := range f.Pix {
				f.Pix[p] = i
			}
			return f
		}
		var buf bytes.Buffer
		require.NoError(t, gif.EncodeAll(&buf, &gif.GIF{Image: []*image.Paletted{frame(0), frame(1)}, Delay: []int{10, 10}}))
		out, _, err := renderAvatar(buf.Bytes(), nil)
		require.NoError(t, err)
		img, _ := decodeAvatar(t, out)
		require.True(t, isRed(img.At(20, 20)))
	})

	refused := map[string]struct {
		data []byte
		err  error
	}{
		"text":                  {[]byte("just some text, not a picture"), errAvatarType},
		"SVG":                   {[]byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`), errAvatarType},
		"HTML":                  {[]byte("<!doctype html><html><body>hi</body></html>"), errAvatarType},
		"PDF":                   {[]byte("%PDF-1.7\n%âãÏÓ\n"), errAvatarType},
		"truncated PNG":         {encodePNG(t, halvesImage(64, 64))[:60], errAvatarUnreadable},
		"PNG header only":       {pngHeaderOnly(64, 64), errAvatarUnreadable},
		"too many pixels":       {pngHeaderOnly(10_000, 10_000), errAvatarTooLarge},
		"zero-sized":            {pngHeaderOnly(0, 10), errAvatarUnreadable},
		"JPEG magic, junk body": {append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, bytes.Repeat([]byte{0x42}, 64)...), errAvatarUnreadable},
	}
	for name, tc := range refused {
		t.Run("refuses "+name, func(t *testing.T) {
			_, _, err := renderAvatar(tc.data, nil)
			require.ErrorIs(t, err, tc.err)
		})
	}
}

func TestAvatarFilePath(t *testing.T) {
	upload := filepath.Join(t.TempDir(), "uploads", "media")
	name := "avatar-0123456789abcdef0123456789abcdef.jpg"
	ours := publicMediaPath(upload, filepath.Join(upload, avatarDirName, name))
	require.Equal(t, "/uploads/media/_avatars/"+name, ours)
	require.Equal(t, filepath.Join(upload, avatarDirName, name), avatarFilePath(upload, ours))

	for _, url := range []string{
		"",
		"/uploads/media/" + name,                 // not in _avatars
		"/uploads/media/_avatars/hero-photo.jpg", // not our name
		"/uploads/media/_avatars/avatar-0123.jpg",      // too short
		"/uploads/other/_avatars/" + name,              // another prefix
		"/uploads/media/_avatars/../" + name,           // traversal
		"https://evil.example/_avatars/" + name,        // absolute URL
		"/uploads/media/_avatars/" + name + "/../../x", // traversal after the name
	} {
		require.Empty(t, avatarFilePath(upload, url), url)
	}
}

// avatarUploadRequest is a PUT /users/me/avatar with file (and focal fields).
func avatarUploadRequest(t *testing.T, content []byte, fields map[string]string) *http.Request {
	t.Helper()
	body := &bytes.Buffer{}
	writer := multipart.NewWriter(body)
	for k, v := range fields {
		require.NoError(t, writer.WriteField(k, v))
	}
	if content != nil {
		part, err := writer.CreateFormFile("file", "me.png")
		require.NoError(t, err)
		_, err = part.Write(content)
		require.NoError(t, err)
	}
	require.NoError(t, writer.Close())
	request := httptest.NewRequest(http.MethodPut, "/api/v1/users/me/avatar", body)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	return request
}

var avatarURLPattern = regexp.MustCompile(`^/uploads/media/_avatars/avatar-[0-9a-f]{32}\.(jpg|png)$`)

func TestAvatarRoutes(t *testing.T) {
	user := db.User{ID: 7301, Username: "ana", FullName: "Ana Costa", Email: "ana@example.test", Role: RoleContributor}

	serve := func(server *Server, request *http.Request) (*httptest.ResponseRecorder, PrivateUserResponse) {
		recorder := httptest.NewRecorder()
		server.router.ServeHTTP(recorder, request)
		var body struct {
			User PrivateUserResponse `json:"user"`
		}
		_ = json.Unmarshal(recorder.Body.Bytes(), &body)
		return recorder, body.User
	}

	t.Run("upload, replace, serve and remove", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		server := newTestServer(t, store)

		var stored string
		store.EXPECT().SetUserAvatar(gomock.Any(), gomock.Any()).Times(3).
			DoAndReturn(func(_ any, arg db.SetUserAvatarParams) (string, error) {
				require.Equal(t, user.ID, arg.UserID)
				previous := stored
				stored = arg.AvatarUrl
				return previous, nil
			})

		request := avatarUploadRequest(t, encodePNG(t, halvesImage(600, 400)), map[string]string{"focal_x": "0.9", "focal_y": "0.5"})
		signInAs(t, server, store, request, user)
		recorder, got := serve(server, request)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.NotNil(t, got.Avatar)
		first := *got.Avatar
		require.Regexp(t, avatarURLPattern, first)
		require.FileExists(t, avatarFilePath(server.config.UploadPath, first))

		// /uploads serves it, so bylines and presence can use the URL as is.
		served := httptest.NewRecorder()
		server.router.ServeHTTP(served, httptest.NewRequest(http.MethodGet, first, nil))
		require.Equal(t, http.StatusOK, served.Code)
		img, _ := decodeAvatar(t, served.Body.Bytes())
		require.Equal(t, image.Rect(0, 0, avatarEdge, avatarEdge), img.Bounds())
		require.True(t, isBlue(img.At(128, 128)), "focal_x=0.9 crops the right side")

		// Replacing it deletes the old file once the row points at the new one.
		request = avatarUploadRequest(t, encodeJPEG(t, halvesImage(300, 300)), nil)
		signInAs(t, server, store, request, user)
		recorder, got = serve(server, request)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		second := *got.Avatar
		require.NotEqual(t, first, second, "a new unguessable name every time")
		require.NoFileExists(t, avatarFilePath(server.config.UploadPath, first))
		require.FileExists(t, avatarFilePath(server.config.UploadPath, second))

		request = httptest.NewRequest(http.MethodDelete, "/api/v1/users/me/avatar", nil)
		signInAs(t, server, store, request, user)
		recorder, got = serve(server, request)
		require.Equal(t, http.StatusOK, recorder.Code, recorder.Body.String())
		require.Nil(t, got.Avatar)
		require.Contains(t, recorder.Body.String(), `"avatar":null`)
		require.NoFileExists(t, avatarFilePath(server.config.UploadPath, second))
	})

	t.Run("a failed store leaves no file behind", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		store := mockdb.NewMockStore(ctrl)
		server := newTestServer(t, store)
		store.EXPECT().SetUserAvatar(gomock.Any(), gomock.Any()).Return("", errors.New("connection reset"))

		request := avatarUploadRequest(t, encodePNG(t, halvesImage(64, 64)), nil)
		signInAs(t, server, store, request, user)
		recorder, _ := serve(server, request)
		require.Equal(t, http.StatusInternalServerError, recorder.Code)
		entries, err := os.ReadDir(avatarDir(server.config.UploadPath))
		require.NoError(t, err)
		require.Empty(t, entries)
	})

	refused := map[string]struct {
		content []byte
		fields  map[string]string
		status  int
		code    string
	}{
		"no file":            {nil, nil, http.StatusBadRequest, ""},
		"not an image":       {[]byte("hello, I am text"), nil, http.StatusBadRequest, "avatar_type"},
		"SVG":                {[]byte(`<svg xmlns="http://www.w3.org/2000/svg"></svg>`), nil, http.StatusBadRequest, "avatar_type"},
		"unreadable image":   {pngHeaderOnly(64, 64), nil, http.StatusBadRequest, "avatar_unreadable"},
		"too many pixels":    {pngHeaderOnly(10_000, 10_000), nil, http.StatusBadRequest, "avatar_dimensions"},
		"too large":          {append(encodePNG(t, halvesImage(8, 8)), make([]byte, avatarMaxBytes)...), nil, http.StatusRequestEntityTooLarge, "avatar_too_large"},
		"focal out of range": {encodePNG(t, halvesImage(8, 8)), map[string]string{"focal_x": "1.5", "focal_y": "0.5"}, http.StatusBadRequest, ""},
		"half a focal point": {encodePNG(t, halvesImage(8, 8)), map[string]string{"focal_x": "0.5"}, http.StatusBadRequest, ""},
		"focal not a number": {encodePNG(t, halvesImage(8, 8)), map[string]string{"focal_x": "left", "focal_y": "top"}, http.StatusBadRequest, ""},
	}
	for name, tc := range refused {
		t.Run("refuses "+name, func(t *testing.T) {
			ctrl := gomock.NewController(t)
			store := mockdb.NewMockStore(ctrl)
			server := newTestServer(t, store)
			// No SetUserAvatar: nothing is stored.
			request := avatarUploadRequest(t, tc.content, tc.fields)
			signInAs(t, server, store, request, user)
			recorder, _ := serve(server, request)
			if tc.code != "" {
				requireErrorCode(t, recorder, tc.status, tc.code)
			} else {
				require.Equal(t, tc.status, recorder.Code, recorder.Body.String())
			}
			entries, _ := os.ReadDir(avatarDir(server.config.UploadPath))
			require.Empty(t, entries)
		})
	}

	t.Run("signed-in only", func(t *testing.T) {
		ctrl := gomock.NewController(t)
		server := newTestServer(t, mockdb.NewMockStore(ctrl))
		recorder, _ := serve(server, avatarUploadRequest(t, encodePNG(t, halvesImage(8, 8)), nil))
		require.Equal(t, http.StatusUnauthorized, recorder.Code)
		recorder, _ = serve(server, httptest.NewRequest(http.MethodDelete, "/api/v1/users/me/avatar", nil))
		require.Equal(t, http.StatusUnauthorized, recorder.Code)
	})
}

func TestUserShapesCarryTheAvatar(t *testing.T) {
	url := "/uploads/media/_avatars/avatar-0123456789abcdef0123456789abcdef.jpg"
	user := db.User{ID: 1, Username: "ana", AvatarUrl: url}
	require.Equal(t, url, *toPrivateUser(user).Avatar)
	require.Equal(t, url, *toPublicUser(user).Avatar)
	require.Equal(t, url, *toAuthorProfile("ana", "Ana", "", "", url).Avatar)
	require.Nil(t, toPrivateUser(db.User{}).Avatar)
}
