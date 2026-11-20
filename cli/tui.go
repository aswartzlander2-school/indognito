package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

func bar(pct, width int) string {
	if pct < 0 {
		pct = 0
	}
	if pct > 100 {
		pct = 100
	}
	n := pct * width / 100
	return red + strings.Repeat("█", n) + dim + strings.Repeat("░", width-n) + reset
}

func title(s string) {
	fmt.Printf("\n%s── %s %s%s\n\n", bred, s, strings.Repeat("─", max(0, 60-len(s))), reset)
}

// runTUI is the text-mode version of the setup wizard, for servers without a desktop.
func runTUI(existing *Install) WizardResult {
	cancelled := WizardResult{Outcome: "cancelled", Reason: "You cancelled setup."}

	// Screen 1: Welcome
	printBanner()
	title(fmt.Sprintf("Welcome to Indognito v%s", Version))
	if existing != nil {
		fmt.Printf("An existing installation (v%s, %s mode) was found at %s.\nThis will reinstall it. Your accounts and workspaces are kept.\n\n", existing.Version, existing.Mode, existing.InstallDir)
	}
	if readLine("Press Enter for Next, or type c to cancel: ") != "" {
		return cancelled
	}

	// Screen 2: Compatibility
	title("Checking if your device is compatible...")
	fmt.Println("We're just checking to ensure we can stably run gnito on your machine. This will only take a moment.")
	fmt.Println()
	checks := runChecks()
	var fails []string
	for i, c := range checks {
		fmt.Printf("\r%s %3d%%", bar((i+1)*100/len(checks), 40), (i+1)*100/len(checks))
		time.Sleep(120 * time.Millisecond)
		_ = c
	}
	fmt.Println()
	for _, c := range checks {
		mark := green + "✓" + reset
		if !c.OK {
			mark = ifElse(c.Fatal, red+"✗"+reset, yellow+"!"+reset)
			if c.Fatal {
				fails = append(fails, c.Label+": "+c.Detail)
			}
		}
		fmt.Printf("  %s %-36s %s%s%s\n", mark, c.Label, dim, c.Detail, reset)
	}
	if len(fails) > 0 {
		return WizardResult{Outcome: "incompatible", Reason: strings.Join(fails, "\n")}
	}

	// Screen 3: Permissions
	title("Permissions")
	fmt.Println("  1) Continue                  install for your account only (recommended)")
	fmt.Println("  2) Continue as Administrator system-wide install, privileged ports, system service")
	fmt.Println("  3) Cancel")
	mode := ""
	for mode == "" {
		switch readLine("Choose 1, 2 or 3: ") {
		case "1":
			mode = "user"
		case "2":
			mode = "admin"
		case "3", "\x04":
			return cancelled
		}
	}
	admin := mode == "admin"

	// Screen 4: Ports
	title("Port configuration")
	be, fe := 7710, 7711
	if existing != nil {
		be, fe = existing.Backend, existing.Frontend
	}
	for {
		be = atoi(readLine(fmt.Sprintf("  Backend port  [%d]: ", be)+""), be)
		fe = atoi(readLine(fmt.Sprintf("  Frontend port [%d]: ", fe)), fe)
		errs := validatePorts(be, fe, admin)
		if existing != nil {
			errs = filterInUse(errs, existing)
		}
		if len(errs) == 0 {
			break
		}
		for _, e := range errs {
			fmt.Printf("  %s✗ %s%s\n", red, e, reset)
		}
	}

	// Screen 5: Allocations
	r := resources(mode)
	title("Storage allocations")
	fmt.Printf("  %-10s %-12s %s\n", "Resource", "Minimum", "Maximum")
	minRAM, minStore := minAllocRAM, minAllocStore
	if relaxed() {
		minRAM, minStore = 256, 512
	}
	fmt.Printf("  %-10s %-12s %d MB (installed)\n", "RAM", fmt.Sprintf("%d MB", minRAM), r.RAMTotalMB)
	fmt.Printf("  %-10s %-12s %d MB (free space)\n\n", "Storage", fmt.Sprintf("%d MB", minStore), r.StorageAvailMB)
	fmt.Printf("  Processor: %d core(s) detected.\n\n", r.CPUCores)
	ram, store, cores, pct := max(minRAM, min(4096, r.RAMTotalMB)), max(minStore, min(16384, r.StorageAvailMB)), r.CPUCores, 100
	for {
		ram = atoi(readLine(fmt.Sprintf("  RAM for workspaces (MB)     [%d]: ", ram)), ram)
		store = atoi(readLine(fmt.Sprintf("  Storage for workspaces (MB) [%d]: ", store)), store)
		cores = atoi(readLine(fmt.Sprintf("  CPU cores                   [%d]: ", cores)), cores)
		pct = atoi(readLine(fmt.Sprintf("  Capacity per core (%%)       [%d]: ", pct)), pct)
		errs := validateAllocation(ram, store, cores, pct)
		if len(errs) == 0 {
			break
		}
		for _, e := range errs {
			fmt.Printf("  %s✗ %s%s\n", red, e, reset)
		}
	}

	// Screen 6: Confirmation
	inst, data := defaultDirs(mode)
	if existing != nil && existing.Mode == mode {
		inst, data = existing.InstallDir, existing.DataDir
	}
	title("Confirm")
	rows := [][2]string{
		{"Backend port", fmt.Sprint(be)}, {"Frontend port", fmt.Sprint(fe)},
		{"Permission mode", ifElse(admin, "Administrator", "Standard user")},
		{"RAM allocation", fmt.Sprintf("%d MB", ram)}, {"Storage allocation", fmt.Sprintf("%d MB", store)},
		{"CPU allocation", fmt.Sprintf("%d core(s) at %d%%", cores, pct)}, {"Installation destination", inst},
	}
	for _, rr := range rows {
		fmt.Printf("  %-26s %s\n", rr[0], rr[1])
	}
	fmt.Println()
	if a := strings.ToLower(readLine("Type i to Install, or c to cancel: ")); a != "i" && a != "install" {
		return cancelled
	}

	// Screen 7: Progress
	title("Installing")
	plan := Plan{Mode: mode, Backend: be, Frontend: fe, RAMMB: ram, StorageMB: store, CPUCores: cores, CPUPercent: pct,
		InstallDir: inst, DataDir: data, Reinstall: existing != nil, KeepData: true, StateFile: stateFile()}
	show := func(p Progress) {
		line := fmt.Sprintf("\r\x1b[2K%s %3d%%  %s", bar(p.Percent, 30), p.Percent, p.Activity)
		if p.Transfer != "" {
			line += dim + " — " + p.Transfer + reset
		}
		fmt.Print(line)
	}
	var err error
	if admin && runtime.GOOS != "windows" && !isElevated() {
		err = elevatedInstall(plan, show)
	} else {
		err = runInstall(plan, show)
	}
	fmt.Println()
	if err != nil {
		return WizardResult{Outcome: "failed", Reason: err.Error()}
	}
	title("Everything has installed successfully!")
	readLine("Press Enter for OK: ")
	return WizardResult{Outcome: "installed"}
}

