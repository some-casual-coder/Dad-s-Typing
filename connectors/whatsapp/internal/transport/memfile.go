package transport

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"time"
)

// mediaOverhead covers the MAC and cipher padding written before decrypting.
const mediaOverhead = 64

var errOverflow = errors.New("memfile cap exceeded")

// memFile is a size-capped in-memory whatsmeow.File.
type memFile struct {
	buf      []byte
	pos      int64
	cap      int64
	overflow bool
}

func newMemFile(cap int64) *memFile { return &memFile{cap: cap} }

func (f *memFile) grow(n int64) error {
	if n > f.cap {
		f.overflow = true
		return errOverflow
	}
	if n > int64(len(f.buf)) {
		f.buf = append(f.buf, make([]byte, n-int64(len(f.buf)))...)
	}
	return nil
}

func (f *memFile) WriteAt(p []byte, off int64) (int, error) {
	if off < 0 {
		return 0, errors.New("negative offset")
	}
	if err := f.grow(off + int64(len(p))); err != nil {
		return 0, err
	}
	return copy(f.buf[off:], p), nil
}

func (f *memFile) Write(p []byte) (int, error) {
	n, err := f.WriteAt(p, f.pos)
	f.pos += int64(n)
	return n, err
}

func (f *memFile) ReadAt(p []byte, off int64) (int, error) {
	if off < 0 || off >= int64(len(f.buf)) {
		return 0, io.EOF
	}
	n := copy(p, f.buf[off:])
	if n < len(p) {
		return n, io.EOF
	}
	return n, nil
}

func (f *memFile) Read(p []byte) (int, error) {
	n, err := f.ReadAt(p, f.pos)
	f.pos += int64(n)
	if n > 0 && err == io.EOF {
		err = nil
	}
	return n, err
}

func (f *memFile) Seek(off int64, whence int) (int64, error) {
	switch whence {
	case io.SeekStart:
	case io.SeekCurrent:
		off += f.pos
	case io.SeekEnd:
		off += int64(len(f.buf))
	}
	if off < 0 {
		return 0, errors.New("negative position")
	}
	f.pos = off
	return off, nil
}

func (f *memFile) Truncate(size int64) error {
	if size < 0 {
		return errors.New("negative size")
	}
	if size <= int64(len(f.buf)) {
		f.buf = f.buf[:size]
		return nil
	}
	return f.grow(size)
}

type memInfo struct{ size int64 }

func (i memInfo) Name() string       { return "media" }
func (i memInfo) Size() int64        { return i.size }
func (i memInfo) Mode() fs.FileMode  { return 0o600 }
func (i memInfo) ModTime() time.Time { return time.Time{} }
func (i memInfo) IsDir() bool        { return false }
func (i memInfo) Sys() any           { return nil }

func (f *memFile) Stat() (os.FileInfo, error) {
	return memInfo{int64(len(f.buf))}, nil
}
