package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHealthzProbe(t *testing.T) {
	code := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" || r.URL.Path != "/healthz" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		w.WriteHeader(code)
	}))
	defer srv.Close()
	t.Setenv("ADMIN_ADDR", strings.TrimPrefix(srv.URL, "http://"))
	t.Setenv("ADMIN_TOKEN", "tok")
	if healthz() != 0 {
		t.Fatal("healthy probe failed")
	}
	code = http.StatusServiceUnavailable
	if healthz() != 1 {
		t.Fatal("unready probe passed")
	}
	t.Setenv("ADMIN_TOKEN", "bad")
	code = http.StatusOK
	if healthz() != 1 {
		t.Fatal("bad token passed")
	}
	srv.Close()
	if healthz() != 1 {
		t.Fatal("unreachable passed")
	}
}
