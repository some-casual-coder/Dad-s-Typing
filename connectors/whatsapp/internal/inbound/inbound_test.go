package inbound

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"hash/crc32"
	"image"
	"image/jpeg"
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

var jpegBytes = func() []byte {
	var b bytes.Buffer
	if err := jpeg.Encode(&b, image.NewRGBA(image.Rect(0, 0, 8, 8)), nil); err != nil {
		panic(err)
	}
	return b.Bytes()
}()

// pngHeader builds a PNG signature and IHDR claiming w x h.
func pngHeader(w, h uint32) []byte {
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], w)
	binary.BigEndian.PutUint32(ihdr[4:], h)
	ihdr[8], ihdr[9] = 8, 6
	var out bytes.Buffer
	out.WriteString("\x89PNG\r\n\x1a\n")
	_ = binary.Write(&out, binary.BigEndian, uint32(13))
	chunk := append([]byte("IHDR"), ihdr...)
	out.Write(chunk)
	_ = binary.Write(&out, binary.BigEndian, crc32.ChecksumIEEE(chunk))
	return out.Bytes()
}

func imgFn(data []byte, err error) func(context.Context, int64) ([]byte, error) {
	return func(context.Context, int64) ([]byte, error) { return data, err }
}

func text(id string) transport.Message {
	return transport.Message{ID: id, ChatServer: "s.whatsapp.net",
		Sender: "254712345678", Kind: transport.KindText, Text: "hi",
		Timestamp: time.Unix(1700000000, 0)}
}

func imageMsg(id string, size int64, fn func(context.Context, int64) ([]byte, error)) transport.Message {
	m := text(id)
	m.Kind, m.ImageSize, m.Image = transport.KindImage, size, fn
	return m
}

