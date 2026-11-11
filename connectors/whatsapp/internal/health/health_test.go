package health

import (
	"context"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/dadstyping/whatsapp-connector/internal/transport"
	"github.com/dadstyping/whatsapp-connector/internal/tsapp"
	"github.com/dadstyping/whatsapp-connector/internal/tstest"
)

func TestReportsOnStartAndOnChange(t *testing.T) {
	ts := tstest.New()
	defer ts.Close()
	tr := transport.NewFake()
	r := &Reporter{
		Post: tsapp.New(ts.URL, tstest.Secret, "whatsapp"), State: tr.State, Version: "t",
		Log:   slog.New(slog.NewTextHandler(io.Discard, nil)),
		Now:   func() time.Time { return time.Unix(1700000000, 0) },
		Every: time.Hour, Degraded: func(context.Context) bool { return true },
	}
	r.Init()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { r.Run(ctx); close(done) }()

	wait := func(n int) {
		t.Helper()
		for i := 0; i < 200; i++ {
			ts.Lock()
			got := len(ts.Healths)
			ts.Unlock()
			if got >= n {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("want %d health posts", n)
	}
	wait(1)
	tr.SetState(transport.State{Halted: true, Reason: transport.ReasonLoggedOut})
	r.Notify()
	wait(2)
	cancel()
	<-done
	ts.Lock()
	defer ts.Unlock()
	a, b := ts.Healths[0], ts.Healths[1]
	if !a.Degraded {
		t.Fatal("degraded flag missing")
	}
	if !a.Connected || !a.Paired || a.LoggedOut || a.At != "2023-11-14T22:13:20Z" {
		t.Fatalf("first %+v", a)
	}
	if b.Connected || !b.LoggedOut {
		t.Fatalf("second %+v", b)
	}
	if ts.BadSig != 0 {
		t.Fatal("bad signature")
	}
}
