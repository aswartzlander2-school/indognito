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

func loadInstall() (*Install, error) {
	b, err := os.ReadFile(stateFile())
	if err != nil {
		return nil, err
	}
	var in Install
	if err := json.Unmarshal(b, &in); err != nil {
		return nil, err
	}
	if _, err := os.Stat(in.AppDir); err != nil {
		return nil, err
	}
	return &in, nil
}

func saveInstall(path string, in *Install) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	b, _ := json.MarshalIndent(in, "", "  ")
	return os.WriteFile(path, b, 0o644)
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
