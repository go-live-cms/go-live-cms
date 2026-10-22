// media_metadata.go strips privacy-sensitive metadata (EXIF, including GPS
// position and camera serials, XMP, IPTC, text chunks) from uploaded images
// without re-encoding them (#255).
//
// The pixels are untouched: only metadata segments/chunks are dropped, so
// there is no quality loss. A JPEG whose EXIF orientation isn't "upright"
// keeps a minimal EXIF block holding only that orientation, so it still
// displays the right way up. ICC colour profiles are kept (they change how
// the image looks, and identify no one). GIF and BMP are left alone.
package api

import (
	"bytes"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
)

var errMalformedImage = errors.New("malformed image structure")

// stripImageMetadataFile rewrites the image at path without its metadata,
// via a temp file and rename so a failure leaves the original intact.
func stripImageMetadataFile(path, mimeType string) error {
	var strip func([]byte) ([]byte, error)
	switch mimeType {
	case "image/jpeg":
		strip = stripJPEGMetadata
	case "image/png":
		strip = stripPNGMetadata
	case "image/webp":
		strip = stripWebPMetadata
	default:
		return nil
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	clean, err := strip(data)
	if err != nil {
		return err
	}
	if bytes.Equal(clean, data) {
		return nil
	}

	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".strip-*.tmp")
	if err != nil {
		return err
	}
	// CreateTemp makes the file 0600; keep the original's mode instead, so
	// the stripped file stays as readable as an unstripped upload.
	chmodErr := tmp.Chmod(info.Mode().Perm())
	_, writeErr := tmp.Write(clean)
	closeErr := tmp.Close()
	if err := errors.Join(chmodErr, writeErr, closeErr); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	return nil
}

// JPEG markers.
const (
	jpegSOI  = 0xD8
	jpegEOI  = 0xD9
	jpegSOS  = 0xDA
	jpegAPP1 = 0xE1 // EXIF, XMP
	jpegAPPD = 0xED // APP13: IPTC / Photoshop
	jpegCOM  = 0xFE
)

// stripJPEGMetadata drops APP1 (EXIF, XMP), APP13 (IPTC) and comment
// segments. Everything from the start of scan on is copied as is.
func stripJPEGMetadata(data []byte) ([]byte, error) {
	if len(data) < 4 || data[0] != 0xFF || data[1] != jpegSOI {
		return nil, errMalformedImage
	}
	orientation := jpegOrientation(data)

	out := make([]byte, 0, len(data))
	out = append(out, 0xFF, jpegSOI)
	insertedOrientation := orientation == 1
	pos := 2
	for {
		if pos+4 > len(data) || data[pos] != 0xFF {
			return nil, errMalformedImage
		}
		marker := data[pos+1]
		if marker == 0xFF { // fill byte
			pos++
			continue
		}
		if marker == jpegSOS || marker == jpegEOI {
			if !insertedOrientation {
				out = append(out, minimalOrientationAPP1(orientation)...)
			}
			return append(out, data[pos:]...), nil
		}
		length := int(binary.BigEndian.Uint16(data[pos+2:]))
		end := pos + 2 + length
		if length < 2 || end > len(data) {
			return nil, errMalformedImage
		}
		segment := data[pos:end]
		pos = end

		switch marker {
		case jpegAPP1, jpegAPPD, jpegCOM:
			continue
		}
		// Keep the orientation right after the JFIF/EXIF-position APP0.
		if !insertedOrientation && marker != 0xE0 {
			out = append(out, minimalOrientationAPP1(orientation)...)
			insertedOrientation = true
		}
		out = append(out, segment...)
	}
}

// minimalOrientationAPP1 is an EXIF APP1 segment holding only the
// orientation tag (big-endian TIFF, one IFD entry).
func minimalOrientationAPP1(orientation int) []byte {
	seg := []byte{
		0xFF, jpegAPP1, 0x00, 0x22, // marker, length 34
		'E', 'x', 'i', 'f', 0, 0,
		'M', 'M', 0x00, 0x2A, 0x00, 0x00, 0x00, 0x08, // TIFF header, IFD0 at 8
		0x00, 0x01, // one entry
		0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, // Orientation, SHORT, count 1
		0x00, byte(orientation), 0x00, 0x00, // value
		0x00, 0x00, 0x00, 0x00, // no next IFD
	}
	return seg
}

