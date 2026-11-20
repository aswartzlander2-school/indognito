package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const (
	repoOwner           = "aswartzlander2-school"
	repoName            = "indognito"
	updateCheckInterval = 30 * time.Minute
)

// --- version comparison (tolerant numeric semver: X.Y.Z, ignores a leading v and any pre-release) ---

func parseVersion(s string) [3]int {
	s = strings.TrimPrefix(strings.TrimSpace(s), "v")
	if i := strings.IndexAny(s, "-+"); i >= 0 {
		s = s[:i]
	}
	var out [3]int
	for i, part := range strings.SplitN(s, ".", 3) {
		out[i], _ = strconv.Atoi(strings.TrimFunc(part, func(r rune) bool { return r < '0' || r > '9' }))
	}
	return out
}

// newer reports whether version b is strictly newer than a.
func newer(a, b string) bool {
	x, y := parseVersion(a), parseVersion(b)
	for i := 0; i < 3; i++ {
		if y[i] != x[i] {
			return y[i] > x[i]
		}
	}
	return false
}

// --- cached result of the last background check ---

type updateState struct {
	LastCheck time.Time `json:"lastCheck"`
	Latest    string    `json:"latest"`
}

func updateStateFile() string {
	if p := os.Getenv("GNITO_UPDATE_FILE"); p != "" {
		return p
	}
	d, err := os.UserConfigDir()
	if err != nil {
		d = filepath.Join(os.TempDir(), "indognito")
	}
	return filepath.Join(d, "indognito", "update.json")
}

func readUpdateState() updateState {
	var s updateState
	if b, err := os.ReadFile(updateStateFile()); err == nil {
		_ = json.Unmarshal(b, &s)
	}
	return s
}

func writeUpdateState(s updateState) {
	p := updateStateFile()
	_ = os.MkdirAll(filepath.Dir(p), 0o755)
	if b, err := json.MarshalIndent(s, "", "  "); err == nil {
		_ = os.WriteFile(p, b, 0o644)
	}
}

// --- GitHub ---

