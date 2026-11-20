package main

// Picks the Node.js runtime for this machine, so Indognito installs on every Linux distribution, macOS
// and Windows:
//
//   1. official builds from nodejs.org (glibc Linux x64/arm64/armv7l/ppc64le/s390x, macOS, Windows)
//   2. nodejs.org's unofficial-builds for musl distributions (Alpine, Void musl, …), riscv64,
//      32-bit x86 and loong64
//   3. otherwise a system Node.js ≥ 22.13 (from the distribution's package manager), or the one
//      named by GNITO_NODE

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

const (
	nodeOfficial   = "https://nodejs.org/dist"
	nodeUnofficial = "https://unofficial-builds.nodejs.org/download/release"
)

// nodePlan says where the runtime comes from: a download (Base/Version/File) or an existing binary (System).
type nodePlan struct {
	Base, Version, File, Ext string
	System                   string
}

// isMusl reports a musl-libc Linux (Alpine, Void musl, …), where glibc builds of Node.js don't run.
func isMusl() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	if m, _ := filepath.Glob("/lib/ld-musl-*.so.1"); len(m) > 0 {
		return true
	}
	out, _ := exec.Command("ldd", "--version").CombinedOutput()
	return strings.Contains(strings.ToLower(string(out)), "musl")
}

// nodeKey is the Node.js platform key ("linux-x64", "linux-x64-musl", "win-x64", …) for this machine.
func nodeKey() (key string, official bool) {
	arch := map[string]string{"amd64": "x64", "arm64": "arm64", "arm": "armv7l", "ppc64le": "ppc64le", "s390x": "s390x",
		"riscv64": "riscv64", "386": "x86", "loong64": "loong64"}[runtime.GOARCH]
	switch runtime.GOOS {
	case "darwin":
		return "darwin-" + arch, arch == "x64" || arch == "arm64"
	case "windows":
		return "win-" + arch, arch == "x64" || arch == "arm64" || arch == "x86"
	}
	if isMusl() {
		return "linux-" + arch + "-musl", false
	}
	switch arch {
	case "x64", "arm64", "armv7l", "ppc64le", "s390x":
		return "linux-" + arch, true
	}
	return "linux-" + arch, false
}

// systemNode finds a usable Node.js already on the machine (≥ 22.13: node:sqlite without a flag).
func systemNode() string {
	cands := []string{os.Getenv("GNITO_NODE")}
	if p, err := exec.LookPath("node"); err == nil {
		cands = append(cands, p)
	}
	if p, err := exec.LookPath("nodejs"); err == nil {
		cands = append(cands, p)
	}
	for _, c := range cands {
		if c == "" {
			continue
		}
		out, err := exec.Command(c, "--version").Output()
		if err != nil {
			continue
		}
		v := strings.TrimPrefix(strings.TrimSpace(string(out)), "v")
		p := strings.SplitN(v, ".", 3)
		if len(p) < 2 {
			continue
		}
		maj, _ := strconv.Atoi(p[0])
		min, _ := strconv.Atoi(p[1])
		if maj > 22 || (maj == 22 && min >= 13) {
			return c
		}
	}
	return ""
}

// resolveNode decides which Node.js 22 to install for this machine.
func resolveNode() (*nodePlan, error) {
	if p := os.Getenv("GNITO_NODE"); p != "" {
		if s := systemNode(); s != "" {
			return &nodePlan{System: s}, nil
		}
		return nil, fmt.Errorf("GNITO_NODE=%s is not a Node.js 22.13 or newer", p)
	}
	key, official := nodeKey()
	ext := ".tar.gz"
	if runtime.GOOS == "windows" {
		ext = ".zip"
	}
	bases := []string{nodeUnofficial}
	if official {
		bases = []string{nodeOfficial, nodeUnofficial}
	}
	for _, base := range bases {
		ver, err := latestNode22For(base, key)
		if err == nil && ver != "" {
			return &nodePlan{Base: base, Version: ver, File: fmt.Sprintf("node-%s-%s", ver, key), Ext: ext}, nil
		}
	}
	if s := systemNode(); s != "" {
		return &nodePlan{System: s}, nil
	}
	return nil, fmt.Errorf("there's no Node.js 22 download for %s; install Node.js 22.13+ with your package manager "+
		"(e.g. \"apk add nodejs\", \"xbps-install nodejs\") and run setup again", key)
}

// latestNode22For is the newest Node.js 22 LTS with a build for key at base (GNITO_NODE_VERSION pins it).
func latestNode22For(base, key string) (string, error) {
	pin := os.Getenv("GNITO_NODE_VERSION")
	s, err := httpGetString(base + "/index.json")
	if err != nil {
		return "", err
	}
	var rel []struct {
		Version string   `json:"version"`
		LTS     any      `json:"lts"`
		Files   []string `json:"files"`
	}
	if err := json.Unmarshal([]byte(s), &rel); err != nil {
		return "", err
	}
	// index.json names files like "linux-x64", "linux-x64-musl", "osx-arm64-tar", "win-x64-zip"
	want := key
	switch {
	case strings.HasPrefix(key, "darwin-"):
		want = "osx-" + strings.TrimPrefix(key, "darwin-") + "-tar"
	case strings.HasPrefix(key, "win-"):
		want = key + "-zip"
	}
	for _, r := range rel {
		if pin != "" && r.Version != pin {
			continue
		}
		if !strings.HasPrefix(r.Version, "v22.") || r.LTS == false {
			continue
		}
		for _, f := range r.Files {
			if f == want {
				return r.Version, nil
			}
		}
	}
	return "", errors.New("no Node.js 22 build for " + key + " at " + base)
}
