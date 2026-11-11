package store

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

const (
	InboxReceived  = "received"
	InboxForwarded = "forwarded"
	InboxFailed    = "failed"

	LedgerDispatching = "dispatching"
	LedgerSent        = "sent"
	LedgerUnknown     = "unknown"
	LedgerFailed      = "failed"
)

const schema = `
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY,
  provider_id TEXT NOT NULL UNIQUE,
  sender TEXT NOT NULL,
  text TEXT,
  image_mime TEXT,
  image_b64 TEXT,
  received_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_inbox_due ON inbox (state, next_attempt_at);
CREATE TABLE IF NOT EXISTS sent_ledger (
  outbox_id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  client_msg_id TEXT NOT NULL,
  state TEXT NOT NULL,
  error TEXT,
  acked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ledger_recipient
  ON sent_ledger (recipient, created_at);
`

type Store struct{ db *sql.DB }

// Prepare creates dir 0700 and an empty file 0600 so SQLite inherits modes.
func Prepare(dir string, files ...string) error {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return err
	}
	for _, f := range files {
		h, err := os.OpenFile(filepath.Join(dir, f), os.O_CREATE|os.O_RDWR, 0o600)
		if err != nil {
			return err
		}
		if err := h.Close(); err != nil {
			return err
		}
		if err := os.Chmod(filepath.Join(dir, f), 0o600); err != nil {
			return err
		}
	}
	return nil
}

func DSN(path string) string {
	return fmt.Sprintf(
		"file:%s?_foreign_keys=on&_busy_timeout=5000&_journal_mode=WAL", path)
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite3", DSN(path))
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func ms(t time.Time) int64 { return t.UnixMilli() }

type InboxMsg struct {
	ID         int64
	ProviderID string
	Sender     string
	Text       string
	ImageMime  string
	ImageB64   string
	ReceivedAt time.Time
	Attempts   int
}

// InsertInbox stores a message; false means the provider id already exists.
func (s *Store) InsertInbox(ctx context.Context, m InboxMsg, now time.Time) (bool, error) {
	res, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO inbox
	  (provider_id, sender, text, image_mime, image_b64, received_at,
	   state, next_attempt_at)
	  VALUES (?,?,?,?,?,?,?,?)`,
		m.ProviderID, m.Sender, nullable(m.Text), nullable(m.ImageMime),
		nullable(m.ImageB64), ms(m.ReceivedAt), InboxReceived, ms(now))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (s *Store) HasInbox(ctx context.Context, providerID string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx,
		`SELECT 1 FROM inbox WHERE provider_id=?`, providerID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

// NextDue returns the oldest unforwarded row that is due, or nil.
func (s *Store) NextDue(ctx context.Context, now time.Time) (*InboxMsg, error) {
	var m InboxMsg
	var text, mime, b64 sql.NullString
	var rec int64
	err := s.db.QueryRowContext(ctx, `SELECT id, provider_id, sender, text,
	  image_mime, image_b64, received_at, attempts FROM inbox
	  WHERE state=? AND next_attempt_at<=? ORDER BY next_attempt_at, id LIMIT 1`,
		InboxReceived, ms(now)).Scan(&m.ID, &m.ProviderID, &m.Sender, &text,
		&mime, &b64, &rec, &m.Attempts)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	m.Text, m.ImageMime, m.ImageB64 = text.String, mime.String, b64.String
	m.ReceivedAt = time.UnixMilli(rec).UTC()
	return &m, nil
}

// NextInboxAt returns when the next pending row is due, if any.
func (s *Store) NextInboxAt(ctx context.Context) (time.Time, bool, error) {
	var at sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		`SELECT MIN(next_attempt_at) FROM inbox WHERE state=?`,
		InboxReceived).Scan(&at)
	if err != nil || !at.Valid {
		return time.Time{}, false, err
	}
	return time.UnixMilli(at.Int64), true, nil
}

// MarkForwarded also drops the payload; the app owns it from here.
func (s *Store) MarkForwarded(ctx context.Context, id int64) error {
	_, err := s.db.ExecContext(ctx, `UPDATE inbox SET state=?, text=NULL,
	  image_b64=NULL, image_mime=NULL, last_error=NULL WHERE id=?`,
		InboxForwarded, id)
	return err
}

func (s *Store) Reschedule(ctx context.Context, id int64, attempts int,
	next time.Time, code string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE inbox SET attempts=?,
	  next_attempt_at=?, last_error=? WHERE id=?`, attempts, ms(next), code, id)
	return err
}

