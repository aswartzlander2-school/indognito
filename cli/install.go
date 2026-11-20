package main

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"compress/gzip"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Plan is what the wizard collected.
type Plan struct {
	Mode         string `json:"mode"` // user | admin
	Backend      int    `json:"backend"`
	Frontend     int    `json:"frontend"`
	RAMMB        int    `json:"ramMB"`
	StorageMB    int    `json:"storageMB"`
	CPUCores     int    `json:"cpuCores"`
	CPUPercent   int    `json:"cpuPercent"` // per core, 10..100
	InstallDir   string `json:"installDir"`
	DataDir      string `json:"dataDir"`
	Reinstall    bool   `json:"reinstall"`
	StateFile    string `json:"stateFile"`
	OwnerUID     int    `json:"ownerUid"` // admin installs on Unix: the desktop user who runs the service
	OwnerGID     int    `json:"ownerGid"`
	OwnerName    string `json:"ownerName"`
	KeepData     bool   `json:"keepData"`
	FrontendBind string `json:"frontendBind"`
}

// Progress is emitted as one JSON object per line on stdout.
type Progress struct {
	Percent   int    `json:"percent"`
	Activity  string `json:"activity,omitempty"`
	Component string `json:"component,omitempty"` // most recently installed component
	Dir       string `json:"dir,omitempty"`
	Transfer  string `json:"transfer,omitempty"` // download / extraction status
	Done      bool   `json:"done,omitempty"`
	Error     string `json:"error,omitempty"`
	URL       string `json:"url,omitempty"`
}

type installer struct {
	plan Plan
	emit func(Progress)
	last Progress
}

func (in *installer) step(pct int, activity string) {
	in.last.Percent, in.last.Activity, in.last.Transfer = pct, activity, ""
	in.emit(in.last)
}

func (in *installer) installed(component string) {
	in.last.Component = component
	in.emit(in.last)
}

func runInstall(p Plan, emit func(Progress)) error {
	in := &installer{plan: p, emit: emit}
	in.last.Dir = p.InstallDir
	return in.run()
}

