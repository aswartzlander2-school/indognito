//go:build linux

package main

import (
	"os"
	"os/exec"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

func memInfo() (totalMB, availMB int) {
	b, _ := os.ReadFile("/proc/meminfo")
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		kb, _ := strconv.Atoi(f[1])
		switch f[0] {
		case "MemTotal:":
			totalMB = kb / 1024
		case "MemAvailable:":
			availMB = kb / 1024
		}
	}
	// Respect a container (cgroup v2) memory limit.
	if raw, err := os.ReadFile("/sys/fs/cgroup/memory.max"); err == nil {
		if s := strings.TrimSpace(string(raw)); s != "max" {
			if lim, err := strconv.Atoi(s); err == nil && lim/1048576 < totalMB {
				cur := 0
				if c, err := os.ReadFile("/sys/fs/cgroup/memory.current"); err == nil {
					cur, _ = strconv.Atoi(strings.TrimSpace(string(c)))
				}
				totalMB = lim / 1048576
				if a := (lim - cur) / 1048576; a < availMB {
					availMB = a
				}
			}
		}
	}
	return
}

func diskFreeMB(path string) int {
	var st unix.Statfs_t
	for p := path; p != ""; p = parentDir(p) {
		if unix.Statfs(p, &st) == nil {
			return int(st.Bavail * uint64(st.Bsize) / 1048576)
		}
		if p == "/" {
			break
		}
	}
	return 0
}

func virtualization() (bool, string) {
	if _, err := os.Stat("/dev/kvm"); err == nil {
		return true, "KVM available (/dev/kvm)"
	}
	if exec.Command("bwrap", "--ro-bind", "/", "/", "--unshare-pid", "true").Run() == nil {
		return true, "User namespaces available (bubblewrap sandbox)"
	}
	return false, "No KVM and no user namespaces: terminals for other accounts will be off until sandboxing is available"
}

func isElevated() bool { return os.Geteuid() == 0 }

func osName() string {
	b, _ := os.ReadFile("/etc/os-release")
	name, id := "Linux", ""
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			name = strings.Trim(line[12:], `"`)
		}
		if strings.HasPrefix(line, "ID=") {
			id = strings.Trim(line[3:], `"`)
		}
	}
	_ = id
	return name
}

func osFamily() string {
	b, _ := os.ReadFile("/etc/os-release")
	s := strings.ToLower(string(b))
	for _, f := range []string{"ubuntu", "debian", "fedora", "arch"} {
		if strings.Contains(s, "id="+f) || strings.Contains(s, "id_like="+f) || strings.Contains(s, "id_like=\""+f) {
			return f
		}
	}
	return "linux"
}
