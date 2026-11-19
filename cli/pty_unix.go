//go:build !windows

package main

import (
	"io"
	"os"
	"os/exec"
	"os/signal"
	"syscall"

	"github.com/creack/pty"
)

// runPty starts argv on a new pseudo-terminal and bridges it to stdin/stdout using the
// framing described in readFrames. Used by the Indognito backend for terminal sessions.
func runPty(argv []string, cols, rows int) int {
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Env = os.Environ()
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: uint16(cols), Rows: uint16(rows)})
	if err != nil {
		os.Stdout.WriteString("\r\n\x1b[31mCould not start the shell: " + err.Error() + "\x1b[0m\r\n")
		return 127
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, syscall.SIGINT, syscall.SIGHUP)
	go func() {
		<-sig
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, syscall.SIGHUP)
			_ = cmd.Process.Signal(syscall.SIGHUP)
		}
	}()
	go func() { _, _ = io.Copy(os.Stdout, f) }()
	go readFrames(os.Stdin, func(b []byte) { _, _ = f.Write(b) }, func(c, r int) {
		_ = pty.Setsize(f, &pty.Winsize{Cols: uint16(c), Rows: uint16(r)})
	}, func() {
		if cmd.Process != nil {
			_ = cmd.Process.Signal(syscall.SIGHUP)
		}
	})
	err = cmd.Wait()
	_ = f.Close()
	if ee, ok := err.(*exec.ExitError); ok {
		return ee.ExitCode()
	}
	return 0
}
