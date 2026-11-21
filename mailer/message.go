package mailer

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"mime"
	"mime/multipart"
	"mime/quotedprintable"
	"net/mail"
	"net/textproto"
	"net/url"
	"strings"
	"time"
)

// buildMessage renders msg as an RFC 5322 message (CRLF line endings): plain
// text, or multipart/alternative when it has HTML. The recipient must be a
// single address.
func buildMessage(from *mail.Address, msg Message, now time.Time) (to *mail.Address, raw []byte, err error) {
	to, err = mail.ParseAddress(msg.To)
	if err != nil {
		return nil, nil, fmt.Errorf("invalid recipient: %w", err)
	}
	if msg.Text == "" {
		return nil, nil, errors.New("message has no text body")
	}

	id := make([]byte, 16)
	if _, err := rand.Read(id); err != nil {
		return nil, nil, err
	}

	var b bytes.Buffer
	header := func(name, value string) {
		fmt.Fprintf(&b, "%s: %s\r\n", name, value)
	}
	header("From", from.String())
	header("To", to.String())
	header("Subject", mime.QEncoding.Encode("utf-8", oneLine(msg.Subject)))
	header("Date", now.Format(time.RFC1123Z))
	header("Message-ID", fmt.Sprintf("<%s@%s>", hex.EncodeToString(id), domainOf(from.Address)))
	header("MIME-Version", "1.0")
	header("Auto-Submitted", "auto-generated")
	if msg.ListUnsubscribe != "" {
		// RFC 8058: a POST to the URL, from the mail provider's servers, unsubscribes. The
		// URL must be https and is one header line (2369's angle brackets).
		link, err := listUnsubscribeURL(msg.ListUnsubscribe)
		if err != nil {
			return nil, nil, err
		}
		header("List-Unsubscribe", "<"+link+">")
		header("List-Unsubscribe-Post", "List-Unsubscribe=One-Click")
	}

	if msg.HTML == "" {
		header("Content-Type", "text/plain; charset=utf-8")
		header("Content-Transfer-Encoding", "quoted-printable")
		b.WriteString("\r\n")
		if err := writeQuotedPrintable(&b, msg.Text); err != nil {
			return nil, nil, err
		}
		return to, b.Bytes(), nil
	}

	var body bytes.Buffer
	parts := multipart.NewWriter(&body)
	for _, part := range []struct{ contentType, content string }{
		{"text/plain; charset=utf-8", msg.Text},
		{"text/html; charset=utf-8", msg.HTML},
	} {
		w, err := parts.CreatePart(textproto.MIMEHeader{
			"Content-Type":              {part.contentType},
			"Content-Transfer-Encoding": {"quoted-printable"},
		})
		if err != nil {
			return nil, nil, err
		}
		if err := writeQuotedPrintable(w, part.content); err != nil {
			return nil, nil, err
		}
	}
	if err := parts.Close(); err != nil {
		return nil, nil, err
	}

	header("Content-Type", mime.FormatMediaType("multipart/alternative", map[string]string{"boundary": parts.Boundary()}))
	b.WriteString("\r\n")
	b.Write(body.Bytes())
	return to, b.Bytes(), nil
}

// listUnsubscribeURL checks a one-click unsubscribe URL: absolute http(s) (https outside
// development, which PUBLIC_BASE_URL already enforces), printable ASCII with no space or
// angle bracket, so it stays one well-formed header value.
func listUnsubscribeURL(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "https" && u.Scheme != "http") || u.Host == "" {
		return "", errors.New("invalid List-Unsubscribe URL")
	}
	for _, r := range raw {
		if r <= ' ' || r >= 0x7f || r == '<' || r == '>' {
			return "", errors.New("invalid List-Unsubscribe URL")
		}
	}
	return raw, nil
}

func writeQuotedPrintable(w interface{ Write([]byte) (int, error) }, s string) error {
	qp := quotedprintable.NewWriter(w)
	if _, err := qp.Write([]byte(s)); err != nil {
		return err
	}
	return qp.Close()
}

// oneLine collapses CR/LF so a header value (the subject carries the site
// title, which admins set) can't inject further headers.
func oneLine(s string) string {
	return strings.Join(strings.Fields(strings.NewReplacer("\r", " ", "\n", " ").Replace(s)), " ")
}

func domainOf(address string) string {
	if i := strings.LastIndexByte(address, '@'); i >= 0 && i < len(address)-1 {
		return address[i+1:]
	}
	return "localhost"
}
