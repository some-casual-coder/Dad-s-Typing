package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPrepareAndOpenPermissions(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "data")
	if err := Prepare(dir, "connector.db", "session.db"); err != nil {
		t.Fatal(err)
	}
	s, err := Open(filepath.Join(dir, "connector.db"))
	if err != nil {
		t.Fatal(err)
	}
	var mode string
	if err := s.db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal %q %v", mode, err)
	}
	if _, err := s.db.Exec("INSERT INTO sent_ledger (outbox_id, recipient, client_msg_id, state, created_at, updated_at) VALUES('x','1','m','sent',1,1)"); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Stat(dir); fi.Mode().Perm() != 0o700 {
		t.Fatalf("dir %v", fi.Mode().Perm())
	}
	ents, _ := os.ReadDir(dir)
	for _, e := range ents {
		fi, _ := e.Info()
		if fi.Mode().Perm() != 0o600 {
			t.Errorf("%s %v", e.Name(), fi.Mode().Perm())
		}
	}
	_ = s.Close()
}

func TestExpireDispatching(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "c.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	now := time.Now()
	_, _ = s.BeginDispatch(ctx, "a", "1", "m", now)
	_, _ = s.BeginDispatch(ctx, "b", "1", "m", now)
	_ = s.SetLedger(ctx, "b", LedgerSent, "", now)
	n, err := s.ExpireDispatching(ctx, now)
	if err != nil || n != 1 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	if l, _ := s.GetLedger(ctx, "a"); l.State != LedgerUnknown {
		t.Fatalf("a=%s", l.State)
	}
	if l, _ := s.GetLedger(ctx, "b"); l.State != LedgerSent {
		t.Fatalf("b=%s", l.State)
	}
}

func TestPurgeRetention(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "c.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	now := time.Now()
	old := now.Add(-31 * 24 * time.Hour)
	ins := func(id, sender string, at time.Time) int64 {
		_, err := s.InsertInbox(ctx, InboxMsg{ProviderID: id, Sender: sender,
			Text: "t", ReceivedAt: at}, at)
		if err != nil {
			t.Fatal(err)
		}
		m, _ := s.NextDue(ctx, now)
		return m.ID
	}
	fwdOld := ins("f-old", "111111", old)
	_ = s.MarkForwarded(ctx, fwdOld, old)
	fwdNew := ins("f-new", "222222", now)
	_ = s.MarkForwarded(ctx, fwdNew, now)
	failOld := ins("x-old", "333333", old)
	_ = s.MarkInboxFailed(ctx, failOld, 1, now, "http 422", old)
	failNew := ins("x-new", "444444", now)
	_ = s.MarkInboxFailed(ctx, failNew, 1, now, "http 422", now)
	pending := ins("p", "555555", old)
	_ = pending

	for _, c := range []struct{ id, st string }{{"o1", LedgerSent}, {"o2", LedgerSent}, {"o3", LedgerSent}} {
		_, _ = s.BeginDispatch(ctx, c.id, "111111", "m", old)
		_ = s.SetLedger(ctx, c.id, c.st, "", old)
	}
	_ = s.MarkAcked(ctx, "o1")
	_ = s.MarkAcked(ctx, "o2")
	_, _ = s.BeginDispatch(ctx, "o4", "111111", "m", now)
	_ = s.SetLedger(ctx, "o4", LedgerSent, "", now)
	_ = s.MarkAcked(ctx, "o4")

	p, err := s.Purge(ctx, now)
	if err != nil {
		t.Fatal(err)
	}
	if p.Forwarded != 1 || p.Failed != 1 || p.Ledger != 2 {
		t.Fatalf("purged %+v", p)
	}
	has := func(sender, id string) bool {
		ok, _ := s.HasInbox(ctx, sender, id)
		return ok
	}
	if has("111111", "f-old") || !has("222222", "f-new") || has("333333", "x-old") ||
		!has("444444", "x-new") || !has("555555", "p") {
		t.Fatal("wrong inbox rows purged")
	}
	if l, _ := s.GetLedger(ctx, "o3"); l == nil {
		t.Fatal("unacked ledger row purged")
	}
	if l, _ := s.GetLedger(ctx, "o1"); l != nil {
		t.Fatal("old acked ledger row kept")
	}
	if l, _ := s.GetLedger(ctx, "o4"); l == nil {
		t.Fatal("recent acked ledger row purged")
	}
	if ok, _ := s.IsKnownSender(ctx, "111111"); ok {
		t.Fatal("idle sender kept past TTL")
	}
	if ok, _ := s.IsKnownSender(ctx, "222222"); !ok {
		t.Fatal("recent sender purged")
	}
}

func TestForwardedRowDropsPayload(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "c.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	ctx := context.Background()
	_, _ = s.InsertInbox(ctx, InboxMsg{ProviderID: "a", Sender: "111111", Text: "secret",
		ImageMime: "image/png", ImageB64: "AAAA", ReceivedAt: time.Now()}, time.Now())
	m, _ := s.NextDue(ctx, time.Now())
	_ = s.MarkForwarded(ctx, m.ID, time.Now())
	var text, img *string
	_ = s.db.QueryRow("SELECT text, image_b64 FROM inbox").Scan(&text, &img)
	if text != nil || img != nil {
		t.Fatal("payload retained after forward")
	}
}

func TestOpenIsIdempotent(t *testing.T) {
	p := filepath.Join(t.TempDir(), "c.db")
	for i := 0; i < 2; i++ {
		s, err := Open(p)
		if err != nil {
			t.Fatal(err)
		}
		_ = s.Close()
	}
}
