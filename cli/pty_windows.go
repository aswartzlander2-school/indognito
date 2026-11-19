//go:build windows

package main

import (
	"context"
	"io"
	"os"
	"strings"

	"github.com/UserExistsError/conpty"
)

// runPty on Windows uses ConPTY (Windows 10 1809+).
func runPty(argv []string, cols, rows int) int {
	quoted := make([]string, len(argv))
	for i, a := range argv {
		if strings.ContainsAny(a, " \t\"") {
			a = "\"" + strings.ReplaceAll(a, "\"", "\\\"") + "\""
		}
		quoted[i] = a
	}
	cpty, err := conpty.Start(strings.Join(quoted, " "), conpty.ConPtyDimensions(cols, rows))
	if err != nil {
		os.Stdout.WriteString("\r\nCould not start the shell: " + err.Error() + "\r\n")
		return 127
	}
	defer cpty.Close()
	go func() { _, _ = io.Copy(os.Stdout, cpty) }()
	go readFrames(os.Stdin, func(b []byte) { _, _ = cpty.Write(b) }, func(c, r int) { _ = cpty.Resize(c, r) }, func() { cpty.Close() })
	code, err := cpty.Wait(context.Background())
	if err != nil {
		return 1
	}
	return int(code)
}
