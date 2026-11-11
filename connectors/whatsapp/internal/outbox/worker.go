package outbox

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"regexp"
	"time"

	"github.com/google/uuid"

	"github.com/dadstyping/whatsapp-connector/internal/inbound"
	"github.com/dadstyping/whatsapp-connector/internal/store"
	"github.com/dadstyping/whatsapp-connector/internal/transport"
	"github.com/dadstyping/whatsapp-connector/internal/tsapp"
)

type TS interface {
	Claim(ctx context.Context, limit, lease int) ([]tsapp.Item, error)
	Ack(ctx context.Context, id string, a tsapp.Ack) error
}

type Worker struct {
	Store *store.Store
	TS    TS
	TR    transport.Transport
	Log   *slog.Logger
	Now   func() time.Time
	// Sleep waits d or returns early with the context error.
	Sleep func(ctx context.Context, d time.Duration) error

	ClaimLimit    int
	LeaseSeconds  int
	PollEvery     time.Duration
	MinDelay      time.Duration
	Jitter        time.Duration
	RecipientCap  int
	RecipientSpan time.Duration
	AckTries      int
	AckBackoff    time.Duration
	SendTimeout   time.Duration
	lastSend      time.Time
}

var digits = regexp.MustCompile(`^[0-9]{6,15}$`)

func RealSleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func (w *Worker) Run(ctx context.Context) {
	for ctx.Err() == nil {
		n := w.Poll(ctx)
		if n == 0 {
			_ = w.Sleep(ctx, w.PollEvery)
		}
	}
}

// Poll claims and processes one batch; it returns the items handled.
func (w *Worker) Poll(ctx context.Context) int {
	if !w.TR.State().Ready() {
		return 0
	}
	items, err := w.TS.Claim(ctx, w.ClaimLimit, w.LeaseSeconds)
	if err != nil {
		if ctx.Err() == nil {
			w.Log.Warn("outbox claim failed", "err", codeOf(err))
		}
		return 0
	}
	done := 0
	for _, it := range items {
		if ctx.Err() != nil || !w.TR.State().Ready() {
			break
		}
		w.handle(ctx, it)
		done++
	}
	return done
}

func (w *Worker) handle(ctx context.Context, it tsapp.Item) {
	if _, err := uuid.Parse(it.ID); err != nil {
		w.Log.Error("outbox item with bad id skipped")
		return
	}
	led, err := w.Store.GetLedger(ctx, it.ID)
	if err != nil {
		w.Log.Error("ledger read failed", "err", "db")
		return
	}
	if led != nil {
		w.resolveExisting(ctx, it.ID, led)
		return
	}
	if !digits.MatchString(it.Recipient) || it.Body == "" {
		w.record(ctx, it.ID, it.Recipient, "", store.LedgerFailed, "invalid_item")
		w.ack(ctx, it.ID, tsapp.Ack{State: "failed", Error: "invalid_item"})
		return
	}
	n, err := w.Store.RecentSends(ctx, it.Recipient, w.Now().Add(-w.RecipientSpan))
	if err != nil {
		w.Log.Error("ledger read failed", "err", "db")
		return
	}
	if n >= w.RecipientCap {
		w.record(ctx, it.ID, it.Recipient, "", store.LedgerFailed, "recipient_cap")
		w.ack(ctx, it.ID, tsapp.Ack{State: "failed", Error: "recipient_cap"})
		return
	}
	if err := w.pace(ctx); err != nil {
		return
	}
	w.dispatch(ctx, it)
}

func (w *Worker) record(ctx context.Context, id, rcpt, msgID, state, code string) {
	now := w.Now()
	if _, err := w.Store.BeginDispatch(ctx, id, rcpt, msgID, now); err != nil {
		w.Log.Error("ledger write failed", "err", "db")
		return
	}
	if err := w.Store.SetLedger(ctx, id, state, code, now); err != nil {
		w.Log.Error("ledger write failed", "err", "db")
	}
}

