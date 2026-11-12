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

const (
	ForwardedTTL = 72 * time.Hour
	FailedTTL    = 7 * 24 * time.Hour
	LedgerTTL    = 7 * 24 * time.Hour
	KnownTTL     = 30 * 24 * time.Hour
)

const schema = `
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY,
  provider_id TEXT NOT NULL,
  sender TEXT NOT NULL,
  text TEXT,
  image_mime TEXT,
  image_b64 TEXT,
  received_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  last_error TEXT,
  settled_at INTEGER,
  UNIQUE (sender, provider_id)
);
CREATE INDEX IF NOT EXISTS idx_inbox_due ON inbox (state, next_attempt_at);
CREATE TABLE IF NOT EXISTS known_senders (
  sender TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sent_ledger (
  outbox_id TEXT PRIMARY KEY,
  recipient TEXT NOT NULL,
  client_msg_id TEXT NOT NULL,
  state TEXT NOT NULL,
  error TEXT,
  acked INTEGER NOT NULL DEFAULT 0,
  ack_attempts INTEGER NOT NULL DEFAULT 0,
  next_ack_at INTEGER NOT NULL DEFAULT 0,
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
	if err := addExtra(db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return &Store{db: db}, nil
}

// addExtra adds the pin/contact column to stores created before it existed.
func addExtra(db *sql.DB) error {
	var n int
	if err := db.QueryRow(`SELECT count(*) FROM pragma_table_info('inbox') WHERE name='extra'`).Scan(&n); err != nil {
		return err
	}
	if n > 0 {
		return nil
	}
	_, err := db.Exec(`ALTER TABLE inbox ADD COLUMN extra TEXT`)
	return err
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
	// JSON for a pin or contact card; cleared once forwarded
	Extra      string
	ReceivedAt time.Time
	Attempts   int
}

// InsertInbox stores a message and marks its sender known in one transaction;
// false means (sender, provider id) already exists.
func (s *Store) InsertInbox(ctx context.Context, m InboxMsg, now time.Time) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO inbox
	  (provider_id, sender, text, image_mime, image_b64, extra, received_at,
	   state, next_attempt_at)
	  VALUES (?,?,?,?,?,?,?,?,?)`,
		m.ProviderID, m.Sender, nullable(m.Text), nullable(m.ImageMime),
		nullable(m.ImageB64), nullable(m.Extra), ms(m.ReceivedAt), InboxReceived, ms(now))
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO known_senders
	  (sender, first_seen, last_seen) VALUES (?,?,?)
	  ON CONFLICT(sender) DO UPDATE SET last_seen=excluded.last_seen`,
		m.Sender, ms(now), ms(now)); err != nil {
		return false, err
	}
	return n == 1, tx.Commit()
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func (s *Store) HasInbox(ctx context.Context, sender, providerID string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx,
		`SELECT 1 FROM inbox WHERE sender=? AND provider_id=?`,
		sender, providerID).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) IsKnownSender(ctx context.Context, sender string) (bool, error) {
	var one int
	err := s.db.QueryRowContext(ctx,
		`SELECT 1 FROM known_senders WHERE sender=?`, sender).Scan(&one)
	if err == sql.ErrNoRows {
		return false, nil
	}
	return err == nil, err
}

func (s *Store) ForgetSender(ctx context.Context, sender string) error {
	_, err := s.db.ExecContext(ctx,
		`DELETE FROM known_senders WHERE sender=?`, sender)
	return err
}

// NextDue returns the oldest due row (received, or failed on its slow retry).
func (s *Store) NextDue(ctx context.Context, now time.Time) (*InboxMsg, error) {
	var m InboxMsg
	var text, mime, b64, extra sql.NullString
	var rec int64
	err := s.db.QueryRowContext(ctx, `SELECT id, provider_id, sender, text,
	  image_mime, image_b64, extra, received_at, attempts FROM inbox
	  WHERE state IN (?,?) AND next_attempt_at<=?
	  ORDER BY next_attempt_at, id LIMIT 1`,
		InboxReceived, InboxFailed, ms(now)).Scan(&m.ID, &m.ProviderID,
		&m.Sender, &text, &mime, &b64, &extra, &rec, &m.Attempts)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	m.Text, m.ImageMime, m.ImageB64, m.Extra = text.String, mime.String, b64.String, extra.String
	m.ReceivedAt = time.UnixMilli(rec).UTC()
	return &m, nil
}

// NextInboxAt returns when the next retryable row is due, if any.
func (s *Store) NextInboxAt(ctx context.Context) (time.Time, bool, error) {
	var at sql.NullInt64
	err := s.db.QueryRowContext(ctx,
		`SELECT MIN(next_attempt_at) FROM inbox WHERE state IN (?,?)`,
		InboxReceived, InboxFailed).Scan(&at)
	if err != nil || !at.Valid {
		return time.Time{}, false, err
	}
	return time.UnixMilli(at.Int64), true, nil
}

// MarkForwarded drops the payload; the app owns it from here.
func (s *Store) MarkForwarded(ctx context.Context, id int64, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE inbox SET state=?, text=NULL,
	  image_b64=NULL, image_mime=NULL, extra=NULL, last_error=NULL, settled_at=?
	  WHERE id=?`, InboxForwarded, ms(now), id)
	return err
}

