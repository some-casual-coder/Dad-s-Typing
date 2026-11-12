package outbox

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"regexp"
	"strings"
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

// Worker budget: ClaimLimit * (SendTimeout + MinDelay + Jitter) must stay
// below LeaseSeconds; handle re-checks the remaining lease before each send.
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
	// AckBackoff doubles per failed ack up to AckMaxBackoff.
	AckBackoff    time.Duration
	AckMaxBackoff time.Duration
	SendTimeout   time.Duration
	// RecordTimeout bounds ledger writes and acks after a send returns.
	RecordTimeout time.Duration
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
		if w.Poll(ctx) == 0 {
			_ = w.Sleep(ctx, w.PollEvery)
		}
	}
}

// Poll retries owed acks, then claims and processes one batch.
func (w *Worker) Poll(ctx context.Context) int {
	w.retryAcks(ctx)
	if !w.TR.State().Ready() {
		return 0
	}
	claimedAt := w.Now()
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
		if w.handle(ctx, it, claimedAt) {
			break
		}
		done++
	}
	return done
}

// leaseFits reports whether a send after wait ends before the lease does.
func (w *Worker) leaseFits(claimedAt time.Time, wait time.Duration) bool {
	left := time.Duration(w.LeaseSeconds)*time.Second - w.Now().Sub(claimedAt)
	return left >= wait+w.SendTimeout
}

// handle processes one item; true means stop the batch.
func (w *Worker) handle(ctx context.Context, it tsapp.Item, claimedAt time.Time) bool {
	if _, err := uuid.Parse(it.ID); err != nil {
		w.Log.Error("outbox item with bad id skipped")
		return false
	}
	led, err := w.Store.GetLedger(ctx, it.ID)
	if err != nil {
		w.Log.Error("ledger read failed", "err", "db")
		return false
	}
	if led != nil {
		w.resolveExisting(ctx, led)
		return false
	}
	if !digits.MatchString(it.Recipient) || it.Body == "" {
		w.settleFailed(ctx, it, "invalid_item")
		return false
	}
	known, err := w.Store.IsKnownSender(ctx, it.Recipient)
	if err != nil {
		w.Log.Error("known sender read failed", "err", "db")
		return false
	}
	if !known {
		w.settleFailed(ctx, it, "unknown_recipient")
		return false
	}
	n, err := w.Store.RecentSends(ctx, it.Recipient, w.Now().Add(-w.RecipientSpan))
	if err != nil {
		w.Log.Error("ledger read failed", "err", "db")
		return false
	}
	if n >= w.RecipientCap {
		w.settleFailed(ctx, it, "recipient_cap")
		return false
	}
	wait := w.paceWait()
	if !w.leaseFits(claimedAt, wait) {
		w.Log.Warn("outbox batch stopped: lease budget exhausted")
		return true
	}
	if wait > 0 && w.Sleep(ctx, wait) != nil {
		return true
	}
	w.dispatch(ctx, it)
	return false
}

func (w *Worker) settleFailed(ctx context.Context, it tsapp.Item, code string) {
	now := w.Now()
	if _, err := w.Store.BeginDispatch(ctx, it.ID, it.Recipient, "", now); err != nil {
		w.Log.Error("ledger write failed", "err", "db")
		return
	}
	if err := w.Store.SetLedger(ctx, it.ID, store.LedgerFailed, code, now); err != nil {
		w.Log.Error("ledger write failed", "err", "db")
		return
	}
	w.ack(ctx, it.ID, tsapp.Ack{State: "failed", Error: code})
}

func ackFor(l store.Ledger) tsapp.Ack {
	switch l.State {
	case store.LedgerSent:
		return tsapp.Ack{State: "sent", ProviderMessageID: l.ClientMsgID}
	case store.LedgerFailed:
		return tsapp.Ack{State: "failed", Error: l.Error}
	}
	code := l.Error
	if code == "" {
		code = "send_error"
	}
	return tsapp.Ack{State: "unknown", Error: code}
}

func (w *Worker) resolveExisting(ctx context.Context, l *store.Ledger) {
	if l.State == store.LedgerDispatching {
		_ = w.Store.SetLedger(ctx, l.OutboxID, store.LedgerUnknown,
			"interrupted", w.Now())
		l.State, l.Error = store.LedgerUnknown, "interrupted"
	}
	// Re-ack even when acked: the app redelivered it, and acks are idempotent.
	w.ack(ctx, l.OutboxID, ackFor(*l))
}

