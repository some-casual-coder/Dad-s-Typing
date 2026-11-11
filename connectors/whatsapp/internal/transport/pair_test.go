package transport

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"go.mau.fi/whatsmeow"
)

type fakeSrc struct {
	opens, cancels atomic.Int32
	failRequests   int
	closed         chan struct{}
}

func (f *fakeSrc) source() pairSource {
	return pairSource{
		open: func() (<-chan whatsmeow.QRChannelItem, context.CancelFunc, error) {
			f.opens.Add(1)
			ch := make(chan whatsmeow.QRChannelItem, 2)
			ch <- whatsmeow.QRChannelItem{Event: "code", Code: "qr-code"}
			var once atomic.Bool
			cancel := func() {
				f.cancels.Add(1)
				if once.CompareAndSwap(false, true) {
					close(ch)
				}
			}
			return ch, cancel, nil
		},
		request: func(string) (string, error) {
			if f.failRequests > 0 {
				f.failRequests--
				return "", errors.New("rejected")
			}
			return "ABCD-1234", nil
		},
	}
}

func TestPairPhoneFailureThenRetrySucceeds(t *testing.T) {
	var p pairing
	f := &fakeSrc{failRequests: 1}
	if _, err := p.phone(context.Background(), f.source(), "254712345678"); err == nil {
		t.Fatal("expected first attempt to fail")
	}
	if f.cancels.Load() != 1 {
		t.Fatal("failed attempt did not cancel its pairing context")
	}
	if p.active || p.current() != "" {
		t.Fatal("guard or QR left behind after failure")
	}
	code, err := p.phone(context.Background(), f.source(), "254712345678")
	if err != nil || code != "ABCD-1234" {
		t.Fatalf("second attempt: %q %v", code, err)
	}
}

func TestPairContextCancelReleasesGuard(t *testing.T) {
	var p pairing
	src := pairSource{
		open: func() (<-chan whatsmeow.QRChannelItem, context.CancelFunc, error) {
			return make(chan whatsmeow.QRChannelItem), func() {}, nil
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := p.phone(ctx, src, "254712345678"); !errors.Is(err, context.Canceled) {
		t.Fatalf("err %v", err)
	}
	if p.active {
		t.Fatal("guard left set after ctx cancel")
	}
	if _, err := p.begin(); err != nil {
		t.Fatalf("next attempt blocked: %v", err)
	}
}

func TestPairSingleFlightAndStaleDrainSafe(t *testing.T) {
	var p pairing
	f := &fakeSrc{}
	if err := p.startQR(f.source()); err != nil {
		t.Fatal(err)
	}
	if _, err := p.phone(context.Background(), f.source(), "1"); !errors.Is(err, errPairing) {
		t.Fatalf("concurrent pairing allowed: %v", err)
	}
	// A late end() from an old attempt must not release a newer one.
	g1 := p.gen
	p.mu.Lock()
	p.active = false
	p.mu.Unlock()
	g2, _ := p.begin()
	p.end(g1)
	if !p.active || g2 == g1 {
		t.Fatal("stale end released the newer attempt")
	}
	time.Sleep(10 * time.Millisecond)
}

func TestPairOpenErrorReleasesGuard(t *testing.T) {
	var p pairing
	src := pairSource{open: func() (<-chan whatsmeow.QRChannelItem, context.CancelFunc, error) {
		return nil, nil, errors.New("boom")
	}}
	if err := p.startQR(src); err == nil {
		t.Fatal("expected error")
	}
	if p.active {
		t.Fatal("guard left set")
	}
}
