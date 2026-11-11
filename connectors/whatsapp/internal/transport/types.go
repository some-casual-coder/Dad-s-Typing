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
)

type Kind int

const (
	KindOther Kind = iota
	KindText
	KindImage
	KindEdit
	KindReaction
	KindMedia
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
	Image     func(ctx context.Context) ([]byte, error)
	Timestamp time.Time
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
