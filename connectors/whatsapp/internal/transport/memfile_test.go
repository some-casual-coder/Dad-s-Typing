package transport

import (
	"bytes"
	"io"
	"testing"
)

func TestMemFileBasicsAndCap(t *testing.T) {
	f := newMemFile(10)
	if _, err := f.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(f)
	if !bytes.Equal(got, []byte("hello")) {
		t.Fatalf("read %q", got)
	}
	if _, err := f.WriteAt([]byte("HE"), 0); err != nil || string(f.buf) != "HEllo" {
		t.Fatalf("writeat %q %v", f.buf, err)
	}
	if err := f.Truncate(3); err != nil || string(f.buf) != "HEl" {
		t.Fatalf("truncate %q %v", f.buf, err)
	}
	if fi, _ := f.Stat(); fi.Size() != 3 {
		t.Fatal("stat size")
	}
	f.Seek(0, io.SeekEnd)
	if _, err := f.Write(bytes.Repeat([]byte{1}, 8)); err == nil || !f.overflow {
		t.Fatal("cap not enforced on write")
	}
	if err := newMemFile(4).Truncate(5); err == nil {
		t.Fatal("cap not enforced on truncate")
	}
}

func TestMemFileCopyStopsAtCap(t *testing.T) {
	f := newMemFile(100)
	_, err := io.Copy(f, io.LimitReader(zeroReader{}, 1<<30))
	if err == nil || !f.overflow || len(f.buf) > 100 {
		t.Fatalf("err=%v len=%d", err, len(f.buf))
	}
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) { return len(p), nil }