func filterInUse(errs []string, existing *Install) []string {
	var out []string
	for _, e := range errs {
		if strings.Contains(e, "already in use") && (strings.Contains(e, fmt.Sprintf(" %d ", existing.Backend)) || strings.Contains(e, fmt.Sprintf(" %d ", existing.Frontend))) {
			continue // our own running server; it is stopped before reinstalling
		}
		out = append(out, e)
	}
	return out
}

// elevatedInstall re-runs the install step as root with sudo and streams its progress.
func elevatedInstall(plan Plan, show func(Progress)) error {
	dir, err := os.MkdirTemp("", "gnito-plan-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	env := map[string]string{}
	for _, k := range []string{"GNITO_RELEASE_URL", "GNITO_BUNDLE", "GNITO_DEV_RELAX", "GNITO_NODE_VERSION"} {
		if v := os.Getenv(k); v != "" {
			env[k] = v
		}
	}
	b, _ := json.Marshal(struct {
		Plan
		Env map[string]string `json:"env"`
	}{plan, env})
	pf := filepath.Join(dir, "plan.json")
	if err := os.WriteFile(pf, b, 0o644); err != nil {
		return err
	}
	self, _ := os.Executable()
	fmt.Println("Administrator permission is needed for the system-wide install.")
	cmd := exec.Command("sudo", self, "__wizard", "install", "--plan", pf)
	cmd.Stdin, cmd.Stderr = os.Stdin, os.Stderr
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	var last Progress
	sc := bufio.NewScanner(out)
	for sc.Scan() {
		var p Progress
		if json.Unmarshal(sc.Bytes(), &p) == nil {
			last = p
			show(p)
		}
	}
	_ = cmd.Wait()
	if last.Error != "" {
		return fmt.Errorf("%s", last.Error)
	}
	if !last.Done {
		return fmt.Errorf("the administrator install did not finish (authorization refused?)")
	}
	return nil
}
