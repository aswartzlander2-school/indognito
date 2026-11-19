package main

import (
	"encoding/binary"
	"io"
	"strconv"
	"strings"
)

// readFrames decodes the backend -> helper protocol: 1 type byte ('d' data, 'r' resize "cols,rows"),
// a 4-byte big-endian length, then the payload. EOF means the backend went away.
func readFrames(r io.Reader, data func([]byte), resize func(int, int), eof func()) {
	hdr := make([]byte, 5)
	for {
		if _, err := io.ReadFull(r, hdr); err != nil {
			eof()
			return
		}
		n := binary.BigEndian.Uint32(hdr[1:])
		if n > 1<<20 {
			eof()
			return
		}
		buf := make([]byte, n)
		if _, err := io.ReadFull(r, buf); err != nil {
			eof()
			return
		}
		switch hdr[0] {
		case 'd':
			data(buf)
		case 'r':
			parts := strings.SplitN(string(buf), ",", 2)
			if len(parts) == 2 {
				c, _ := strconv.Atoi(parts[0])
				rr, _ := strconv.Atoi(parts[1])
				if c > 0 && rr > 0 {
					resize(c, rr)
				}
			}
		}
	}
}
