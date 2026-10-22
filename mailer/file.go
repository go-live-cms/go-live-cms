package mailer

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/mail"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// fileMailer is the development driver: each email becomes a .eml file in
// dir. Files are readable by the owner only, since they hold working links.
type fileMailer struct {
	dir    string
	from   *mail.Address
	logger *slog.Logger
	now    func() time.Time
}

func newFileMailer(dir string, from *mail.Address, logger *slog.Logger) (*fileMailer, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		dir = "dev-mail"
	}
	return &fileMailer{dir: dir, from: from, logger: logger, now: time.Now}, nil
}

func (m *fileMailer) Send(_ context.Context, msg Message) error {
	now := m.now()
	_, raw, err := buildMessage(m.from, msg, now)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(m.dir, 0o700); err != nil {
		return fmt.Errorf("create mail dir: %w", err)
	}

	suffix := make([]byte, 4)
	if _, err := rand.Read(suffix); err != nil {
		return err
	}
	name := fmt.Sprintf("%s-%s-%s.eml", now.UTC().Format("20060102T150405Z"), safeName(msg.Template), hex.EncodeToString(suffix))
	path := filepath.Join(m.dir, name)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return fmt.Errorf("write email file: %w", err)
	}

	// The path, not the contents: the body holds a single-use token.
	m.logger.Info("email written to file (MAIL_DRIVER=file)", "template", msg.Template, "path", path)
	return nil
}

// safeName keeps [a-z0-9-] for use in a file name.
func safeName(s string) string {
	s = strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		}
		return -1
	}, s)
	if s == "" {
		return "message"
	}
	return s
}
