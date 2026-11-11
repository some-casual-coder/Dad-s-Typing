package outbox

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/dadstyping/whatsapp-connector/internal/store"
	"github.com/dadstyping/whatsapp-connector/internal/transport"
	"github.com/dadstyping/whatsapp-connector/internal/tsapp"
	"github.com/dadstyping/whatsapp-connector/internal/tstest"
)

const (
	id1 = "123e4567-e89b-12d3-a456-426614174001"
	id2 = "123e4567-e89b-12d3-a456-426614174002"
	id3 = "123e4567-e89b-12d3-a456-426614174003"
)

type rig struct {
	dir    string
	st     *store.Store
	ts     *tstest.Server
	tr     *transport.Fake
	sleeps []time.Duration
}

func newRig(t *testing.T) *rig {
	t.Helper()
	r := &rig{dir: t.TempDir(), ts: tstest.New(), tr: transport.NewFake()}
	t.Cleanup(r.ts.Close)
	r.reopen(t)
	return r
}

func (r *rig) reopen(t *testing.T) {
	if r.st != nil {
		_ = r.st.Close()
	}
	st, err := store.Open(filepath.Join(r.dir, "c.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	r.st = st
}

// worker builds a fresh worker over the same store, like a process restart.
func (r *rig) worker() *Worker {
	return &Worker{
		Store: r.st, TS: tsapp.New(r.ts.URL, tstest.Secret), TR: r.tr,
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: time.Now,
		Sleep: func(_ context.Context, d time.Duration) error {
			r.sleeps = append(r.sleeps, d)
			return nil
		},
		ClaimLimit: 5, LeaseSeconds: 120, PollEvery: time.Second,
		MinDelay: 3 * time.Second, Jitter: time.Second,
		RecipientCap: 3, RecipientSpan: time.Hour,
		AckTries: 2, AckBackoff: time.Millisecond, SendTimeout: time.Second,
	}
}

func (r *rig) queue(ids ...string) {
	r.ts.Lock()
	defer r.ts.Unlock()
	for _, id := range ids {
		r.ts.Queue = append(r.ts.Queue, tsapp.Item{ID: id, Recipient: "254700000001", Body: "reply " + id, Attempt: 1})
	}
}

func (r *rig) acks(id string) []tsapp.Ack {
	r.ts.Lock()
	defer r.ts.Unlock()
	return append([]tsapp.Ack(nil), r.ts.Acks[id]...)
}

func TestSendThenAck(t *testing.T) {
	r := newRig(t)
	r.queue(id1)
	if n := r.worker().Poll(context.Background()); n != 1 {
		t.Fatalf("handled %d", n)
	}
	sent := r.tr.Sent()
	a := r.acks(id1)
	if len(sent) != 1 || len(a) != 1 || a[0].State != "sent" || a[0].ProviderMessageID != sent[0].ID {
		t.Fatalf("sent %v acks %v", sent, a)
	}
	if n, _ := r.st.PendingAcks(context.Background()); n != 0 {
		t.Fatalf("pending acks %d", n)
	}
}

func TestCrashAfterSendBeforeAckNeverResends(t *testing.T) {
	r := newRig(t)
	r.queue(id1)
	r.ts.FailAck = true
	r.worker().Poll(context.Background())
	if len(r.tr.Sent()) != 1 || len(r.acks(id1)) != 0 {
		t.Fatal("setup: expected one send, no ack")
	}
	if n, _ := r.st.PendingAcks(context.Background()); n != 1 {
		t.Fatalf("pending acks %d", n)
	}
	// Restart; TS recovers and redelivers the still-claimed item.
	r.reopen(t)
	r.ts.Lock()
	r.ts.FailAck = false
	r.ts.Unlock()
	r.worker().Poll(context.Background())
	a := r.acks(id1)
	if len(r.tr.Sent()) != 1 {
		t.Fatalf("resent: %d sends", len(r.tr.Sent()))
	}
	if len(a) != 1 || a[0].State != "sent" || a[0].ProviderMessageID != r.tr.Sent()[0].ID {
		t.Fatalf("acks %v", a)
	}
}

func TestCrashMidDispatchAcksUnknown(t *testing.T) {
	r := newRig(t)
	r.queue(id1)
	ctx := context.Background()
	if ok, err := r.st.BeginDispatch(ctx, id1, "254700000001", "MID1", time.Now()); err != nil || !ok {
		t.Fatal("setup", err)
	}
	r.worker().Poll(ctx)
	a := r.acks(id1)
	if len(r.tr.Sent()) != 0 {
		t.Fatal("resent after possible delivery")
	}
	if len(a) != 1 || a[0].State != "unknown" {
		t.Fatalf("acks %v", a)
	}
	if l, _ := r.st.GetLedger(ctx, id1); l.State != store.LedgerUnknown {
		t.Fatalf("ledger %s", l.State)
	}
}

func TestAmbiguousErrorIsUnknownNoRetry(t *testing.T) {
	r := newRig(t)
	r.queue(id1)
	r.tr.SendErr = func(int) error { return errors.New("i/o timeout") }
	w := r.worker()
	w.Poll(context.Background())
	w.Poll(context.Background())
	a := r.acks(id1)
	if len(a) != 1 || a[0].State != "unknown" || a[0].Error != "send_error" {
		t.Fatalf("acks %v", a)
	}
}

func TestRejectedIsFailed(t *testing.T) {
	r := newRig(t)
	r.queue(id1)
	r.tr.SendErr = func(int) error { return transport.ErrRejected }
	r.worker().Poll(context.Background())
	if a := r.acks(id1); len(a) != 1 || a[0].State != "failed" {
		t.Fatalf("acks %v", a)
	}
}

func TestNoClaimWhenDisconnected(t *testing.T) {
	r := newRig(t)
	r.queue(id1)
	for _, s := range []transport.State{
		{Paired: true}, {Connected: true},
		{Connected: true, Paired: true, Halted: true, Reason: transport.ReasonLoggedOut},
	} {
		r.tr.SetState(s)
		if n := r.worker().Poll(context.Background()); n != 0 {
			t.Fatalf("claimed in state %+v", s)
		}
	}
	if len(r.tr.Sent()) != 0 || len(r.acks(id1)) != 0 {
		t.Fatal("activity while down")
	}
}

func TestNotReadyMidSendLeavesNoLedger(t *testing.T) {
	r := newRig(t)
	r.queue(id1)
	r.tr.SendErr = func(int) error { return transport.ErrNotReady }
	r.worker().Poll(context.Background())
	if l, _ := r.st.GetLedger(context.Background(), id1); l != nil {
		t.Fatal("ledger kept for undispatched send")
	}
	if len(r.acks(id1)) != 0 {
		t.Fatal("acked a send that never left")
	}
}

func TestPacingBetweenSends(t *testing.T) {
	r := newRig(t)
	r.queue(id1, id2, id3)
	r.worker().Poll(context.Background())
	if len(r.tr.Sent()) != 3 {
		t.Fatalf("sent %d", len(r.tr.Sent()))
	}
	// First send is immediate; later ones wait >= MinDelay (~3s), < +jitter.
	if len(r.sleeps) != 2 {
		t.Fatalf("sleeps %v", r.sleeps)
	}
	for _, d := range r.sleeps {
		if d < 2900*time.Millisecond || d > 4*time.Second {
			t.Fatalf("pacing delay %v", d)
		}
	}
}

func TestRecipientCap(t *testing.T) {
	r := newRig(t)
	ids := []string{id1, id2, id3, "123e4567-e89b-12d3-a456-426614174004"}
	r.queue(ids...)
	r.worker().Poll(context.Background())
	if len(r.tr.Sent()) != 3 {
		t.Fatalf("sent %d", len(r.tr.Sent()))
	}
	if a := r.acks(ids[3]); len(a) != 1 || a[0].State != "failed" || a[0].Error != "recipient_cap" {
		t.Fatalf("acks %v", a)
	}
}

func TestInvalidItemsSkipped(t *testing.T) {
	r := newRig(t)
	r.ts.Lock()
	r.ts.Queue = []tsapp.Item{
		{ID: "../evil", Recipient: "254700000001", Body: "x"},
		{ID: id1, Recipient: "+254 7", Body: "x"},
	}
	r.ts.Unlock()
	r.worker().Poll(context.Background())
	if len(r.tr.Sent()) != 0 {
		t.Fatal("sent invalid item")
	}
	if a := r.acks(id1); len(a) != 1 || a[0].State != "failed" {
		t.Fatalf("acks %v", a)
	}
}