// latestRelease returns the newest published release's version (tag without the leading v).
func latestRelease() (string, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/releases/latest", repoOwner, repoName)
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if tok := githubToken(); tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	resp, err := httpClient().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("GitHub: HTTP %d (private repo needs \"gh auth login\" or GITHUB_TOKEN)", resp.StatusCode)
	}
	var rel struct {
		Tag   string `json:"tag_name"`
		Draft bool   `json:"draft"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&rel); err != nil {
		return "", err
	}
	return strings.TrimPrefix(rel.Tag, "v"), nil
}

// --- the update banner shown above command output ---

func updateBannerIfAvailable() {
	if os.Getenv("GNITO_NO_UPDATE_CHECK") != "" {
		return
	}
	st := readUpdateState()
	// Show a banner from the last cached check.
	if st.Latest != "" && newer(Version, st.Latest) {
		line := strings.Repeat("=", 64)
		fmt.Fprintf(os.Stderr, "%s%s\n", yellow, line)
		fmt.Fprintf(os.Stderr, "  An update is available: Indognito %s → %s%s%s\n", Version, bold, st.Latest, reset+yellow)
		fmt.Fprintf(os.Stderr, "  Run %sgnito update%s%s to install it.\n", bold, reset+yellow, "")
		fmt.Fprintf(os.Stderr, "%s%s\n\n", line, reset)
	}
	// Refresh the cache in the background if it is stale, so the next run is current.
	if time.Since(st.LastCheck) > updateCheckInterval {
		self, err := os.Executable()
		if err == nil {
			cmd := exec.Command(self, "__checkupdate")
			cmd.Stdout, cmd.Stderr, cmd.Stdin = nil, nil, nil
			detach(cmd)
			if cmd.Start() == nil {
				_ = cmd.Process.Release()
			}
		}
	}
}

// cmdCheckUpdateBackground is the detached worker that refreshes the cache. Silent.
func cmdCheckUpdateBackground() int {
	latest, err := latestRelease()
	st := readUpdateState()
	st.LastCheck = time.Now()
	if err == nil && latest != "" {
		st.Latest = latest
	}
	writeUpdateState(st)
	return 0
}

// cmdCheckUpdate is the manual "gnito check-update": checks now and prints the result.
func cmdCheckUpdate() int {
	fmt.Printf("%sChecking for updates…%s\n", dim, reset)
	latest, err := latestRelease()
	if err != nil {
		fmt.Printf("%s✗ Could not check for updates: %v%s\n", red, err, reset)
		return 1
	}
	writeUpdateState(updateState{LastCheck: time.Now(), Latest: latest})
	if newer(Version, latest) {
		fmt.Printf("%sAn update is available: %s%s → %s%s\n", green, reset, Version, bold, latest+reset)
		fmt.Printf("Run %sgnito update%s to install it.\n", bold, reset)
		return 0
	}
	fmt.Printf("%s✓ You're on the latest version (%s).%s\n", green, Version, reset)
	return 0
}

// cmdUpdate is "gnito update": checks, and if a newer release exists, replaces this binary with it.
func cmdUpdate(args []string) int {
	fmt.Printf("%sChecking for updates…%s\n", dim, reset)
	latest, err := latestRelease()
	if err != nil {
		fmt.Printf("%s✗ Could not check for updates: %v%s\n", red, err, reset)
		return 1
	}
	writeUpdateState(updateState{LastCheck: time.Now(), Latest: latest})
	if !newer(Version, latest) {
		fmt.Printf("%s✓ Already up to date (%s).%s\n", green, Version, reset)
		return 0
	}
	fmt.Printf("Updating Indognito %s → %s%s%s…\n", Version, bold, latest, reset)

	exe, err := os.Executable()
	if err != nil {
		fmt.Printf("%s✗ Cannot find this executable: %v%s\n", red, err, reset)
		return 1
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}

	asset := fmt.Sprintf("gnito-%s-%s", runtime.GOOS, runtime.GOARCH)
	if runtime.GOOS == "windows" {
		asset += ".exe"
	}
	url := fmt.Sprintf("https://github.com/%s/%s/releases/download/v%s/%s", repoOwner, repoName, latest, asset)
	resp, err := openURL(url)
	if err != nil {
		fmt.Printf("%s✗ Download failed: %v%s\n", red, err, reset)
		return 1
	}
	defer resp.Body.Close()

	tmp := exe + ".new"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
	if err != nil {
		// No write access next to the binary (e.g. /usr/local/bin owned by root) — stage in temp.
		f, e2 := os.CreateTemp("", "gnito-update-*")
		if e2 != nil {
			fmt.Printf("%s✗ %v%s\n", red, err, reset)
			return 1
		}
		tmp = f.Name()
		out = f
	}
	if _, err := io.Copy(out, resp.Body); err != nil {
		out.Close()
		os.Remove(tmp)
		fmt.Printf("%s✗ Download interrupted: %v%s\n", red, err, reset)
		return 1
	}
	out.Close()
	_ = os.Chmod(tmp, 0o755)

	if err := replaceBinary(exe, tmp); err != nil {
		os.Remove(tmp)
		fmt.Printf("%s✗ Could not replace %s: %v%s\n", red, exe, err, reset)
		fmt.Printf("  The new binary is downloaded; move it yourself with:\n    sudo install -m 0755 %s %s\n", tmp, exe)
		return 1
	}
	fmt.Printf("%s✓ Updated the CLI to %s.%s\n", green, latest, reset)

	// If Indognito is installed, update the app (server + web) too and restart it, so server-side
	// fixes are delivered — not only the CLI binary.
	if inst, err := loadInstall(); err == nil {
		fmt.Printf("%sUpdating the installed app…%s\n", dim, reset)
		if err := updateApp(inst, latest); err != nil {
			fmt.Printf("%s! The CLI updated, but the app update failed: %v%s\n", yellow, err, reset)
			fmt.Printf("  Run %sgnito re-install%s to finish updating.\n", bold, reset)
			return 1
		}
		inst.Version = latest
		_ = saveInstall(stateFile(), inst)
		fmt.Printf("%s✓ App updated. Restarting…%s\n", green, reset)
		stopServer(inst)
		if err := startServer(inst); err != nil {
			fmt.Printf("%s! Updated, but the server did not restart: %v%s\n", yellow, err, reset)
			return 1
		}
		fmt.Printf("%s✓ Indognito %s is running.%s\n", green, latest, reset)
	} else {
		fmt.Printf(" Install or re-install to set up the app.\n")
	}
	return 0
}

// replaceBinary swaps the running executable for the freshly downloaded one.
func replaceBinary(exe, newFile string) error {
	if runtime.GOOS == "windows" {
		old := exe + ".old"
		_ = os.Remove(old)
		if err := os.Rename(exe, old); err != nil {
			return err
		}
		if err := os.Rename(newFile, exe); err != nil {
			_ = os.Rename(old, exe) // roll back
			return err
		}
		return nil // the .old copy is cleaned up on the next run / by the OS
	}
	// Unix: a rename over a running binary is fine — the process keeps the old inode open.
	if err := os.Rename(newFile, exe); err == nil {
		return nil
	}
	// Different filesystem, or a root-owned install dir: fall back to a privileged install.
	if out, err := exec.Command("install", "-m", "0755", newFile, exe).CombinedOutput(); err == nil {
		_ = out
		return nil
	}
	if _, err := exec.LookPath("sudo"); err == nil {
		cmd := exec.Command("sudo", "install", "-m", "0755", newFile, exe)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		return cmd.Run()
	}
	return fmt.Errorf("permission denied")
}