func (in *installer) run() error {
	p := in.plan
	if p.InstallDir == "" || p.DataDir == "" {
		p.InstallDir, p.DataDir = defaultDirs(p.Mode)
		in.plan = p
		in.last.Dir = p.InstallDir
	}

	in.step(2, "Stopping any running Indognito server")
	if old, err := loadInstall(); err == nil {
		stopServer(old)
	}

	in.step(4, "Creating directories")
	appDir := filepath.Join(p.InstallDir, "app")
	stage := filepath.Join(p.InstallDir, fmt.Sprintf(".staging-%d", time.Now().UnixNano()))
	for _, d := range []string{p.InstallDir, p.DataDir, stage} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("cannot create %s: %w", d, err)
		}
	}
	_ = os.Chmod(p.DataDir, 0o700)
	defer os.RemoveAll(stage)
	in.installed("Directories")

	// 1. Node.js runtime: an official or unofficial-builds download verified against SHASUMS256.txt,
	//    or the system's own Node.js where no build exists (see noderuntime.go)
	in.step(6, "Finding the Node.js runtime")
	np, err := resolveNode()
	if err != nil {
		return err
	}
	var nodeBin, nodeLabel string
	if np.System != "" {
		nodeBin, nodeLabel = np.System, "system Node.js ("+np.System+")"
	} else {
		nodeDir := filepath.Join(p.InstallDir, "runtime", "node-"+np.Version)
		nodeBin = filepath.Join(nodeDir, "bin", "node")
		if runtime.GOOS == "windows" {
			nodeBin = filepath.Join(nodeDir, "node.exe")
		}
		nodeLabel = "Node.js " + np.Version + " runtime"
		if _, err := os.Stat(nodeBin); err != nil {
			url := fmt.Sprintf("%s/%s/%s%s", np.Base, np.Version, np.File, np.Ext)
			sums, err := httpGetString(fmt.Sprintf("%s/%s/SHASUMS256.txt", np.Base, np.Version))
			if err != nil {
				return err
			}
			want := ""
			for _, line := range strings.Split(sums, "\n") {
				if f := strings.Fields(line); len(f) == 2 && f[1] == np.File+np.Ext {
					want = f[0]
				}
			}
			if want == "" {
				return fmt.Errorf("no checksum for %s%s at %s", np.File, np.Ext, np.Base)
			}
			archive := filepath.Join(stage, np.File+np.Ext)
			in.step(8, "Downloading Node.js "+np.Version)
			if err := in.download(url, archive, want, 8, 42); err != nil {
				return err
			}
			in.step(42, "Extracting Node.js")
			tmp := filepath.Join(stage, "node")
			if err := in.extract(archive, tmp, 1); err != nil {
				return err
			}
			_ = os.RemoveAll(nodeDir)
			if err := os.MkdirAll(filepath.Dir(nodeDir), 0o755); err != nil {
				return err
			}
			if err := os.Rename(tmp, nodeDir); err != nil {
				return err
			}
		}
	}
	in.installed(nodeLabel)

	// 2. Indognito application bundle
	bundle := filepath.Join(stage, "app.tar.gz")
	if local := os.Getenv("GNITO_BUNDLE"); local != "" {
		in.step(50, "Copying the local Indognito bundle")
		if err := copyFile(local, bundle, 0o644); err != nil {
			return err
		}
		if sum, err := os.ReadFile(local + ".sha256"); err == nil {
			if err := verifySha(bundle, strings.Fields(string(sum))[0]); err != nil {
				return err
			}
		}
	} else if root := sourceRoot(); root != "" && os.Getenv("GNITO_FROM_RELEASE") == "" {
		// gnito built inside a source checkout: install that code, no download needed
		in.step(50, "Packing Indognito from the source checkout ("+root+")")
		if _, err := bundleSource(root, bundle); err != nil {
			return fmt.Errorf("could not pack the source checkout: %w", err)
		}
	} else {
		base := releaseURL()
		name := fmt.Sprintf("indognito-app-%s.tar.gz", Version)
		sum, err := httpGetString(base + "/" + name + ".sha256")
		if err != nil {
			return fmt.Errorf("could not download the bundle checksum from %s: %w", base, err)
		}
		in.step(50, "Downloading Indognito "+Version)
		if err := in.download(base+"/"+name, bundle, strings.Fields(sum)[0], 50, 75); err != nil {
			return err
		}
	}
	in.step(76, "Extracting Indognito")
	newApp := filepath.Join(stage, "app")
	if err := in.extract(bundle, newApp, 1); err != nil {
		return err
	}
	_ = os.RemoveAll(appDir + ".old")
	if _, err := os.Stat(appDir); err == nil {
		if err := os.Rename(appDir, appDir+".old"); err != nil {
			return err
		}
	}
	if err := os.Rename(newApp, appDir); err != nil {
		return err
	}
	_ = os.RemoveAll(appDir + ".old")
	in.installed("Indognito " + Version + " (backend, frontend, web UI, browser engine)")

	// 3. PTY helper = this binary
	in.step(86, "Installing the terminal helper")
	self, _ := os.Executable()
	helper := filepath.Join(appDir, "bin", exeName("gnito"))
	if err := os.MkdirAll(filepath.Dir(helper), 0o755); err != nil {
		return err
	}
	if err := copyFile(self, helper, 0o755); err != nil {
		return err
	}
	in.installed("gnito terminal helper")

	// 4. Configuration
	in.step(89, "Writing configuration")
	cfgFile := filepath.Join(p.DataDir, "config.json")
	if err := writeConfig(cfgFile, p); err != nil {
		return err
	}
	in.installed("Configuration (" + cfgFile + ")")

	// 5. Privileged ports and system service (administrator installs, any init system — see services.go)
	service := "none"
	if p.Mode == "admin" && runtime.GOOS != "windows" {
		if runtime.GOOS == "linux" && (p.Backend < 1024 || p.Frontend < 1024) && !strings.HasPrefix(nodeBin, "/usr/") {
			in.step(91, "Allowing Node.js to use privileged ports")
			if out, err := exec.Command("setcap", "cap_net_bind_service=+ep", nodeBin).CombinedOutput(); err != nil {
				return fmt.Errorf("setcap failed (%v): %s", err, out)
			}
			in.installed("Privileged-port capability")
		}
		in.step(93, "Creating the system service")
		logPath := filepath.Join(p.DataDir, "logs", "indognito.log")
		_ = os.MkdirAll(filepath.Dir(logPath), 0o755)
		kind, err := installService(p, nodeBin, appDir, cfgFile, logPath)
		if err != nil {
			return fmt.Errorf("could not create the %s service: %w", kind, err)
		}
		service = kind
		if kind != "none" {
			in.installed(kind + " service (indognito)")
		}
	}
	if p.Mode == "admin" && runtime.GOOS != "windows" && p.OwnerUID > 0 {
		_ = chownR(p.DataDir, p.OwnerUID, p.OwnerGID)
	}

	in.step(96, "Saving installation record")
	rec := &Install{Version: Version, Mode: p.Mode, InstallDir: p.InstallDir, DataDir: p.DataDir, ConfigFile: cfgFile,
		NodePath: nodeBin, AppDir: appDir, Backend: p.Backend, Frontend: p.Frontend, Service: service, InstalledAt: time.Now()}
	sf := p.StateFile
	if sf == "" {
		sf = stateFile()
	}
	if err := saveInstall(sf, rec); err != nil {
		return err
	}
	if p.Mode == "admin" && p.OwnerUID > 0 {
		_ = os.Chown(sf, p.OwnerUID, p.OwnerGID)
		_ = os.Chown(filepath.Dir(sf), p.OwnerUID, p.OwnerGID)
	}
	in.step(100, "Installation complete")
	in.last.Done = true
	in.last.URL = fmt.Sprintf("http://localhost:%d/", p.Frontend)
	in.emit(in.last)
	return nil
}

