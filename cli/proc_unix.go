//go:build !windows

package main

import (
	"os"
	"os/exec"
	"syscall"
)

func detach(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true} }

func terminate(p *os.Process) error { return p.Signal(syscall.SIGTERM) }

func alive(pid int) bool { return syscall.Kill(pid, 0) == nil }
