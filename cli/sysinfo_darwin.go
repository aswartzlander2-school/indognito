//go:build darwin

package main

import (
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

func memInfo() (totalMB, availMB int) {
	out, _ := exec.Command("sysctl", "-n", "hw.memsize").Output()
	b, _ := strconv.Atoi(strings.TrimSpace(string(out)))
	totalMB = b / 1048576
	vm, _ := exec.Command("vm_stat").Output()
	page := 4096
	if m := regexp.MustCompile(`page size of (\d+)`).FindSubmatch(vm); m != nil {
		page, _ = strconv.Atoi(string(m[1]))
	}
	pages := 0
	for _, k := range []string{"Pages free", "Pages inactive", "Pages speculative", "Pages purgeable"} {
		if m := regexp.MustCompile(k + `:\s+(\d+)`).FindSubmatch(vm); m != nil {
			n, _ := strconv.Atoi(string(m[1]))
			pages += n
		}
	}
	availMB = pages * page / 1048576
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
	out, _ := exec.Command("sysctl", "-n", "kern.hv_support").Output()
	if strings.TrimSpace(string(out)) == "1" {
		return true, "Hypervisor.framework available"
	}
	return false, "Hypervisor.framework not available (only needed for the experimental microVM runtime)"
}

func isElevated() bool { return os.Geteuid() == 0 }

func osName() string {
	out, _ := exec.Command("sw_vers", "-productVersion").Output()
	return "macOS " + strings.TrimSpace(string(out))
}

func osFamily() string { return "macos" }