func exeName(s string) string {
	if runtime.GOOS == "windows" {
		return s + ".exe"
	}
	return s
}

func writeConfig(path string, p Plan) error {
	cfg := map[string]any{}
	if b, err := os.ReadFile(path); err == nil && p.KeepData {
		_ = json.Unmarshal(b, &cfg) // keep fields like tls and runtime on reinstall
	}
	bind := p.FrontendBind
	if bind == "" {
		bind = "127.0.0.1"
	}
	cfg["version"] = Version
	cfg["hostname"] = "gnito"
	cfg["permissionMode"] = p.Mode
	cfg["dataDir"] = p.DataDir
	cfg["ports"] = map[string]int{"backend": p.Backend, "frontend": p.Frontend}
	cfg["bind"] = map[string]string{"backend": "127.0.0.1", "frontend": bind}
	cfg["allocation"] = map[string]int{"ramMb": p.RAMMB, "storageMb": p.StorageMB, "cpuCores": p.CPUCores, "cpuPercent": p.CPUCores * p.CPUPercent}
	if _, ok := cfg["runtime"]; !ok {
		cfg["runtime"] = map[string]any{"driver": "auto", "microvm": map[string]string{"url": "", "password": ""}}
	}
	if _, ok := cfg["tls"]; !ok {
		cfg["tls"] = map[string]string{"mode": "off", "cert": "", "key": ""}
	}
	b, _ := json.MarshalIndent(cfg, "", "  ")
	return os.WriteFile(path, b, 0o600)
}

func writeSystemdUnit(p Plan, node, appDir, cfgFile string) error {
	userLine := ""
	if p.OwnerName != "" {
		userLine = "User=" + p.OwnerName + "\n"
	}
	unit := fmt.Sprintf(`[Unit]
Description=Indognito %s (browser workspace platform)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
%sEnvironment=GNITO_CONFIG=%s
ExecStart=%s --disable-warning=ExperimentalWarning %s
Restart=on-failure
RestartSec=3
NoNewPrivileges=false
AmbientCapabilities=CAP_NET_BIND_SERVICE

[Install]
WantedBy=multi-user.target
`, Version, userLine, cfgFile, node, filepath.Join(appDir, "server", "src", "main.js"))
	if err := os.WriteFile("/etc/systemd/system/indognito.service", []byte(unit), 0o644); err != nil {
		return err
	}
	_ = exec.Command("systemctl", "daemon-reload").Run()
	return exec.Command("systemctl", "enable", "indognito.service").Run()
}

func chownR(root string, uid, gid int) error {
	return filepath.Walk(root, func(p string, _ os.FileInfo, err error) error {
		if err == nil {
			_ = os.Lchown(p, uid, gid)
		}
		return nil
	})
}

// --- downloads ---

func httpClient() *http.Client { return &http.Client{Timeout: 15 * time.Minute} }

