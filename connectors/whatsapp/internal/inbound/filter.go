package inbound

import (
	"bytes"
	"unicode/utf8"

	"github.com/dadstyping/whatsapp-connector/internal/transport"
)

const (
	MaxImageBytes = 4 << 20
	MaxTextRunes  = 4000
	MaxIDLen      = 128
)

// Drop reasons are stable codes safe to log.
const (
	DropGroup    = "group"
	DropServer   = "non_direct_chat"
	DropSelf     = "from_self"
	DropKind     = "unsupported_kind"
	DropOversize = "oversize"
	DropNoSender = "no_sender"
	DropBadID    = "bad_id"
	DropEmpty    = "empty"
	DropStale    = "stale"
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
		if m.ImageSize > MaxImageBytes || m.Image == nil {
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