func TestFilter(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*transport.Message)
		want string
	}{
		{"ok text", func(*transport.Message) {}, ""},
		{"ok image", func(m *transport.Message) { *m = imageMsg("ID1", 100, imgFn(jpegBytes, nil)) }, ""},
		{"ok lid chat", func(m *transport.Message) { m.ChatServer = "lid" }, ""},
		{"group", func(m *transport.Message) { m.IsGroup, m.ChatServer = true, "g.us" }, DropGroup},
		{"status", func(m *transport.Message) { m.ChatServer = "broadcast" }, DropServer},
		{"newsletter", func(m *transport.Message) { m.ChatServer = "newsletter" }, DropServer},
		{"self", func(m *transport.Message) { m.FromMe = true }, DropSelf},
		{"edit", func(m *transport.Message) { m.Kind = transport.KindEdit }, DropKind},
		{"reaction", func(m *transport.Message) { m.Kind = transport.KindReaction }, DropKind},
		{"video etc", func(m *transport.Message) { m.Kind = transport.KindMedia }, DropKind},
		{"other", func(m *transport.Message) { m.Kind = transport.KindOther }, DropKind},
		{"oversize image", func(m *transport.Message) { *m = imageMsg("ID1", MaxImageBytes+1, imgFn(nil, nil)) }, DropOversize},
		{"image at limit", func(m *transport.Message) { *m = imageMsg("ID1", MaxImageBytes, imgFn(nil, nil)) }, ""},
		{"zero size image", func(m *transport.Message) { *m = imageMsg("ID1", 0, imgFn(nil, nil)) }, DropBadSize},
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

func TestCheckImage(t *testing.T) {
	cases := []struct {
		name string
		data []byte
		ok   bool
	}{
		{"jpeg", jpegBytes, true},
		{"png small", pngHeader(100, 100), true},
		{"png 12000 wide", pngHeader(12000, 10), true},
		{"png too wide", pngHeader(12001, 10), false},
		{"png too tall", pngHeader(10, 12001), false},
		{"png over 40MP", pngHeader(8000, 5001), false},
		{"png at 40MP", pngHeader(8000, 5000), true},
		{"png zero", pngHeader(0, 10), false},
		{"magic only", append([]byte{0xFF, 0xD8, 0xFF, 0xE0}, 1, 2, 3), false},
		{"html", []byte("<html>"), false},
		{"gif", []byte("GIF89a\x01\x00\x01\x00"), false},
		{"empty", nil, false},
	}
	for _, c := range cases {
		if _, ok := CheckImage(c.data); ok != c.ok {
			t.Errorf("%s: ok=%v want %v", c.name, ok, c.ok)
		}
	}
}

func TestSniffImage(t *testing.T) {
	png := append([]byte("\x89PNG\r\n\x1a\n"), 0, 0)
	webp := []byte("RIFF\x00\x00\x00\x00WEBPVP8 ")
	for b, want := range map[string]string{
		string(jpegBytes): "image/jpeg", string(png): "image/png",
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
		Store: r.st, Post: tsapp.New(r.ts.URL, tstest.Secret, "whatsapp"),
		Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: time.Now,
		BaseDelay: time.Millisecond, MaxDelay: 5 * time.Millisecond,
		FailedRetry: 5 * time.Millisecond, PollEvery: 5 * time.Millisecond,
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
	for i := 0; i < 400; i++ {
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

const sender = "254712345678"

func state(t *testing.T, r *rig, id string) (string, int) {
	t.Helper()
	st, n, err := r.st.InboxState(context.Background(), sender, id)
	if err != nil {
		t.Fatal(err)
	}
	return st, n
}

func TestPersistBeforeForwardAndResumeAfterRestart(t *testing.T) {
	ctx := context.Background()
	r := newRig(t)
	r.ts.FailInbound = 100
	f := r.forwarder()
	r.ingestor(f).Ingest(ctx, text("MSG1"))

	if st, _ := state(t, r, "MSG1"); st != store.InboxReceived {
		t.Fatalf("state %q", st)
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
	r.ingestor(f2).Ingest(ctx, text("MSG1"))
	drain(t, f2, ctx)
	if got := r.ts.Accepted["MSG1"]; got != 1 {
		t.Fatalf("duplicate post: %d", got)
	}
	if st, _ := state(t, r, "MSG1"); st != store.InboxForwarded {
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
	m := imageMsg("IMG1", int64(len(jpegBytes)), imgFn(jpegBytes, nil))
	m.Text = "cap"
	r.ingestor(f).Ingest(ctx, m)
	drain(t, f, ctx)
	p := r.ts.Last[0]
	if p.Sender != sender || p.Text != "cap" || p.Image == nil ||
		p.Image.Mime != "image/jpeg" || p.ReceivedAt != "2023-11-14T22:13:20Z" {
		t.Fatalf("payload %+v", p)
	}
	raw, _ := base64.StdEncoding.DecodeString(p.Image.Base64)
	if !bytes.Equal(raw, jpegBytes) {
		t.Fatal("image bytes differ")
	}
}

func TestBadMediaDropped(t *testing.T) {
	ctx := context.Background()
	r := newRig(t)
	g := r.ingestor(r.forwarder())
	cases := map[string]transport.Message{
		"html":      imageMsg("B1", 10, imgFn([]byte("<html>not an image"), nil)),
		"magic":     imageMsg("B2", 10, imgFn([]byte{0xFF, 0xD8, 0xFF, 1, 2}, nil)),
		"huge dims": imageMsg("B3", 50, imgFn(pngHeader(20000, 20000), nil)),
		"too large": imageMsg("B4", 50, imgFn(nil, transport.ErrTooLarge)),
		"zero":      imageMsg("B5", 0, imgFn(jpegBytes, nil)),
	}
	for name, m := range cases {
		g.Ingest(ctx, m)
		if ok, _ := r.st.HasInbox(ctx, sender, m.ID); ok {
			t.Errorf("%s stored", name)
		}
	}
	if ok, _ := r.st.IsKnownSender(ctx, sender); ok {
		t.Error("sender known after only dropped media")
	}
}

func TestOutageNeverBecomesPermanent(t *testing.T) {
	ctx := context.Background()
	r := newRig(t)
	f := r.forwarder()
	r.ingestor(f).Ingest(ctx, text("DOWN"))
	for _, code := range []int{500, 401, 403, 404, 503} {
		r.ts.Lock()
		r.ts.InboundCode = code
		r.ts.Unlock()
		for i := 0; i < 5; i++ {
			time.Sleep(6 * time.Millisecond)
			if _, err := f.Step(ctx); err != nil {
				t.Fatal(err)
			}
		}
		if st, _ := state(t, r, "DOWN"); st != store.InboxReceived {
			t.Fatalf("code %d: state %s", code, st)
		}
	}
	if st, n := state(t, r, "DOWN"); n < 20 || st != store.InboxReceived {
		t.Fatalf("attempts %d state %s", n, st)
	}
	r.ts.Lock()
	r.ts.InboundCode = 0
	r.ts.Unlock()
	drain(t, f, ctx)
	if r.ts.Accepted["DOWN"] != 1 {
		t.Fatal("not delivered after recovery")
	}
}

func TestPermanentRejectKeepsPayloadAndRetriesSlowly(t *testing.T) {
	ctx := context.Background()
	r := newRig(t)
	f := r.forwarder()
	r.ts.InboundCode = 422
	r.ingestor(f).Ingest(ctx, text("BAD"))
	if _, err := f.Step(ctx); err != nil {
		t.Fatal(err)
	}
	if st, _ := state(t, r, "BAD"); st != store.InboxFailed {
		t.Fatalf("state %s", st)
	}
	if n, _ := r.st.FailedInbox(ctx); n != 1 {
		t.Fatalf("failed count %d", n)
	}
	// App is fixed; the failed row is retried on its slow schedule.
	r.ts.Lock()
	r.ts.InboundCode = 0
	r.ts.Unlock()
	time.Sleep(10 * time.Millisecond)
	if worked, _ := f.Step(ctx); !worked {
		t.Fatal("failed row not retried")
	}
	if r.ts.Accepted["BAD"] != 1 || r.ts.Last[0].Text != "hi" {
		t.Fatal("payload lost or not delivered")
	}
	if n, _ := r.st.FailedInbox(ctx); n != 0 {
		t.Fatalf("failed count %d", n)
	}
}

func TestDedupeKeyIsSenderAndProviderID(t *testing.T) {
	ctx := context.Background()
	r := newRig(t)
	g := r.ingestor(r.forwarder())
	a, b := text("SAME"), text("SAME")
	b.Sender = "254700000002"
	g.Ingest(ctx, a)
	g.Ingest(ctx, b)
	g.Ingest(ctx, a)
	if n, _ := r.st.PendingInbox(ctx); n != 2 {
		t.Fatalf("pending %d", n)
	}
}

func TestKnownSenderRecordedAndForgottenWhenIgnored(t *testing.T) {
	ctx := context.Background()
	r := newRig(t)
	f := r.forwarder()
	r.ingestor(f).Ingest(ctx, text("K1"))
	if ok, _ := r.st.IsKnownSender(ctx, sender); !ok {
		t.Fatal("sender not recorded")
	}
	if ok, _ := r.st.IsKnownSender(ctx, "254700000009"); ok {
		t.Fatal("unseen number known")
	}
	r.ts.Ignore = true
	drain(t, f, ctx)
	if ok, _ := r.st.IsKnownSender(ctx, sender); ok {
		t.Fatal("ignored sender still known")
	}
}

func TestAllowedSendersPrefilterBeforeDownloadOrWrite(t *testing.T) {
	ctx := context.Background()
	r := newRig(t)
	g := r.ingestor(r.forwarder())
	g.Allowed = map[string]struct{}{"254700000001": {}}
	called := false
	m := imageMsg("A1", 10, func(context.Context, int64) ([]byte, error) {
		called = true
		return jpegBytes, nil
	})
	g.Ingest(ctx, m)
	if called {
		t.Fatal("downloaded media for a disallowed sender")
	}
	if ok, _ := r.st.HasInbox(ctx, sender, "A1"); ok {
		t.Fatal("persisted a disallowed sender")
	}
	if ok, _ := r.st.IsKnownSender(ctx, sender); ok {
		t.Fatal("disallowed sender became known")
	}
	ok := text("A2")
	ok.Sender = "254700000001"
	g.Ingest(ctx, ok)
	if has, _ := r.st.HasInbox(ctx, "254700000001", "A2"); !has {
		t.Fatal("allowed sender dropped")
	}
}

func TestStaleDroppedAndFreshKept(t *testing.T) {
	ctx := context.Background()
	r := newRig(t)
	g := r.ingestor(r.forwarder())
	g.MaxAge = time.Hour
	old := text("OLD1")
	old.Timestamp = time.Now().Add(-2 * time.Hour)
	fresh := text("NEW1")
	fresh.Timestamp = time.Now()
	g.Ingest(ctx, old)
	g.Ingest(ctx, fresh)
	if ok, _ := r.st.HasInbox(ctx, sender, "OLD1"); ok {
		t.Error("stale message stored")
	}
	if ok, _ := r.st.HasInbox(ctx, sender, "NEW1"); !ok {
		t.Error("fresh message missing")
	}
}

func TestDownloadHasDeadlineAndCap(t *testing.T) {
	r := newRig(t)
	g := r.ingestor(r.forwarder())
	g.DownloadTries = 1
	m := imageMsg("SLOW", 10, func(ctx context.Context, max int64) ([]byte, error) {
		if _, ok := ctx.Deadline(); !ok {
			t.Error("download has no deadline")
		}
		if max != MaxImageBytes {
			t.Errorf("cap %d", max)
		}
		return jpegBytes, nil
	})
	g.Ingest(context.Background(), m)
}