func httpGetString(url string) (string, error) {
	if strings.HasPrefix(url, "file://") {
		b, err := os.ReadFile(strings.TrimPrefix(url, "file://"))
		return string(b), err
	}
	resp, err := openURL(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	return string(b), err
}

func (in *installer) download(url, dest, wantSha string, from, to int) error {
	if strings.HasPrefix(url, "file://") {
		if err := copyFile(strings.TrimPrefix(url, "file://"), dest, 0o644); err != nil {
			return err
		}
		return verifySha(dest, wantSha)
	}
	resp, err := openURL(url)
	if err != nil {
		return fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()
	f, err := os.Create(dest)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	total := resp.ContentLength
	var got int64
	buf := make([]byte, 256<<10)
	lastEmit := time.Now()
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			if _, err := f.Write(buf[:n]); err != nil {
				return err
			}
			h.Write(buf[:n])
			got += int64(n)
			if time.Since(lastEmit) > 200*time.Millisecond {
				lastEmit = time.Now()
				if total > 0 {
					in.last.Percent = from + int(float64(to-from)*float64(got)/float64(total))
					in.last.Transfer = fmt.Sprintf("Downloaded %.1f of %.1f MB", float64(got)/1048576, float64(total)/1048576)
				} else {
					in.last.Transfer = fmt.Sprintf("Downloaded %.1f MB", float64(got)/1048576)
				}
				in.emit(in.last)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			return fmt.Errorf("download interrupted: %w", rerr)
		}
	}
	if hex.EncodeToString(h.Sum(nil)) != strings.ToLower(wantSha) {
		return fmt.Errorf("checksum mismatch for %s — the download was corrupted or tampered with", filepath.Base(dest))
	}
	in.last.Transfer = fmt.Sprintf("Downloaded and verified %.1f MB (SHA-256)", float64(got)/1048576)
	in.emit(in.last)
	return nil
}

func verifySha(path, want string) error {
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	if hex.EncodeToString(h.Sum(nil)) != strings.ToLower(strings.TrimSpace(want)) {
		return fmt.Errorf("checksum mismatch for %s", filepath.Base(path))
	}
	return nil
}

// extract unpacks .tar.gz or .zip into dest, stripping `strip` leading path components.
func (in *installer) extract(archive, dest string, strip int) error {
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	count := 0
	note := func(name string) {
		count++
		if count%200 == 0 {
			in.last.Transfer = fmt.Sprintf("Extracted %d files (%s)", count, filepath.Base(name))
			in.emit(in.last)
		}
	}
	target := func(name string) (string, bool) {
		parts := strings.Split(filepath.ToSlash(name), "/")
		if len(parts) <= strip {
			return "", false
		}
		rel := filepath.Join(parts[strip:]...)
		p := filepath.Join(dest, rel)
		if !strings.HasPrefix(p, filepath.Clean(dest)+string(os.PathSeparator)) {
			return "", false // path traversal
		}
		return p, true
	}
	if strings.HasSuffix(archive, ".zip") {
		zr, err := zip.OpenReader(archive)
		if err != nil {
			return err
		}
		defer zr.Close()
		for _, f := range zr.File {
			p, ok := target(f.Name)
			if !ok {
				continue
			}
			if f.FileInfo().IsDir() {
				_ = os.MkdirAll(p, 0o755)
				continue
			}
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			rc, err := f.Open()
			if err != nil {
				return err
			}
			out, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, f.Mode()|0o600)
			if err != nil {
				rc.Close()
				return err
			}
			_, err = io.Copy(out, rc)
			rc.Close()
			out.Close()
			if err != nil {
				return err
			}
			note(f.Name)
		}
	} else {
		f, err := os.Open(archive)
		if err != nil {
			return err
		}
		defer f.Close()
		gz, err := gzip.NewReader(bufio.NewReader(f))
		if err != nil {
			return err
		}
		tr := tar.NewReader(gz)
		for {
			h, err := tr.Next()
			if err == io.EOF {
				break
			}
			if err != nil {
				return err
			}
			p, ok := target(h.Name)
			if !ok {
				continue
			}
			switch h.Typeflag {
			case tar.TypeDir:
				_ = os.MkdirAll(p, 0o755)
			case tar.TypeReg:
				_ = os.MkdirAll(filepath.Dir(p), 0o755)
				out, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, os.FileMode(h.Mode)&0o777|0o600)
				if err != nil {
					return err
				}
				if _, err := io.Copy(out, tr); err != nil {
					out.Close()
					return err
				}
				out.Close()
			case tar.TypeSymlink:
				if filepath.IsAbs(h.Linkname) || strings.Contains(h.Linkname, "..") && !strings.HasPrefix(filepath.Clean(filepath.Join(filepath.Dir(p), h.Linkname)), filepath.Clean(dest)) {
					continue
				}
				_ = os.MkdirAll(filepath.Dir(p), 0o755)
				_ = os.Remove(p)
				_ = os.Symlink(h.Linkname, p)
			}
			note(h.Name)
		}
	}
	in.last.Transfer = fmt.Sprintf("Extracted %d files", count)
	in.emit(in.last)
	return nil
}