func (s *Store) MarkInboxFailed(ctx context.Context, id int64, attempts int,
	code string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE inbox SET state=?, attempts=?,
	  last_error=?, text=NULL, image_b64=NULL WHERE id=?`,
		InboxFailed, attempts, code, id)
	return err
}

func (s *Store) PendingInbox(ctx context.Context) (n int, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM inbox WHERE state=?`, InboxReceived).Scan(&n)
	return
}

func (s *Store) InboxState(ctx context.Context, providerID string) (string, int, error) {
	var st string
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT state, attempts FROM inbox WHERE provider_id=?`,
		providerID).Scan(&st, &n)
	return st, n, err
}

type Ledger struct {
	OutboxID    string
	Recipient   string
	ClientMsgID string
	State       string
	Error       string
	Acked       bool
}

// BeginDispatch records intent to send; false means a row already exists.
func (s *Store) BeginDispatch(ctx context.Context, outboxID, recipient,
	clientMsgID string, now time.Time) (bool, error) {
	res, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO sent_ledger
	  (outbox_id, recipient, client_msg_id, state, created_at, updated_at)
	  VALUES (?,?,?,?,?,?)`, outboxID, recipient, clientMsgID,
		LedgerDispatching, ms(now), ms(now))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}

func (s *Store) GetLedger(ctx context.Context, outboxID string) (*Ledger, error) {
	var l Ledger
	var e sql.NullString
	var acked int
	err := s.db.QueryRowContext(ctx, `SELECT outbox_id, recipient,
	  client_msg_id, state, error, acked FROM sent_ledger WHERE outbox_id=?`,
		outboxID).Scan(&l.OutboxID, &l.Recipient, &l.ClientMsgID, &l.State,
		&e, &acked)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	l.Error, l.Acked = e.String, acked == 1
	return &l, nil
}

func (s *Store) SetLedger(ctx context.Context, outboxID, state, code string,
	now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE sent_ledger SET state=?, error=?,
	  updated_at=? WHERE outbox_id=?`, state, nullable(code), ms(now), outboxID)
	return err
}

// DropLedger removes a dispatching row for a send that never left.
func (s *Store) DropLedger(ctx context.Context, outboxID string) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM sent_ledger WHERE outbox_id=? AND state=?`,
		outboxID, LedgerDispatching)
	return err
}

// ExpireDispatching turns rows left mid-send by a crash into unknown.
func (s *Store) ExpireDispatching(ctx context.Context, now time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE sent_ledger SET state=?,
	  error='interrupted', updated_at=? WHERE state=?`,
		LedgerUnknown, ms(now), LedgerDispatching)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *Store) MarkAcked(ctx context.Context, outboxID string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE sent_ledger SET acked=1 WHERE outbox_id=?`, outboxID)
	return err
}

// RecentSends counts attempted dispatches to a recipient since a time.
func (s *Store) RecentSends(ctx context.Context, recipient string,
	since time.Time) (n int, err error) {
	err = s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM sent_ledger
	  WHERE recipient=? AND created_at>=? AND state IN (?,?,?)`, recipient,
		ms(since), LedgerSent, LedgerUnknown, LedgerDispatching).Scan(&n)
	return
}

func (s *Store) PendingAcks(ctx context.Context) (n int, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM sent_ledger WHERE acked=0`).Scan(&n)
	return
}
