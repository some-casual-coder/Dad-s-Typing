package signer

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"strconv"
	"strings"
	"time"
)

const (
	HeaderTimestamp = "X-DT-Timestamp"
	HeaderSignature = "X-DT-Signature"
	MaxSkew         = 300 * time.Second
)

var (
	ErrBadTimestamp = errors.New("bad timestamp")
	ErrSkew         = errors.New("timestamp outside allowed skew")
	ErrBadSignature = errors.New("bad signature")
)

// Sign returns lowercase hex HMAC-SHA256 of ts, method, path and body.
func Sign(secret, ts, method, path string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(ts + "\n" + strings.ToUpper(method) + "\n" + path + "\n"))
	mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}

// Headers returns the timestamp and signature for one outgoing request.
func Headers(secret, method, path string, body []byte, now time.Time) (string, string) {
	ts := strconv.FormatInt(now.Unix(), 10)
	return ts, Sign(secret, ts, method, path, body)
}

func Verify(secret, ts, sig, method, path string, body []byte, now time.Time) error {
	sec, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return ErrBadTimestamp
	}
	d := now.Sub(time.Unix(sec, 0))
	if d < 0 {
		d = -d
	}
	if d > MaxSkew {
		return ErrSkew
	}
	want := Sign(secret, ts, method, path, body)
	if subtle.ConstantTimeCompare([]byte(want), []byte(sig)) != 1 {
		return ErrBadSignature
	}
	return nil
}