func copyFile(src, dst string, mode os.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	out.Close()
	return os.Rename(tmp, dst)
}

func randomHex(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// currentOwner identifies the desktop user when running elevated (pkexec / sudo).
func currentOwner() (uid, gid int, name string) {
	for _, k := range []string{"PKEXEC_UID", "SUDO_UID"} {
		if v := os.Getenv(k); v != "" {
			if u, err := user.LookupId(v); err == nil {
				uid, _ = strconv.Atoi(u.Uid)
				gid, _ = strconv.Atoi(u.Gid)
				return uid, gid, u.Username
			}
		}
	}
	if u, err := user.Current(); err == nil {
		uid, _ = strconv.Atoi(u.Uid)
		gid, _ = strconv.Atoi(u.Gid)
		return uid, gid, u.Username
	}
	return 0, 0, ""
}

// updateApp downloads the app bundle for `version` and installs it over the existing appDir, then
// reinstalls the PTY helper (this gnito binary) and migrates a legacy 0.0.0.0 frontend bind to
// loopback. Used by "gnito update" so server/web fixes are delivered, not just the CLI binary.
func updateApp(inst *Install, version string) error {
	in := &installer{emit: func(Progress) {}}
	stage, err := os.MkdirTemp("", "gnito-appupd-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	base := strings.TrimRight(strings.ReplaceAll(ReleaseURL, "{version}", version), "/")
	if u := os.Getenv("GNITO_RELEASE_URL"); u != "" {
		base = strings.TrimRight(strings.ReplaceAll(u, "{version}", version), "/")
	}
	name := fmt.Sprintf("indognito-app-%s.tar.gz", version)
	bundle := filepath.Join(stage, name)
	sum, err := httpGetString(base + "/" + name + ".sha256")
	if err != nil {
		return fmt.Errorf("could not fetch the app checksum: %w", err)
	}
	if err := in.download(base+"/"+name, bundle, strings.Fields(sum)[0], 0, 100); err != nil {
		return err
	}
	newApp := filepath.Join(stage, "app")
	if err := in.extract(bundle, newApp, 1); err != nil {
		return err
	}
	_ = os.RemoveAll(inst.AppDir + ".old")
	if _, err := os.Stat(inst.AppDir); err == nil {
		if err := os.Rename(inst.AppDir, inst.AppDir+".old"); err != nil {
			return err
		}
	}
	if err := os.Rename(newApp, inst.AppDir); err != nil {
		_ = os.Rename(inst.AppDir+".old", inst.AppDir)
		return err
	}
	_ = os.RemoveAll(inst.AppDir + ".old")

	// Reinstall the PTY helper = this freshly-updated gnito binary.
	if self, e := os.Executable(); e == nil {
		helper := filepath.Join(inst.AppDir, "bin", exeName("gnito"))
		_ = os.MkdirAll(filepath.Dir(helper), 0o755)
		_ = copyFile(self, helper, 0o755)
	}

	// Migrate a legacy public frontend bind to loopback (avoids the Windows firewall prompt / crash).
	if b, e := os.ReadFile(inst.ConfigFile); e == nil {
		var c map[string]any
		if json.Unmarshal(b, &c) == nil {
			if bind, ok := c["bind"].(map[string]any); ok && bind["frontend"] == "0.0.0.0" {
				bind["frontend"] = "127.0.0.1"
				if nb, e2 := json.MarshalIndent(c, "", "  "); e2 == nil {
					_ = os.WriteFile(inst.ConfigFile, nb, 0o600)
				}
			}
		}
	}
	return nil
}
