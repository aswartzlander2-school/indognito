package main

import (
	"bufio"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

//go:embed gui/*
var guiFiles embed.FS

// Result written by a GUI wizard when it closes.
type WizardResult struct {
	Outcome string `json:"outcome"` // installed | cancelled | incompatible | failed
	Reason  string `json:"reason"`
}

func jsonOut(v any) {
	b, _ := json.Marshal(v)
	fmt.Println(string(b))
}

// cmdWizardAPI is the small JSON API the graphical wizards call (gnito __wizard <sub>).
func cmdWizardAPI(args []string) int {
	if len(args) == 0 {
		return 2
	}
	sub, rest := args[0], args[1:]
	fs := flag.NewFlagSet(sub, flag.ContinueOnError)
	mode := fs.String("mode", "user", "")
	backend := fs.Int("backend", 0, "")
	frontend := fs.Int("frontend", 0, "")
	admin := fs.Bool("admin", false, "")
	ram := fs.Int("ram", 0, "")
	storage := fs.Int("storage", 0, "")
	cores := fs.Int("cores", 0, "")
	pct := fs.Int("pct", 0, "")
	planFile := fs.String("plan", "", "")
	_ = fs.Parse(rest)
	switch sub {
	case "info":
		jsonOut(map[string]any{"version": Version, "os": runtime.GOOS, "osName": osName(), "family": osFamily()})
	case "resources":
		jsonOut(resources(*mode))
	case "checks":
		// one JSON line per check so the GUI can advance its progress bar
		for _, c := range runChecks() {
			jsonOut(c)
		}
	case "validate-ports":
		jsonOut(map[string]any{"errors": nonNil(validatePorts(*backend, *frontend, *admin))})
	case "validate-alloc":
		jsonOut(map[string]any{"errors": nonNil(validateAllocation(*ram, *storage, *cores, *pct))})
	case "existing":
		if in, err := loadInstall(); err == nil {
			jsonOut(in)
		} else {
			fmt.Println("{}")
		}
	case "install":
		b, err := os.ReadFile(*planFile)
		if err != nil {
			jsonOut(Progress{Error: err.Error()})
			return 1
		}
		var p struct {
			Plan
			Env map[string]string `json:"env"`
		}
		if err := json.Unmarshal(b, &p); err != nil {
			jsonOut(Progress{Error: err.Error()})
			return 1
		}
		for k, v := range p.Env {
			if strings.HasPrefix(k, "GNITO_") {
				os.Setenv(k, v)
			}
		}
		if p.Mode == "admin" && runtime.GOOS != "windows" {
			p.OwnerUID, p.OwnerGID, p.OwnerName = currentOwner()
		}
		if err := runInstall(p.Plan, func(pr Progress) { jsonOut(pr) }); err != nil {
			jsonOut(Progress{Error: err.Error()})
			return 1
		}
	default:
		return 2
	}
	return 0
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

func hasDisplay() bool {
	switch runtime.GOOS {
	case "windows", "darwin":
		return true
	}
	return os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != ""
}

func findPython(check string) string {
	for _, py := range []string{"python3", "/usr/bin/python3", "python"} {
		if p, err := exec.LookPath(py); err == nil {
			if exec.Command(p, "-c", check).Run() == nil {
				return p
			}
		}
	}
	return ""
}

// runWizard launches the native setup wizard (or the text wizard) and reports the outcome.
func runWizard(existing *Install, tui bool) int {
	tmp, err := os.MkdirTemp("", "gnito-setup-")
	if err != nil {
		fmt.Println(red+"Cannot create a temporary directory: "+err.Error(), reset)
		return 1
	}
	cleanup := func() { _ = os.RemoveAll(tmp) }
	defer cleanup()
	resultFile := filepath.Join(tmp, "result.json")
	self, _ := os.Executable()
	reinstall := existing != nil

	var cmd *exec.Cmd
	if !tui && hasDisplay() {
		switch runtime.GOOS {
		case "linux":
			if py := findPython("import gi; gi.require_version('Gtk', '3.0'); from gi.repository import Gtk"); py != "" {
				cmd = exec.Command(py, extract(tmp, "gui/wizard_gtk.py"))
			} else if py := findPython("import tkinter"); py != "" {
				cmd = exec.Command(py, extract(tmp, "gui/wizard_tk.py"))
			}
		case "darwin":
			if py := findPython("import tkinter"); py != "" {
				cmd = exec.Command(py, extract(tmp, "gui/wizard_tk.py"))
			}
		case "windows":
			ps := extract(tmp, "gui/wizard_win.ps1")
			cmd = exec.Command("powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-STA", "-File", ps)
		}
	}
	if cmd == nil {
		if !tui {
			fmt.Printf("%sNo graphical desktop toolkit found (GTK via python3-gi, or Tk); using the text-mode wizard.%s\n\n", yellow, reset)
		}
		return finishWizard(runTUI(existing), existing)
	}

	fmt.Printf("%sOpening the Indognito setup window…%s\n", dim, reset)
	cmd.Env = append(os.Environ(), "GNITO_BIN="+self, "GNITO_RESULT="+resultFile, "GNITO_VERSION="+Version,
		"GNITO_TMP="+tmp, "GNITO_STATE="+stateFile(), fmt.Sprintf("GNITO_REINSTALL=%t", reinstall))
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	runErr := cmd.Run()
	var res WizardResult
	if b, err := os.ReadFile(resultFile); err == nil {
		_ = json.Unmarshal(b, &res)
	} else {
		res = WizardResult{Outcome: "cancelled", Reason: "The setup window was closed."}
		if runErr != nil {
			res = WizardResult{Outcome: "failed", Reason: "The setup window exited unexpectedly: " + runErr.Error()}
		}
	}
	return finishWizard(res, existing)
}

func extract(dir, name string) string {
	b, _ := guiFiles.ReadFile(name)
	p := filepath.Join(dir, filepath.Base(name))
	_ = os.WriteFile(p, b, 0o600)
	return p
}

func finishWizard(res WizardResult, existing *Install) int {
	fmt.Println()
	switch res.Outcome {
	case "installed":
		in, err := loadInstall()
		if err != nil {
			fmt.Printf("%s✗ Installation record not found: %v%s\n", red, err, reset)
			return 1
		}
		fmt.Printf("%sStarting Indognito…%s\n", dim, reset)
		if err := startServer(in); err != nil {
			fmt.Printf("%s✗ Installed, but the server did not start: %v%s\n", red, err, reset)
			return 1
		}
		fmt.Printf("\n%sSuccess!%s\n\n", green, reset)
		printAccess(in)
		return 0
	case "cancelled":
		fmt.Printf("%s✗ The installation process was aborted.%s\n", red, reset)
		if res.Reason != "" {
			fmt.Printf("  %s\n", res.Reason)
		}
		fmt.Println("  Temporary setup files were removed. Run \"gnito start\" to try again.")
		if existing != nil {
			fmt.Println("  Your existing installation was not changed.")
		}
		return 1
	case "incompatible":
		fmt.Printf("%s✗ This device does not meet Indognito's requirements.%s\n", red, reset)
		for _, l := range strings.Split(res.Reason, "\n") {
			if l != "" {
				fmt.Printf("  • %s\n", l)
			}
		}
		fmt.Println("  Temporary setup files were removed.")
		return 1
	default:
		fmt.Printf("%s✗ Setup failed: %s%s\n", red, res.Reason, reset)
		return 1
	}
}

// readLine is shared by the text wizard.
var stdin = bufio.NewReader(os.Stdin)

func readLine(prompt string) string {
	fmt.Print(prompt)
	s, err := stdin.ReadString('\n')
	if err != nil {
		return "\x04"
	}
	return strings.TrimSpace(s)
}
