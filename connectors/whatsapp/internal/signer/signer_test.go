package signer

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"
	"time"
)

type vectorFile struct {
	Secret  string `json:"secret"`
	Vectors []struct {
		TS, Method, Path, Body, Signature string
	} `json:"vectors"`
}

func load(t *testing.T) vectorFile {
	t.Helper()
	b, err := os.ReadFile("../../testdata/signature_vector.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectorFile
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestVectors(t *testing.T) {
	v := load(t)
	if len(v.Vectors) == 0 {
		t.Fatal("no vectors")
	}
	for _, x := range v.Vectors {
		if got := Sign(v.Secret, x.TS, x.Method, x.Path, []byte(x.Body)); got != x.Signature {
			t.Errorf("sign %s: got %s", x.Path, got)
		}
		sec, _ := strconv.ParseInt(x.TS, 10, 64)
		now := time.Unix(sec, 0)
		if err := Verify(v.Secret, x.TS, x.Signature, x.Method, x.Path, []byte(x.Body), now); err != nil {
			t.Errorf("verify %s: %v", x.Path, err)
		}
	}
}

func TestVerifyRejects(t *testing.T) {
	v := load(t)
	x := v.Vectors[0]
	sec, _ := strconv.ParseInt(x.TS, 10, 64)
	now := time.Unix(sec, 0)
	body := []byte(x.Body)
	cases := []struct {
		name string
		err  error
		got  error
	}{
		{"tampered body", ErrBadSignature,
			Verify(v.Secret, x.TS, x.Signature, x.Method, x.Path, []byte("x"), now)},
		{"other path", ErrBadSignature,
			Verify(v.Secret, x.TS, x.Signature, x.Method, "/other", body, now)},
		{"other method", ErrBadSignature,
			Verify(v.Secret, x.TS, x.Signature, "GET", x.Path, body, now)},
		{"other secret", ErrBadSignature,
			Verify(v.Secret+"x", x.TS, x.Signature, x.Method, x.Path, body, now)},
		{"uppercase sig", ErrBadSignature,
			Verify(v.Secret, x.TS, "89A04106C78A297CD126CD2A02482514927F2EB27B99BFD9B4264E0ACC1C9219",
				x.Method, x.Path, body, now)},
		{"empty sig", ErrBadSignature,
			Verify(v.Secret, x.TS, "", x.Method, x.Path, body, now)},
		{"bad ts", ErrBadTimestamp,
			Verify(v.Secret, "abc", x.Signature, x.Method, x.Path, body, now)},
		{"old", ErrSkew,
			Verify(v.Secret, x.TS, x.Signature, x.Method, x.Path, body, now.Add(301*time.Second))},
		{"future", ErrSkew,
			Verify(v.Secret, x.TS, x.Signature, x.Method, x.Path, body, now.Add(-301*time.Second))},
	}
	for _, c := range cases {
		if c.got != c.err {
			t.Errorf("%s: got %v want %v", c.name, c.got, c.err)
		}
	}
	edge := Verify(v.Secret, x.TS, x.Signature, x.Method, x.Path, body, now.Add(300*time.Second))
	if edge != nil {
		t.Errorf("300s skew should pass: %v", edge)
	}
}

func TestHeaders(t *testing.T) {
	ts, sig := Headers("k", "post", "/p", []byte("b"), time.Unix(5, 0))
	if ts != "5" || sig != Sign("k", "5", "POST", "/p", []byte("b")) {
		t.Fatal("headers mismatch")
	}
}
