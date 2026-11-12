package transport

import (
	"context"
	"errors"
	"time"
)

var (
	// ErrNotReady means the send was refused before reaching WhatsApp.
	ErrNotReady = errors.New("transport not ready")
	// ErrRejected means the send was refused locally and can never succeed.
	ErrRejected = errors.New("send rejected before dispatch")
	// ErrTooLarge means media exceeded the size cap while downloading.
	ErrTooLarge = errors.New("media exceeds size cap")
)

type Kind int

const (
	KindOther Kind = iota
	KindText
	KindImage
	KindEdit
	KindReaction
	KindMedia
	KindLocation
	KindContact
)

type Message struct {
	ID         string
	ChatServer string
	IsGroup    bool
	FromMe     bool
	// Sender is the phone digits of the sender, empty when unresolvable.
	Sender    string
	Kind      Kind
	Text      string
	ImageSize int64
	// Image downloads the media, failing with ErrTooLarge past max bytes.
	Image     func(ctx context.Context, max int64) ([]byte, error)
	Timestamp time.Time
	// A shared pin, rounded to about 1 km before it leaves this process.
	Lat, Lon float64
	// A shared contact card's display name; its numbers are never read.
	ContactName string
}

const (
	ReasonLoggedOut      = "logged_out"
	ReasonStreamReplaced = "stream_replaced"
	ReasonTemporaryBan   = "temporary_ban"
	ReasonClientOutdated = "client_outdated"
)

type State struct {
	Connected bool
	Paired    bool
	// Halted is set for logged out, stream replaced and temporary ban.
	Halted bool
	Reason string
}

func (s State) Ready() bool { return s.Connected && s.Paired && !s.Halted }

type EventKind int

const (
	EventMessage EventKind = iota + 1
	EventState
)

type Event struct {
	Kind    EventKind
	Message *Message
	State   State
}

type Transport interface {
	Start(ctx context.Context) error
	Events() <-chan Event
	State() State
	NewMessageID() string
	Send(ctx context.Context, phone, text, clientMsgID string) error
	PairPhone(ctx context.Context, phone string) (string, error)
	StartQR(ctx context.Context) error
	QR() string
	Logout(ctx context.Context) error
	Close()
}
