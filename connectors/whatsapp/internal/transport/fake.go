package transport

import (
	"context"
	"errors"
	"fmt"
	"sync"
)

type Sent struct{ Phone, Text, ID string }

// Fake is an in-memory Transport for tests.
type Fake struct {
	mu      sync.Mutex
	state   State
	sent    []Sent
	seq     int
	events  chan Event
	SendErr func(n int) error
	QRCode  string
	Code    string
	closed  bool
}

func NewFake() *Fake {
	return &Fake{
		state:  State{Connected: true, Paired: true},
		events: make(chan Event, 64),
		Code:   "ABCD-1234",
	}
}

func (f *Fake) Start(context.Context) error { return nil }
func (f *Fake) Events() <-chan Event        { return f.events }

func (f *Fake) State() State {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.state
}

func (f *Fake) SetState(s State) {
	f.mu.Lock()
	f.state = s
	f.mu.Unlock()
	f.events <- Event{Kind: EventState, State: s}
}

func (f *Fake) Emit(m Message) {
	f.events <- Event{Kind: EventMessage, Message: &m}
}

func (f *Fake) NewMessageID() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seq++
	return fmt.Sprintf("FAKE%04d", f.seq)
}

func (f *Fake) Send(_ context.Context, phone, text, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.state.Ready() {
		return ErrNotReady
	}
	if f.SendErr != nil {
		if err := f.SendErr(len(f.sent)); err != nil {
			return err
		}
	}
	f.sent = append(f.sent, Sent{phone, text, id})
	return nil
}

func (f *Fake) Sent() []Sent {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]Sent(nil), f.sent...)
}

func (f *Fake) PairPhone(context.Context, string) (string, error) {
	if f.State().Paired {
		return "", errors.New("already paired")
	}
	return f.Code, nil
}

func (f *Fake) StartQR(context.Context) error { return nil }
func (f *Fake) QR() string                    { return f.QRCode }

func (f *Fake) Logout(context.Context) error {
	f.SetState(State{Halted: true, Reason: ReasonLoggedOut})
	return nil
}

func (f *Fake) Close() {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		f.closed = true
		close(f.events)
	}
}