func (w *Worker) resolveExisting(ctx context.Context, id string, l *store.Ledger) {
	switch l.State {
	case store.LedgerSent:
		w.ack(ctx, id, tsapp.Ack{State: "sent", ProviderMessageID: l.ClientMsgID})
	case store.LedgerFailed:
		w.ack(ctx, id, tsapp.Ack{State: "failed", Error: l.Error})
	default:
		if l.State == store.LedgerDispatching {
			_ = w.Store.SetLedger(ctx, id, store.LedgerUnknown, "interrupted", w.Now())
		}
		w.ack(ctx, id, tsapp.Ack{State: "unknown", Error: "interrupted"})
	}
}

func (w *Worker) pace(ctx context.Context) error {
	if !w.lastSend.IsZero() {
		wait := w.MinDelay - w.Now().Sub(w.lastSend)
		if wait < 0 {
			wait = 0
		}
		if w.Jitter > 0 {
			wait += time.Duration(rand.Int64N(int64(w.Jitter)))
		}
		if wait > 0 {
			return w.Sleep(ctx, wait)
		}
	}
	return nil
}

func (w *Worker) dispatch(ctx context.Context, it tsapp.Item) {
	msgID := w.TR.NewMessageID()
	created, err := w.Store.BeginDispatch(ctx, it.ID, it.Recipient, msgID, w.Now())
	if err != nil || !created {
		w.Log.Error("ledger write failed", "err", "db")
		return
	}
	// Detached from shutdown: a send in flight must finish and be recorded.
	sctx, cancel := context.WithTimeout(context.Background(), w.SendTimeout)
	defer cancel()
	err = w.TR.Send(sctx, it.Recipient, it.Body, msgID)
	w.lastSend = w.Now()
	switch {
	case err == nil:
		_ = w.Store.SetLedger(ctx, it.ID, store.LedgerSent, "", w.Now())
		w.Log.Info("outbox sent", "id", inbound.Redact(it.ID))
		w.ack(ctx, it.ID, tsapp.Ack{State: "sent", ProviderMessageID: msgID})
	case errors.Is(err, transport.ErrNotReady):
		// Never left; drop the row so the lease expiry retries it.
		_ = w.Store.DropLedger(ctx, it.ID)
		w.Log.Warn("outbox send deferred", "err", "not_ready")
	case errors.Is(err, transport.ErrRejected):
		_ = w.Store.SetLedger(ctx, it.ID, store.LedgerFailed, "rejected", w.Now())
		w.ack(ctx, it.ID, tsapp.Ack{State: "failed", Error: "rejected"})
	default:
		_ = w.Store.SetLedger(ctx, it.ID, store.LedgerUnknown, "send_error", w.Now())
		w.Log.Warn("outbox send ambiguous", "id", inbound.Redact(it.ID))
		w.ack(ctx, it.ID, tsapp.Ack{State: "unknown", Error: "send_error"})
	}
}

// ack retries a bounded number of times; the ledger covers the remainder.
func (w *Worker) ack(ctx context.Context, id string, a tsapp.Ack) {
	var err error
	for i := 0; i < w.AckTries; i++ {
		if err = w.TS.Ack(ctx, id, a); err == nil {
			_ = w.Store.MarkAcked(ctx, id)
			return
		}
		if tsapp.IsPermanent(err) {
			_ = w.Store.MarkAcked(ctx, id)
			break
		}
		if ctx.Err() != nil {
			break
		}
		d := w.AckBackoff << i
		if w.Sleep(ctx, d+time.Duration(rand.Int64N(int64(d)+1))/4) != nil {
			break
		}
	}
	w.Log.Warn("outbox ack failed", "id", inbound.Redact(id), "err", codeOf(err))
}

func codeOf(err error) string {
	var se *tsapp.StatusError
	if errors.As(err, &se) {
		return se.Error()
	}
	return "network"
}