func (w *Worker) retryAcks(ctx context.Context) {
	rows, err := w.Store.DueAcks(ctx, w.Now(), 10)
	if err != nil {
		w.Log.Error("ledger read failed", "err", "db")
		return
	}
	for _, l := range rows {
		if ctx.Err() != nil {
			return
		}
		w.ack(ctx, l.OutboxID, ackFor(l))
	}
}

// paceWait is the delay owed before the next send, with jitter.
func (w *Worker) paceWait() time.Duration {
	if w.lastSend.IsZero() {
		return 0
	}
	wait := w.MinDelay - w.Now().Sub(w.lastSend)
	if wait < 0 {
		wait = 0
	}
	if w.Jitter > 0 {
		wait += time.Duration(rand.Int64N(int64(w.Jitter)))
	}
	return wait
}

func (w *Worker) send(ctx context.Context, it tsapp.Item, id string) error {
	switch {
	case it.Kind == "location" && it.Location != nil:
		p := it.Location
		return w.TR.SendRich(ctx, it.Recipient, transport.Rich{Kind: "location", Lat: p.Lat, Lon: p.Lon, Name: p.Name, Address: p.Address}, id)
	case it.Kind == "contact" && it.Contact != nil:
		return w.TR.SendRich(ctx, it.Recipient, transport.Rich{Kind: "contact", Name: it.Contact.Name, VCard: vcard(it.Contact)}, id)
	case it.Kind == "" || it.Kind == "text":
		return w.TR.Send(ctx, it.Recipient, it.Body, id)
	}
	return transport.ErrRejected
}

// vcard builds a minimal card; names and numbers come from the app's hub list.
func vcard(c *tsapp.OutCard) string {
	clean := strings.NewReplacer("\n", " ", "\r", " ", ";", " ").Replace
	return "BEGIN:VCARD\nVERSION:3.0\nFN:" + clean(c.Name) + "\nTEL;type=WORK:" + clean(c.Phone) + "\nEND:VCARD"
}

func (w *Worker) dispatch(ctx context.Context, it tsapp.Item) {
	msgID := w.TR.NewMessageID()
	created, err := w.Store.BeginDispatch(ctx, it.ID, it.Recipient, msgID, w.Now())
	if err != nil || !created {
		w.Log.Error("ledger write failed", "err", "db")
		return
	}
	// Detached from shutdown: a send in flight must finish and be recorded.
	base := context.WithoutCancel(ctx)
	sctx, cancel := context.WithTimeout(base, w.SendTimeout)
	err = w.send(sctx, it, msgID)
	cancel()
	w.lastSend = w.Now()

	rctx, rcancel := context.WithTimeout(base, w.RecordTimeout)
	defer rcancel()
	var state, code string
	switch {
	case err == nil:
		state = store.LedgerSent
	case errors.Is(err, transport.ErrNotReady):
		// Never left; drop the row so the lease expiry retries it.
		_ = w.Store.DropLedger(rctx, it.ID)
		w.Log.Warn("outbox send deferred", "err", "not_ready")
		return
	case errors.Is(err, transport.ErrRejected):
		state, code = store.LedgerFailed, "rejected"
	default:
		state, code = store.LedgerUnknown, "send_error"
	}
	if serr := w.Store.SetLedger(rctx, it.ID, state, code, w.Now()); serr != nil &&
		state == store.LedgerSent {
		// Cannot prove the record; never claim sent without it.
		w.Log.Error("ledger write failed after send", "err", "db")
		state, code = store.LedgerUnknown, "ledger_error"
	}
	w.Log.Info("outbox settled", "id", inbound.Redact(it.ID), "state", state)
	a := ackFor(store.Ledger{State: state, Error: code, ClientMsgID: msgID})
	w.ack(rctx, it.ID, a)
}

// ack records success, or schedules a retry that keeps the ledger row.
func (w *Worker) ack(ctx context.Context, id string, a tsapp.Ack) {
	err := w.TS.Ack(ctx, id, a)
	if err == nil {
		_ = w.Store.MarkAcked(ctx, id)
		return
	}
	attempts := 1
	if l, lerr := w.Store.GetLedger(ctx, id); lerr == nil && l != nil {
		attempts = l.AckAttempts + 1
	}
	d := w.AckBackoff << min(attempts-1, 16)
	if d > w.AckMaxBackoff || d <= 0 {
		d = w.AckMaxBackoff
	}
	d += time.Duration(rand.Int64N(int64(d)/4 + 1))
	_ = w.Store.AckFailed(ctx, id, attempts, w.Now().Add(d))
	w.Log.Warn("outbox ack failed", "id", inbound.Redact(id), "err", codeOf(err))
}

func codeOf(err error) string {
	var se *tsapp.StatusError
	if errors.As(err, &se) {
		return se.Error()
	}
	return "network"
}
