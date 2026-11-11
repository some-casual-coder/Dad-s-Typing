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
	if _, err := s.db.Exec("INSERT INTO sent_ledger VALUES('x','1','m','sent',NULL,0,1,1)"); err != nil {
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
