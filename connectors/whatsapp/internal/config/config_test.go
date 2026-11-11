package config

import (
	"strings"
	"testing"
)

const good = "0123456789abcdef0123456789abcdef"

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func base() map[string]string {
	return map[string]string{
		"TS_BASE_URL": "https://app.example.com/", "DATA_DIR": "/data",
		"WHATSAPP_BRIDGE_SECRET": good, "ADMIN_TOKEN": good + "x",
	}
}

func TestLoadDefaults(t *testing.T) {
	c, err := Load(env(base()))
	if err != nil {
		t.Fatal(err)
	}
	if c.AdminAddr != "127.0.0.1:8091" || c.TSBaseURL != "https://app.example.com" {
		t.Fatalf("unexpected %+v", c)
	}
}

func TestLoadFailsFast(t *testing.T) {
	cases := map[string]func(map[string]string){
		"TS_BASE_URL":            func(m map[string]string) { delete(m, "TS_BASE_URL") },
		"TS_BASE_URL path":       func(m map[string]string) { m["TS_BASE_URL"] = "http://a/x" },
		"TS_BASE_URL scheme":     func(m map[string]string) { m["TS_BASE_URL"] = "ftp://a" },
		"DATA_DIR":               func(m map[string]string) { delete(m, "DATA_DIR") },
		"WHATSAPP_BRIDGE_SECRET": func(m map[string]string) { m["WHATSAPP_BRIDGE_SECRET"] = "short" },
		"ADMIN_TOKEN":            func(m map[string]string) { m["ADMIN_TOKEN"] = good[:31] },
		"ADMIN_ADDR":             func(m map[string]string) { m["ADMIN_ADDR"] = "0.0.0.0:8091" },
	}
	for name, mut := range cases {
		m := base()
		mut(m)
		_, err := Load(env(m))
		if err == nil {
			t.Errorf("%s: expected error", name)
			continue
		}
		if strings.Contains(err.Error(), good) {
			t.Errorf("%s: error leaks secret", name)
		}
	}
}

func TestAdminAddrLoopbackForms(t *testing.T) {
	for _, a := range []string{"127.0.0.1:1", "localhost:1", "[::1]:1"} {
		m := base()
		m["ADMIN_ADDR"] = a
		if _, err := Load(env(m)); err != nil {
			t.Errorf("%s: %v", a, err)
		}
	}
}

func TestHTTPSRequiredUnlessLoopbackOrOptIn(t *testing.T) {
	for _, u := range []string{"http://127.0.0.1:3000", "http://localhost:3000",
		"http://[::1]:3000", "https://app.example.com"} {
		m := base()
		m["TS_BASE_URL"] = u
		c, err := Load(env(m))
		if err != nil || c.InsecureTS {
			t.Errorf("%s: err=%v insecure=%v", u, err, c.InsecureTS)
		}
	}
	m := base()
	m["TS_BASE_URL"] = "http://app:3000"
	if _, err := Load(env(m)); err == nil {
		t.Fatal("plain http to remote host accepted")
	}
	m["ALLOW_INSECURE_TS_URL"] = "1"
	c, err := Load(env(m))
	if err != nil || !c.InsecureTS {
		t.Fatalf("opt-in: err=%v insecure=%v", err, c.InsecureTS)
	}
	m["ALLOW_INSECURE_TS_URL"] = "true"
	if _, err := Load(env(m)); err == nil {
		t.Fatal("only the literal 1 may opt in")
	}
}

func TestAdminTokenMustDifferFromSecret(t *testing.T) {
	m := base()
	m["ADMIN_TOKEN"] = good
	if _, err := Load(env(m)); err == nil {
		t.Fatal("equal token and secret accepted")
	}
}

func TestAllowedSenders(t *testing.T) {
	m := base()
	m["ALLOWED_SENDERS"] = "254712345678, +254700000001,"
	c, err := Load(env(m))
	if err != nil || len(c.AllowedSenders) != 2 || c.AllowedSenders[1] != "254700000001" {
		t.Fatalf("%v %v", c.AllowedSenders, err)
	}
	m["ALLOWED_SENDERS"] = "abc"
	if _, err := Load(env(m)); err == nil {
		t.Fatal("bad sender accepted")
	}
}
