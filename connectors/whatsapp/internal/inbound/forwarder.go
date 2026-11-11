package inbound

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"time"

	"github.com/dadstyping/whatsapp-connector/internal/store"
	"github.com/dadstyping/whatsapp-connector/internal/tsapp"
)

type Poster interface {
	Inbound(ctx context.Context, p tsapp.InboundPayload) (string, error)
}

type Forwarder struct {
	Store       *store.Store
	Post        Poster
	Log         *slog.Logger
	Now         func() time.Time
	MaxAttempts int
	BaseDelay   time.Duration
	MaxDelay    time.Duration
	// PollEvery bounds idle sleep when nothing is scheduled.
	PollEvery time.Duration
	wake      chan struct{}
}

func (f *Forwarder) Wake() {
	if f.wake == nil {
		return
	}
	select {
	case f.wake <- struct{}{}:
	default:
	}
}

// Init must be called before Wake or Run.
func (f *Forwarder) Init() { f.wake = make(chan struct{}, 1) }

// Run forwards due rows one at a time until ctx ends.
func (f *Forwarder) Run(ctx context.Context) {
	for ctx.Err() == nil {
		worked, err := f.Step(ctx)
		if err != nil {
			f.Log.Error("forwarder step failed", "err", "db")
		}
		if worked && err == nil {
			continue
		}
		select {
		case <-ctx.Done():
		case <-f.wake:
		case <-time.After(f.idle(ctx)):
		}
	}
}

func (f *Forwarder) idle(ctx context.Context) time.Duration {
	at, ok, err := f.Store.NextInboxAt(ctx)
	if err != nil || !ok {
		return f.PollEvery
	}
	d := at.Sub(f.Now())
	if d < time.Millisecond {
		d = time.Millisecond
	}
	return min(d, f.PollEvery)
}

// Step handles one due row; it reports whether a row was processed.
func (f *Forwarder) Step(ctx context.Context) (bool, error) {
	m, err := f.Store.NextDue(ctx, f.Now())
	if err != nil || m == nil {
		return false, err
	}
	p := tsapp.InboundPayload{
		ProviderMessageID: m.ProviderID,
		Sender:            m.Sender,
		Text:              m.Text,
		ReceivedAt:        m.ReceivedAt.UTC().Format(time.RFC3339Nano),
	}
	if m.ImageB64 != "" {
		p.Image = &tsapp.Image{Mime: m.ImageMime, Base64: m.ImageB64}
	}
	_, perr := f.Post.Inbound(ctx, p)
	if perr == nil {
		f.Log.Info("inbound forwarded", "id", Redact(m.ProviderID))
		return true, f.Store.MarkForwarded(ctx, m.ID)
	}
	if ctx.Err() != nil {
		return false, nil
	}
	attempts := m.Attempts + 1
	if tsapp.IsPermanent(perr) || attempts >= f.MaxAttempts {
		f.Log.Error("inbound failed permanently", "id", Redact(m.ProviderID),
			"attempts", attempts)
		return true, f.Store.MarkInboxFailed(ctx, m.ID, attempts, errCode(perr))
	}
	f.Log.Warn("inbound forward failed", "id", Redact(m.ProviderID),
		"attempts", attempts, "err", errCode(perr))
	next := f.Now().Add(f.backoff(attempts))
	return true, f.Store.Reschedule(ctx, m.ID, attempts, next, errCode(perr))
}

func (f *Forwarder) backoff(attempts int) time.Duration {
	d := f.BaseDelay << min(attempts-1, 16)
	if d > f.MaxDelay || d <= 0 {
		d = f.MaxDelay
	}
	jitter := 0.8 + 0.4*rand.Float64()
	return time.Duration(float64(d) * jitter)
}

func errCode(err error) string {
	var se *tsapp.StatusError
	if errors.As(err, &se) {
		return se.Error()
	}
	return "network"
}
