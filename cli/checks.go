package main

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"time"
)

const (
	minRAMMB      = 3 * 1024 // a "4 GB" VM commonly reports ~3.3-3.8 GB usable after firmware/kernel reservation
	minStorageMB  = 24 * 1024
	minAllocRAM   = 3 * 1024
	minAllocStore = 8 * 1024
)

// Check is one compatibility test shown in the wizard.
type Check struct {
	ID     string `json:"id"`
	Label  string `json:"label"`
	OK     bool   `json:"ok"`
	Fatal  bool   `json:"fatal"` // a failed fatal check stops setup
	Detail string `json:"detail"`
}

// Resources reported to the wizard for allocation limits.
type Resources struct {
	OS             string `json:"os"`
	Family         string `json:"family"`
	Arch           string `json:"arch"`
	RAMTotalMB     int    `json:"ramTotalMB"`
	RAMAvailMB     int    `json:"ramAvailMB"`
	StorageAvailMB int    `json:"storageAvailMB"`
	CPUCores       int    `json:"cpuCores"`
	Elevated       bool   `json:"elevated"`
	InstallDir     string `json:"installDir"`
	AdminDir       string `json:"adminInstallDir"`
}

func relaxed() bool {
	return os.Getenv("GNITO_DEV_RELAX") == "1" || os.Getenv("GNITO_SKIP_CHECKS") == "1"
}

func resources(mode string) Resources {
	inst, _ := defaultDirs(mode)
	adm, _ := defaultDirs("admin")
	t, a := memInfo()
	return Resources{
		OS: osName(), Family: osFamily(), Arch: runtime.GOARCH, RAMTotalMB: t, RAMAvailMB: a,
		StorageAvailMB: diskFreeMB(inst), CPUCores: runtime.NumCPU(), Elevated: isElevated(),
		InstallDir: inst, AdminDir: adm,
	}
}

func portFree(port int) bool {
	l, err := net.Listen("tcp", net.JoinHostPort("0.0.0.0", strconv.Itoa(port)))
	if err != nil {
		return false
	}
	_ = l.Close()
	return true
}

func runChecks() []Check {
	r := resources("user")
	var out []Check
	add := func(c Check) { out = append(out, c) }

	supported := map[string]bool{"linux": true, "darwin": true, "windows": true}
	add(Check{ID: "os", Label: "Operating system", OK: supported[runtime.GOOS], Fatal: true, Detail: r.OS})

	is64 := runtime.GOARCH == "amd64" || runtime.GOARCH == "arm64"
	add(Check{ID: "cpu", Label: "64-bit processor", OK: is64, Fatal: true,
		Detail: fmt.Sprintf("%s, %d core(s)", runtime.GOARCH, r.CPUCores)})

	ramOK := r.RAMTotalMB >= minRAMMB
	add(Check{ID: "ram", Label: "Total RAM (3 GB minimum)", OK: ramOK || relaxed(), Fatal: true,
		Detail: fmt.Sprintf("%.1f GB installed (%.1f GB available now)", float64(r.RAMTotalMB)/1024, float64(r.RAMAvailMB)/1024) + relaxNote(ramOK)})

	diskOK := r.StorageAvailMB >= minStorageMB
	add(Check{ID: "storage", Label: "Available storage (24 GB minimum)", OK: diskOK || relaxed(), Fatal: true,
		Detail: fmt.Sprintf("%.1f GB free at %s", float64(r.StorageAvailMB)/1024, r.InstallDir) + relaxNote(diskOK)})

	// Filesystem permissions: can we create the install directory's parent contents?
	parent := r.InstallDir
	for parent != "" {
		if _, err := os.Stat(parent); err == nil {
			break
		}
		parent = parentDir(parent)
	}
	probe := filepath.Join(parent, fmt.Sprintf(".gnito-probe-%d", os.Getpid()))
	err := os.WriteFile(probe, []byte("ok"), 0o600)
	_ = os.Remove(probe)
	add(Check{ID: "fs", Label: "Filesystem permissions", OK: err == nil, Fatal: true, Detail: ifElse(err == nil, "Can write to "+parent, fmt.Sprint(err))})

	// Runtime dependencies: Indognito downloads its own Node.js runtime; only tar/zip extraction (built in) is needed.
	add(Check{ID: "deps", Label: "Runtime dependencies", OK: true, Fatal: true,
		Detail: "Node.js runtime is downloaded by the installer (no system packages required)"})

	be, fe := portFree(7710), portFree(7711)
	add(Check{ID: "ports", Label: "Port availability", OK: true, Fatal: false,
		Detail: fmt.Sprintf("Default ports: 7710 %s, 7711 %s (you can change them next)", freeWord(be), freeWord(fe))})

	v, vd := virtualization()
	add(Check{ID: "virt", Label: "Virtualization / sandboxing", OK: v, Fatal: false, Detail: vd})

	c := http.Client{Timeout: 8 * time.Second}
	resp, nerr := c.Head("https://nodejs.org/dist/index.json")
	netOK := nerr == nil && resp.StatusCode < 500
	if resp != nil {
		resp.Body.Close()
	}
	add(Check{ID: "net", Label: "Network connection", OK: netOK, Fatal: true, Detail: ifElse(netOK, "Reached nodejs.org over HTTPS", fmt.Sprint(nerr))})
	return out
}

