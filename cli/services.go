package main

// System services for administrator installs, on whichever init system the machine uses:
// systemd (most distributions), OpenRC (Alpine, Gentoo, Artix-openrc), runit (Void, Artix-runit) and
// launchd (macOS). Without one of these (containers, WSL without systemd, …) gnito supervises the
// server itself, exactly like a per-user install ("none").

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

const launchdLabel = "top.indognito.server"

// detectInit names the running init system that gnito can manage.
func detectInit() string {
	switch runtime.GOOS {
	case "darwin":
		return "launchd"
	case "linux":
	default:
		return "none"
	}
	if fileExists("/run/systemd/system") {
		if _, err := exec.LookPath("systemctl"); err == nil {
			return "systemd"
		}
	}
	if _, err := exec.LookPath("openrc-run"); err == nil || fileExists("/sbin/openrc-run") {
		if fileExists("/run/openrc") || fileExists("/etc/init.d") {
			return "openrc"
		}
	}
	if _, err := exec.LookPath("sv"); err == nil && runitDir() != "" {
		return "runit"
	}
	return "none"
}

// runitDir is the directory of supervised services (Void: /var/service, Artix: /run/runit/service).
func runitDir() string {
	for _, d := range []string{"/var/service", "/run/runit/service", "/etc/runit/runsvdir/default", "/service"} {
		if fileExists(d) {
			return d
		}
	}
	return ""
}

func serverArgs(appDir string) []string {
	return []string{"--disable-warning=ExperimentalWarning", filepath.Join(appDir, "server", "src", "main.js")}
}

// installService creates and enables the service; returns its kind (or "none").
func installService(p Plan, node, appDir, cfgFile, logPath string) (string, error) {
	kind := detectInit()
	if kind == "none" || !isElevated() {
		return "none", nil
	}
	owner := p.OwnerName
	args := strings.Join(serverArgs(appDir), " ")
	switch kind {
	case "systemd":
		return kind, writeSystemdUnit(p, node, appDir, cfgFile)
	case "openrc":
		user := ""
		if owner != "" {
			user = "command_user=\"" + owner + "\"\n"
		}
		script := fmt.Sprintf(`#!/sbin/openrc-run
# Indognito %s (browser workspace platform) — written by "gnito"
name="Indognito"
description="Indognito browser workspace platform"
command="%s"
command_args="%s"
command_background=true
pidfile="/run/indognito.pid"
%soutput_log="%s"
error_log="%s"
export GNITO_CONFIG="%s"

depend() {
	need net
	after firewall
}
`, Version, node, args, user, logPath, logPath, cfgFile)
		if err := os.WriteFile("/etc/init.d/indognito", []byte(script), 0o755); err != nil {
			return kind, err
		}
		if out, err := exec.Command("rc-update", "add", "indognito", "default").CombinedOutput(); err != nil {
			return kind, fmt.Errorf("rc-update failed (%v): %s", err, out)
		}
		return kind, nil
	case "runit":
		dir := "/etc/sv/indognito"
		if !fileExists("/etc/sv") && fileExists("/etc/runit/sv") {
			dir = "/etc/runit/sv/indognito" // Artix
		}
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return kind, err
		}
		chpst := ""
		if owner != "" {
			chpst = "chpst -u " + owner + " "
		}
		run := fmt.Sprintf("#!/bin/sh\n# Indognito %s — written by \"gnito\"\nexport GNITO_CONFIG=%q\nexec %s%s %s >>%q 2>&1\n", Version, cfgFile, chpst, node, args, logPath)
		if err := os.WriteFile(filepath.Join(dir, "run"), []byte(run), 0o755); err != nil {
			return kind, err
		}
		link := filepath.Join(runitDir(), "indognito")
		_ = os.Remove(link)
		if err := os.Symlink(dir, link); err != nil {
			return kind, err
		}
		return kind, nil
	case "launchd":
		user := ""
		if owner != "" {
			user = "\t<key>UserName</key><string>" + owner + "</string>\n"
		}
		var progArgs strings.Builder
		for _, a := range append([]string{node}, serverArgs(appDir)...) {
			progArgs.WriteString("\t\t<string>" + xmlEscape(a) + "</string>\n")
		}
		plist := fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key><string>%s</string>
	<key>ProgramArguments</key>
	<array>
%s	</array>
	<key>EnvironmentVariables</key>
	<dict><key>GNITO_CONFIG</key><string>%s</string></dict>
%s	<key>RunAtLoad</key><true/>
	<key>KeepAlive</key><true/>
	<key>StandardOutPath</key><string>%s</string>
	<key>StandardErrorPath</key><string>%s</string>
</dict>
</plist>
`, launchdLabel, progArgs.String(), xmlEscape(cfgFile), user, xmlEscape(logPath), xmlEscape(logPath))
		if err := os.WriteFile(launchdPlist(), []byte(plist), 0o644); err != nil {
			return kind, err
		}
		return kind, nil
	}
	return "none", nil
}

func launchdPlist() string { return "/Library/LaunchDaemons/" + launchdLabel + ".plist" }

func xmlEscape(s string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(s)
}

// serviceCmd is the command that starts / stops a service of this kind.
func serviceCmd(kind, action string) []string {
	switch kind {
	case "systemd":
		return []string{"systemctl", action, "indognito.service"}
	case "openrc":
		return []string{"rc-service", "indognito", action}
	case "runit":
		return []string{"sv", map[string]string{"start": "up", "stop": "down"}[action], "indognito"}
	case "launchd":
		if action == "start" {
			return []string{"launchctl", "load", "-w", launchdPlist()}
		}
		return []string{"launchctl", "unload", launchdPlist()}
	}
	return nil
}

// runService starts or stops a service, asking for administrator rights when needed.
func runService(kind, action string) error {
	c := serviceCmd(kind, action)
	if c == nil {
		return fmt.Errorf("no service manager")
	}
	if !isElevated() {
		c = append([]string{elevator()}, c...)
	}
	cmd := exec.Command(c[0], c[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s failed: %w", strings.Join(c, " "), err)
	}
	return nil
}

// removeServiceScript is a shell snippet that disables and deletes the service (run as root).
func removeServiceScript(kind string) string {
	switch kind {
	case "systemd":
		return "systemctl disable --now indognito.service; rm -f /etc/systemd/system/indognito.service; systemctl daemon-reload; "
	case "openrc":
		return "rc-service indognito stop; rc-update del indognito default; rm -f /etc/init.d/indognito; "
	case "runit":
		return "sv down indognito; rm -f " + runitDir() + "/indognito; rm -rf /etc/sv/indognito /etc/runit/sv/indognito; "
	case "launchd":
		return "launchctl unload " + launchdPlist() + "; rm -f " + launchdPlist() + "; "
	}
	return ""
}
