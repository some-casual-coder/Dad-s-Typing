package inbound

import (
	"bytes"
	"image"
	_ "image/jpeg"
	_ "image/png"
	"unicode/utf8"

	_ "golang.org/x/image/webp"

	"github.com/dadstyping/whatsapp-connector/internal/transport"
)

const (
	MaxImageBytes = 4 << 20
	MaxTextRunes  = 4000
	MaxIDLen      = 128
)

// Drop reasons are stable codes safe to log.
const (
	DropGroup      = "group"
	DropServer     = "non_direct_chat"
	DropSelf       = "from_self"
	DropKind       = "unsupported_kind"
	DropOversize   = "oversize"
	DropNoSender   = "no_sender"
	DropBadID      = "bad_id"
	DropEmpty      = "empty"
	DropStale      = "stale"
	DropBadSize    = "bad_size"
	DropBadImage   = "bad_image"
	DropNotAllowed = "not_allowed"
)

// Filter returns "" when the message may be forwarded, else a drop reason.
func Filter(m transport.Message) string {
	switch {
	case m.IsGroup:
		return DropGroup
	case m.ChatServer != "s.whatsapp.net" && m.ChatServer != "lid":
		return DropServer
	case m.FromMe:
		return DropSelf
	case m.ID == "" || len(m.ID) > MaxIDLen:
		return DropBadID
	case !validSender(m.Sender):
		return DropNoSender
	}
	switch m.Kind {
	case transport.KindText:
		if m.Text == "" {
			return DropEmpty
		}
	case transport.KindImage:
		if m.ImageSize <= 0 || m.Image == nil {
			return DropBadSize
		}
		if m.ImageSize > MaxImageBytes {
			return DropOversize
		}
	default:
		return DropKind
	}
	if utf8.RuneCountInString(m.Text) > MaxTextRunes {
		return DropOversize
	}
	return ""
}

func validSender(s string) bool {
	if len(s) < 6 || len(s) > 15 {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// SniffImage returns the mime type from magic bytes, or "".
func SniffImage(b []byte) string {
	switch {
	case bytes.HasPrefix(b, []byte{0xFF, 0xD8, 0xFF}):
		return "image/jpeg"
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return "image/png"
	case len(b) >= 12 && bytes.Equal(b[0:4], []byte("RIFF")) &&
		bytes.Equal(b[8:12], []byte("WEBP")):
		return "image/webp"
	}
	return ""
}

const (
	maxDim    = 12000
	maxPixels = 40_000_000
)

// CheckImage validates magic bytes and decoded header dimensions.
func CheckImage(b []byte) (string, bool) {
	mime := SniffImage(b)
	if mime == "" {
		return "", false
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil || "image/"+format != mime {
		return "", false
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > maxDim ||
		cfg.Height > maxDim || cfg.Width*cfg.Height > maxPixels {
		return "", false
	}
	return mime, true
}