// jpegOrientation returns the EXIF orientation (1-8) of a JPEG, or 1 when it
// has none or it can't be read.
func jpegOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != jpegSOI {
		return 1
	}
	pos := 2
	for pos+4 <= len(data) && data[pos] == 0xFF {
		marker := data[pos+1]
		if marker == jpegSOS || marker == jpegEOI {
			return 1
		}
		length := int(binary.BigEndian.Uint16(data[pos+2:]))
		end := pos + 2 + length
		if length < 2 || end > len(data) {
			return 1
		}
		payload := data[pos+4 : end]
		pos = end
		if marker != jpegAPP1 || !bytes.HasPrefix(payload, []byte("Exif\x00\x00")) {
			continue
		}
		if o := tiffOrientation(payload[6:]); o != 0 {
			return o
		}
		return 1
	}
	return 1
}

// tiffOrientation reads tag 0x0112 from IFD0 of a TIFF block; 0 if absent.
func tiffOrientation(tiff []byte) int {
	if len(tiff) < 8 {
		return 0
	}
	var order binary.ByteOrder
	switch string(tiff[:2]) {
	case "II":
		order = binary.LittleEndian
	case "MM":
		order = binary.BigEndian
	default:
		return 0
	}
	ifd := int(order.Uint32(tiff[4:]))
	if ifd < 8 || ifd+2 > len(tiff) {
		return 0
	}
	count := int(order.Uint16(tiff[ifd:]))
	for i := 0; i < count; i++ {
		entry := ifd + 2 + i*12
		if entry+12 > len(tiff) {
			return 0
		}
		if order.Uint16(tiff[entry:]) != 0x0112 {
			continue
		}
		if order.Uint16(tiff[entry+2:]) != 3 { // SHORT
			return 0
		}
		o := int(order.Uint16(tiff[entry+8:]))
		if o < 1 || o > 8 {
			return 0
		}
		return o
	}
	return 0
}

var pngSignature = []byte("\x89PNG\r\n\x1a\n")

// pngMetadataChunks are the ancillary chunks dropped from PNGs: EXIF, the
// three text chunk types (which can carry XMP, comments, software and
// author fields) and the modification time.
var pngMetadataChunks = map[string]bool{
	"eXIf": true, "tEXt": true, "zTXt": true, "iTXt": true, "tIME": true,
}

func stripPNGMetadata(data []byte) ([]byte, error) {
	if !bytes.HasPrefix(data, pngSignature) {
		return nil, errMalformedImage
	}
	out := make([]byte, 0, len(data))
	out = append(out, pngSignature...)
	pos := len(pngSignature)
	for pos < len(data) {
		if pos+12 > len(data) {
			return nil, errMalformedImage
		}
		length := int(binary.BigEndian.Uint32(data[pos:]))
		end := pos + 12 + length
		if length < 0 || end > len(data) || end < pos {
			return nil, errMalformedImage
		}
		kind := string(data[pos+4 : pos+8])
		if !pngMetadataChunks[kind] {
			out = append(out, data[pos:end]...)
		}
		pos = end
		if kind == "IEND" {
			break
		}
	}
	return out, nil
}

// WebP VP8X feature flags for metadata chunks.
const (
	webpFlagEXIF = 0x08
	webpFlagXMP  = 0x04
)

// stripWebPMetadata drops the EXIF and XMP chunks of an extended (VP8X)
// WebP and clears their flags. Simple WebPs have no metadata chunks.
func stripWebPMetadata(data []byte) ([]byte, error) {
	if len(data) < 12 || string(data[:4]) != "RIFF" || string(data[8:12]) != "WEBP" {
		return nil, errMalformedImage
	}
	riffEnd := 8 + int(binary.LittleEndian.Uint32(data[4:]))
	if riffEnd > len(data) || riffEnd < 12 {
		return nil, errMalformedImage
	}

	out := make([]byte, 12, len(data))
	copy(out, data[:12])
	vp8xFlags := -1 // index of the VP8X flags byte in out
	pos := 12
	for pos < riffEnd {
		if pos+8 > riffEnd {
			return nil, errMalformedImage
		}
		kind := string(data[pos : pos+4])
		size := int(binary.LittleEndian.Uint32(data[pos+4:]))
		end := pos + 8 + size + size%2 // chunks are padded to even sizes
		if size < 0 || end > riffEnd || end < pos {
			// Tolerate a missing final pad byte.
			if pos+8+size == riffEnd {
				end = riffEnd
			} else {
				return nil, errMalformedImage
			}
		}
		if kind != "EXIF" && kind != "XMP " {
			if kind == "VP8X" && size >= 1 {
				vp8xFlags = len(out) + 8
			}
			out = append(out, data[pos:end]...)
		}
		pos = end
	}
	if vp8xFlags >= 0 {
		out[vp8xFlags] &^= webpFlagEXIF | webpFlagXMP
	}
	binary.LittleEndian.PutUint32(out[4:], uint32(len(out)-8))
	return out, nil
}
