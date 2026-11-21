package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"time"
)

// Install describes an existing installation. Stored in the user's config dir (install.json).
type Install struct {
	Version     string    `json:"version"`
	Mode        string    `json:"mode"` // "user" | "admin"
	InstallDir  string    `json:"installDir"`
	DataDir     string    `json:"dataDir"`
	ConfigFile  string    `json:"configFile"`
	NodePath    string    `json:"nodePath"`
	AppDir      string    `json:"appDir"`
	Backend     int       `json:"backendPort"`
	Frontend    int       `json:"frontendPort"`
	Service     string    `json:"service"` // "systemd" | "openrc" | "runit" | "launchd" | "none"
	InstalledAt time.Time `json:"installedAt"`
}

func parentDir(p string) string {
	d := filepath.Dir(p)
	if d == p {
		return ""
	}
	return d
}

func stateFile() string {
	if p := os.Getenv("GNITO_STATE_FILE"); p != "" {
		return p
	}
	d, err := os.UserConfigDir()
	if err != nil {
		d = filepath.Join(os.TempDir(), "indognito")
	}
	return filepath.Join(d, "indognito", "install.json")
}

// systemStateFile is a machine-wide copy of the install record for admin (system) installs, so that
// `sudo gnito …` (which reads root's config dir, not the invoking user's) and any user on the box can
// still find the installation.
func systemStateFile() string {
	if runtime.GOOS == "windows" {
		if pd := os.Getenv("ProgramData"); pd != "" {
			return filepath.Join(pd, "Indognito", "install.json")
		}
		return ""
	}
	return "/etc/indognito/install.json"
}

func loadInstall() (*Install, error) {
	paths := []string{stateFile()}
	if s := systemStateFile(); s != "" {
		paths = append(paths, s)
	}
	var lastErr error
	for _, p := range paths {
		b, err := os.ReadFile(p)
		if err != nil {
			lastErr = err
			continue
		}
		var in Install
		if err := json.Unmarshal(b, &in); err != nil {
			lastErr = err
			continue
		}
		if _, err := os.Stat(in.AppDir); err != nil {
			lastErr = err
			continue
		}
		return &in, nil
	}
	return nil, lastErr
}

func saveInstall(path string, in *Install) error {
	write := func(p string) error {
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return err
		}
		b, _ := json.MarshalIndent(in, "", "  ")
		return os.WriteFile(p, b, 0o644)
	}
	if err := write(path); err != nil {
		return err
	}
	// Admin installs also drop a machine-wide copy so sudo/other users can find the install.
	if in.Mode == "admin" {
		if s := systemStateFile(); s != "" && s != path {
			_ = write(s) // best-effort (needs elevation, which admin installs already have)
		}
	}
	return nil
}

// defaultDirs returns install and data directories for the permission mode.
func defaultDirs(mode string) (installDir, dataDir string) {
	home, _ := os.UserHomeDir()
	switch runtime.GOOS {
	case "windows":
		if mode == "admin" {
			pf := os.Getenv("ProgramFiles")
			pd := os.Getenv("ProgramData")
			return filepath.Join(pf, "Indognito"), filepath.Join(pd, "Indognito")
		}
		la := os.Getenv("LOCALAPPDATA")
		return filepath.Join(la, "Indognito"), filepath.Join(la, "Indognito", "data")
	case "darwin":
		if mode == "admin" {
			return "/Library/Indognito", "/Library/Application Support/Indognito"
		}
		base := filepath.Join(home, "Library", "Application Support", "Indognito")
		return base, filepath.Join(base, "data")
	default:
		if mode == "admin" {
			return "/opt/indognito", "/var/lib/indognito"
		}
		xdg := os.Getenv("XDG_DATA_HOME")
		if xdg == "" {
			xdg = filepath.Join(home, ".local", "share")
		}
		return filepath.Join(xdg, "indognito"), filepath.Join(xdg, "indognito", "data")
	}
}