func relaxNote(ok bool) string {
	if !ok && relaxed() {
		return " - below minimum, allowed because GNITO_DEV_RELAX=1 (development only)"
	}
	return ""
}

func freeWord(b bool) string { return ifElse(b, "free", "in use") }

func ifElse(c bool, a, b string) string {
	if c {
		return a
	}
	return b
}

// validatePorts returns human-readable problems (empty = OK).
func validatePorts(backend, frontend int, admin bool) []string {
	var errs []string
	own := map[int]bool{}
	if in, err := loadInstall(); err == nil {
		own[in.Backend], own[in.Frontend] = true, true // our own server; stopped before reinstalling
	}
	check := func(name string, p int) {
		switch {
		case p < 1 || p > 65535:
			errs = append(errs, fmt.Sprintf("%s port must be between 1 and 65535.", name))
		case p < 1024 && !admin:
			errs = append(errs, fmt.Sprintf("%s port %d is a privileged port (below 1024). Pick 1024 or higher, or go back and choose \"Continue as Administrator\".", name, p))
		case !own[p] && !portFree(p) && !(admin && p < 1024 && !isElevated()):
			errs = append(errs, fmt.Sprintf("%s port %d is already in use by another program.", name, p))
		}
	}
	check("Backend", backend)
	check("Frontend", frontend)
	if backend == frontend {
		errs = append(errs, "Backend and frontend must use different ports.")
	}
	return errs
}

// validateAllocation checks RAM/storage/CPU against what the machine has.
func validateAllocation(ramMB, storageMB, cpuCores, cpuPct int) []string {
	r := resources("user")
	var errs []string
	minRAM, minStore := minAllocRAM, minAllocStore
	if relaxed() {
		minRAM, minStore = 256, 512
	}
	if ramMB < minRAM {
		errs = append(errs, fmt.Sprintf("RAM must be at least %d MB (%.0f GB).", minRAM, float64(minRAM)/1024))
	}
	if ramMB > r.RAMTotalMB {
		errs = append(errs, fmt.Sprintf("RAM cannot exceed the machine's installed RAM (%d MB).", r.RAMTotalMB))
	}
	if storageMB < minStore {
		errs = append(errs, fmt.Sprintf("Storage must be at least %d MB (%.0f GB).", minStore, float64(minStore)/1024))
	}
	if storageMB > r.StorageAvailMB {
		errs = append(errs, fmt.Sprintf("Storage cannot exceed the free space (%d MB).", r.StorageAvailMB))
	}
	if cpuCores < 1 || cpuCores > r.CPUCores {
		errs = append(errs, fmt.Sprintf("CPU cores must be between 1 and %d.", r.CPUCores))
	}
	if cpuPct < 10 || cpuPct > 100 {
		errs = append(errs, "CPU capacity per core must be between 10% and 100%.")
	}
	return errs
}
