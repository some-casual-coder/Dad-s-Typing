//go:build integration

// Drives the real connector code against a running app; only WhatsApp is faked.
package integration

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/dadstyping/whatsapp-connector/internal/inbound"
	"github.com/dadstyping/whatsapp-connector/internal/outbox"
	"github.com/dadstyping/whatsapp-connector/internal/store"
	"github.com/dadstyping/whatsapp-connector/internal/transport"
	"github.com/dadstyping/whatsapp-connector/internal/tsapp"
)

func env(t *testing.T, k, def string) string {
	v := os.Getenv(k)
	if v == "" {
		v = def
	}
	if v == "" {
		t.Skipf("%s not set", k)
	}
	return v
}

var link = regexp.MustCompile(`/t/([0-9a-f-]{36})#k=([A-Za-z0-9_-]+)`)

func TestForwardedMessageRoundTrip(t *testing.T) {
	base := env(t, "TS_BASE_URL", "http://localhost:3000")
	secret := env(t, "WHATSAPP_BRIDGE_SECRET", "")
	sender := env(t, "ITEST_SENDER", "")

	dir := t.TempDir()
	if err := store.Prepare(dir, "connector.db"); err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(dir, "connector.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	ts := tsapp.New(base, secret, "whatsapp")
	fake := transport.NewFake()
	fwd := &inbound.Forwarder{Store: st, Post: ts, Log: log, Now: time.Now,
		BaseDelay: 200 * time.Millisecond, MaxDelay: time.Second, FailedRetry: time.Minute,
		PollEvery: 300 * time.Millisecond}
	fwd.Init()
	ing := &inbound.Ingestor{Store: st, Log: log, Wake: fwd.Wake, Now: time.Now,
		DownloadTries: 1, DownloadWait: time.Millisecond, MaxAge: time.Hour}
	ob := &outbox.Worker{Store: st, TS: ts, TR: fake, Log: log, Now: time.Now,
		Sleep: outbox.RealSleep, ClaimLimit: 5, LeaseSeconds: 60, PollEvery: 300 * time.Millisecond,
		MinDelay: 10 * time.Millisecond, Jitter: time.Millisecond, RecipientCap: 20, RecipientSpan: time.Hour,
		AckBackoff: 100 * time.Millisecond, AckMaxBackoff: time.Second,
		SendTimeout: 5 * time.Second, RecordTimeout: 5 * time.Second}

	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	go fwd.Run(ctx)
	go ob.Run(ctx)

	msg := transport.Message{ID: fmt.Sprintf("ITEST.%d", time.Now().UnixNano()), ChatServer: "s.whatsapp.net",
		Sender: sender, Kind: transport.KindText, Text: "Mum wants a cat carrier that opens from the top",
		Timestamp: time.Now()}
	ing.Ingest(ctx, msg)
	ing.Ingest(ctx, msg) // a duplicate delivery from WhatsApp

	deadline := time.Now().Add(80 * time.Second)
	for len(fake.Sent()) == 0 && time.Now().Before(deadline) {
		time.Sleep(300 * time.Millisecond)
	}
	sent := fake.Sent()
	if len(sent) != 1 {
		t.Fatalf("want exactly one reply, got %d", len(sent))
	}
	if sent[0].Phone != sender {
		t.Fatalf("reply went to the wrong recipient")
	}
	m := link.FindStringSubmatch(sent[0].Text)
	if m == nil {
		t.Fatalf("reply has no task link")
	}

	// the link's grant opens the task it names
	req, _ := http.NewRequest("GET", base+"/api/tasks/"+m[1], nil)
	req.Header.Set("Authorization", "Bearer "+m[2])
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("link did not open its task: %d", res.StatusCode)
	}
	other := strings.Replace(m[1], m[1][:4], "0000", 1)
	req2, _ := http.NewRequest("GET", base+"/api/tasks/"+other, nil)
	req2.Header.Set("Authorization", "Bearer "+m[2])
	res2, _ := http.DefaultClient.Do(req2)
	if res2 != nil {
		res2.Body.Close()
		if res2.StatusCode == 200 {
			t.Fatalf("grant opened a different task")
		}
	}

	// a redelivery of the same message must not produce a second reply
	ing.Ingest(ctx, msg)
	time.Sleep(4 * time.Second)
	if n := len(fake.Sent()); n != 1 {
		t.Fatalf("duplicate caused %d replies", n)
	}
	if err := ts.Health(ctx, tsapp.Health{Connected: true, Paired: true, Version: "itest", At: time.Now().UTC().Format(time.RFC3339)}); err != nil {
		t.Fatalf("health post failed: %v", err)
	}
}
