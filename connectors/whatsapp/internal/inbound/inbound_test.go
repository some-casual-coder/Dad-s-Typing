package inbound

import (
	"bytes"
	"context"
	"encoding/base64"
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

var jpeg = append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, bytes.Repeat([]byte{1}, 64)...)

func text(id string) transport.Message {
	return transport.Message{ID: id, ChatServer: "s.whatsapp.net",
		Sender: "254712345678", Kind: transport.KindText, Text: "hi",
		Timestamp: time.Unix(1700000000, 0)}
}

func TestFilter(t *testing.T) {
	img := func(m *transport.Message) {
		m.Kind, m.ImageSize = transport.KindImage, 100
		m.Image = func(context.Context) ([]byte, error) { return jpeg, nil }
	}
	cases := []struct {
		name string
		mut  func(*transport.Message)
		want string
	}{
		{"ok text", func(*transport.Message) {}, ""},
		{"ok image", img, ""},
		{"ok lid chat", func(m *transport.Message) { m.ChatServer = "lid" }, ""},
		{"group", func(m *transport.Message) { m.IsGroup, m.ChatServer = true, "g.us" }, DropGroup},
		{"status", func(m *transport.Message) { m.ChatServer = "broadcast" }, DropServer},
		{"newsletter", func(m *transport.Message) { m.ChatServer = "newsletter" }, DropServer},
		{"self", func(m *transport.Message) { m.FromMe = true }, DropSelf},
		{"edit", func(m *transport.Message) { m.Kind = transport.KindEdit }, DropKind},
		{"reaction", func(m *transport.Message) { m.Kind = transport.KindReaction }, DropKind},
		{"video etc", func(m *transport.Message) { m.Kind = transport.KindMedia }, DropKind},
		{"other", func(m *transport.Message) { m.Kind = transport.KindOther }, DropKind},
		{"oversize image", func(m *transport.Message) {
			img(m)
			m.ImageSize = MaxImageBytes + 1
		}, DropOversize},
		{"image at limit", func(m *transport.Message) {
			img(m)
			m.ImageSize = MaxImageBytes
		}, ""},
		{"long text", func(m *transport.Message) {
			m.Text = string(bytes.Repeat([]byte("a"), MaxTextRunes+1))
		}, DropOversize},
		{"no sender", func(m *transport.Message) { m.Sender = "" }, DropNoSender},
		{"non digit sender", func(m *transport.Message) { m.Sender = "25471x" }, DropNoSender},
		{"long id", func(m *transport.Message) { m.ID = string(bytes.Repeat([]byte("a"), 129)) }, DropBadID},
		{"empty text", func(m *transport.Message) { m.Text = "" }, DropEmpty},
	}
	for _, c := range cases {
		m := text("ID1")
		c.mut(&m)
		if got := Filter(m); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestSniffImage(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n"), 0, 0)
	webp := []byte("RIFF\x00\x00\x00\x00WEBPVP8 ")
	for b, want := range map[string]string{
		string(jpeg): "image/jpeg", string(png): "image/png",
		string(webp): "image/webp", "GIF89a": "", "<html>": "", "": "",
	} {
		if got := SniffImage([]byte(b)); got != want {
			t.Errorf("sniff %q: %q", b[:min(len(b), 4)], got)
		}
	}
}

type rig struct {
	st  *store.Store
	ts  *tstest.Server
	dir string
}

func newRig(t *testing.T) *rig {
	t.Helper()
	dir := t.TempDir()
	r := &rig{ts: tstest.New(), dir: dir}
	t.Cleanup(r.ts.Close)
	r.open(t)
	return r
}

func (r *rig) open(t *testing.T) {
	st, err := store.Open(filepath.Join(r.dir, "c.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	r.st = st
}

func (r *rig) forwarder() *Forwarder {
	f := &Forwarder{
		Store: r.st, Post: tsapp.New(r.ts.URL, tstest.Secret),
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: time.Now,
		MaxAttempts: 5, BaseDelay: time.Millisecond, MaxDelay: 5 * time.Millisecond,
		PollEvery: 5 * time.Millisecond,
	}
	f.Init()
	return f
}

func (r *rig) ingestor(f *Forwarder) *Ingestor {
	return &Ingestor{Store: r.st, Log: slog.New(slog.NewTextHandler(io.Discard, nil)),
		Wake: f.Wake, Now: time.Now, DownloadTries: 2, DownloadWait: time.Millisecond}
}

func drain(t *testing.T, f *Forwarder, ctx context.Context) {
	t.Helper()
	for i := 0; i < 200; i++ {
		worked, err := f.Step(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if !worked {
			time.Sleep(2 * time.Millisecond)
			if n, _ := f.Store.PendingInbox(ctx); n == 0 {
				return
			}
		}
	}
	t.Fatal("did not drain")
}

func TestPersistBeforeForwardAndResumeAfterRestart(t *testing.T) {
	ctx := context.Background()
	r := newRig(t)
	r.ts.FailInbound = 100
	f := r.forwarder()
	r.ingestor(f).Ingest(ctx, text("MSG1"))

	// Persisted before any forwarding happened.
	if st, _, err := r.st.InboxState(ctx, "MSG1"); err != nil || st != store.InboxReceived {
		t.Fatalf("state %q err %v", st, err)
	}
	if r.ts.Calls != 0 {
		t.Fatal("forwarded before persist")
	}
	if worked, _ := f.Step(ctx); !worked {
		t.Fatal("expected a forward attempt")
	}
	if r.ts.Accepted["MSG1"] != 0 {
		t.Fatal("accepted despite failure")
	}

	// Simulated restart: reopen DB, new forwarder, TS recovers after 2 more fails.
	_ = r.st.Close()
	r.open(t)
	r.ts.Lock()
	r.ts.FailInbound = 2
	r.ts.Unlock()
	f2 := r.forwarder()
	drain(t, f2, ctx)

	if got := r.ts.Accepted["MSG1"]; got != 1 {
		t.Fatalf("accepted %d times", got)
	}
	// Redelivery from WhatsApp must not create a second post.
	r.ingestor(f2).Ingest(ctx, text("MSG1"))
	drain(t, f2, ctx)
	if got := r.ts.Accepted["MSG1"]; got != 1 {
		t.Fatalf("duplicate post: %d", got)
	}
	if st, _, _ := r.st.InboxState(ctx, "MSG1"); st != store.InboxForwarded {
		t.Fatalf("state %q", st)
	}
	if r.ts.BadSig != 0 {
		t.Fatal("unsigned or badly signed request")
	}
}

func TestPayloadShapeAndImage(t *testing.T) {
	ctx := context.Background()
	r := newRig(t)
	f := r.forwarder()
	m := text("IMG1")
	m.Kind, m.Text, m.ImageSize = transport.KindImage, "cap", int64(len(jpeg))
	m.Image = func(context.Context) ([]byte, error) { return jpeg, nil }
	r.ingestor(f).Ingest(ctx, m)
	drain(t, f, ctx)
	p := r.ts.Last[0]
	if p.Sender != "254712345678" || p.Text != "cap" || p.Image == nil ||
		p.Image.Mime != "image/jpeg" || p.ReceivedAt != "2023-11-14T22:13:20Z" {
		t.Fatalf("payload %+v", p)
	}
	raw, _ := base64.StdEncoding.DecodeString(p.Image.Base64)
	if !bytes.Equal(raw, jpeg) {
		t.Fatal("image bytes differ")
	}
}

func TestBadImageDropped(t *testing.T) {
	ctx := context.Background()
	r := newRig(t)
	f := r.forwarder()
	g := r.ingestor(f)
	m := text("BAD1")
	m.Kind, m.ImageSize = transport.KindImage, 10
	m.Image = func(context.Context) ([]byte, error) { return []byte("<html>not an image"), nil }
	g.Ingest(ctx, m)
	m2 := text("BAD2")
	m2.Kind, m2.ImageSize = transport.KindImage, 10
	m2.Image = func(context.Context) ([]byte, error) {
		return bytes.Repeat([]byte{0xFF, 0xD8, 0xFF}, MaxImageBytes), nil
	}
	g.Ingest(ctx, m2)
	if n, _ := r.st.PendingInbox(ctx); n != 0 {
		t.Fatalf("pending %d", n)
	}
}

func TestPermanentFailure(t *testing.T) {
	ctx := context.Background()
	r := newRig(t)
	r.ts.FailInbound = 1000
	f := r.forwarder()
	r.ingestor(f).Ingest(ctx, text("PERM"))
	drain(t, f, ctx)
	st, attempts, _ := r.st.InboxState(ctx, "PERM")
	if st != store.InboxFailed || attempts != 5 {
		t.Fatalf("state %s attempts %d", st, attempts)
	}
	if r.ts.Calls != 5 {
		t.Fatalf("calls %d", r.ts.Calls)
	}
}

func TestStaleDroppedAndFreshKept(t *testing.T) {
	ctx := context.Background()
	r := newRig(t)
	f := r.forwarder()
	g := r.ingestor(f)
	g.MaxAge = time.Hour
	old := text("OLD1")
	old.Timestamp = time.Now().Add(-2 * time.Hour)
	fresh := text("NEW1")
	fresh.Timestamp = time.Now()
	g.Ingest(ctx, old)
	g.Ingest(ctx, fresh)
	if ok, _ := r.st.HasInbox(ctx, "OLD1"); ok {
		t.Error("stale message stored")
	}
	if ok, _ := r.st.HasInbox(ctx, "NEW1"); !ok {
		t.Error("fresh message missing")
	}
}

func TestDownloadTimesOut(t *testing.T) {
	r := newRig(t)
	g := r.ingestor(r.forwarder())
	g.DownloadTries = 1
	m := text("SLOW")
	m.Kind, m.ImageSize = transport.KindImage, 10
	m.Image = func(ctx context.Context) ([]byte, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Error("download has no deadline")
		}
		return jpeg, nil
	}
	g.Ingest(context.Background(), m)
}