func (s *Store) Reschedule(ctx context.Context, id int64, attempts int,
	next time.Time, code string) error {
	_, err := s.db.ExecContext(ctx, `UPDATE inbox SET attempts=?,
	  next_attempt_at=?, last_error=? WHERE id=?`, attempts, ms(next), code, id)
	return err
}

// MarkInboxFailed keeps the payload and schedules a slow retry.
func (s *Store) MarkInboxFailed(ctx context.Context, id int64, attempts int,
	next time.Time, code string, now time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE inbox SET state=?, attempts=?,
	  next_attempt_at=?, last_error=?, settled_at=COALESCE(settled_at, ?)
	  WHERE id=?`, InboxFailed, attempts, ms(next), code, ms(now), id)
	return err
}

func (s *Store) PendingInbox(ctx context.Context) (n int, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM inbox WHERE state=?`, InboxReceived).Scan(&n)
	return
}

func (s *Store) FailedInbox(ctx context.Context) (n int, err error) {
	err = s.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM inbox WHERE state=?`, InboxFailed).Scan(&n)
	return
}

func (s *Store) InboxState(ctx context.Context, sender, providerID string) (string, int, error) {
	var st string
	var n int
	err := s.db.QueryRowContext(ctx,
		`SELECT state, attempts FROM inbox WHERE sender=? AND provider_id=?`,
		sender, providerID).Scan(&st, &n)
	return st, n, err
}

// Purged counts rows removed by one retention pass.
type Purged struct{ Forwarded, Failed, Ledger, Known int64 }

// Purge applies the retention windows; failed rows are only removed past
// their TTL and unacked ledger rows are never removed.
func (s *Store) Purge(ctx context.Context, now time.Time) (Purged, error) {
	var p Purged
	run := func(dst *int64, q string, args ...any) error {
		res, err := s.db.ExecContext(ctx, q, args...)
		if err != nil {
			return err
		}
		*dst, err = res.RowsAffected()
		return err
	}
	if err := run(&p.Forwarded, `DELETE FROM inbox WHERE state=? AND
	  settled_at<?`, InboxForwarded, ms(now.Add(-ForwardedTTL))); err != nil {
		return p, err
	}
	if err := run(&p.Failed, `DELETE FROM inbox WHERE state=? AND
	  settled_at<?`, InboxFailed, ms(now.Add(-FailedTTL))); err != nil {
		return p, err
	}
	if err := run(&p.Ledger, `DELETE FROM sent_ledger WHERE acked=1 AND
	  updated_at<?`, ms(now.Add(-LedgerTTL))); err != nil {
		return p, err
	}
	err := run(&p.Known, `DELETE FROM known_senders WHERE last_seen<?`,
		ms(now.Add(-KnownTTL)))
	return p, err
}

type Ledger struct {
	OutboxID    string
	Recipient   string
	ClientMsgID string
	State       string
	Error       string
	Acked       bool
	AckAttempts int
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
	  client_msg_id, state, error, acked, ack_attempts FROM sent_ledger
	  WHERE outbox_id=?`, outboxID).Scan(&l.OutboxID, &l.Recipient,
		&l.ClientMsgID, &l.State, &e, &acked, &l.AckAttempts)
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

// AckFailed schedules the next ack retry for a settled ledger row.
func (s *Store) AckFailed(ctx context.Context, outboxID string, attempts int,
	next time.Time) error {
	_, err := s.db.ExecContext(ctx, `UPDATE sent_ledger SET ack_attempts=?,
	  next_ack_at=? WHERE outbox_id=?`, attempts, ms(next), outboxID)
	return err
}

// DueAcks lists settled rows whose ack is still owed and due for a retry.
func (s *Store) DueAcks(ctx context.Context, now time.Time, limit int) ([]Ledger, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT outbox_id, recipient,
	  client_msg_id, state, error, ack_attempts FROM sent_ledger
	  WHERE acked=0 AND state<>? AND next_ack_at<=?
	  ORDER BY next_ack_at LIMIT ?`, LedgerDispatching, ms(now), limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Ledger
	for rows.Next() {
		var l Ledger
		var e sql.NullString
		if err := rows.Scan(&l.OutboxID, &l.Recipient, &l.ClientMsgID,
			&l.State, &e, &l.AckAttempts); err != nil {
			return nil, err
		}
		l.Error = e.String
		out = append(out, l)
	}
	return out, rows.Err()
}
