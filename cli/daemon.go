package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"
)

func pidFile(in *Install) string { return filepath.Join(in.DataDir, "indognito.pid") }
func logFile(in *Install) string { return filepath.Join(in.DataDir, "logs", "indognito.log") }

func healthy(port int) (bool, string) {
	c := http.Client{Timeout: 2 * time.Second}
	resp, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/api/health", port))
	if err != nil {
		return false, ""
	}
	defer resp.Body.Close()
	var h struct {
		OK      bool   `json:"ok"`
		Version string `json:"version"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&h)
	return h.OK, h.Version
}

func readPid(in *Install) int {
	b, err := os.ReadFile(pidFile(in))
	if err != nil {
		return 0
	}
	return atoi(string(b), 0)
}

func startServer(in *Install) error {
	if ok, _ := healthy(in.Frontend); ok {
		return nil
	}
	if serviceCmd(in.Service, "start") != nil {
		if err := runService(in.Service, "start"); err != nil {
			return err
		}
	} else {
		self, _ := os.Executable()
		_ = os.MkdirAll(filepath.Dir(logFile(in)), 0o755)
		lf, err := os.OpenFile(logFile(in), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return err
		}
		cmd := exec.Command(self, "__serve")
		cmd.Stdout, cmd.Stderr = lf, lf
		cmd.Env = append(os.Environ(), "GNITO_STATE_FILE="+stateFile())
		detach(cmd)
		if err := cmd.Start(); err != nil {
			return err
		}
		_ = os.WriteFile(pidFile(in), []byte(strconv.Itoa(cmd.Process.Pid)), 0o600)
		_ = cmd.Process.Release()
	}
	for i := 0; i < 60; i++ {
		if ok, _ := healthy(in.Frontend); ok {
			return nil
		}
		time.Sleep(500 * time.Millisecond)
	}
	return fmt.Errorf("the server did not answer on port %d within 30 seconds — see %s", in.Frontend, logFile(in))
}

func elevator() string {
	if _, err := exec.LookPath("sudo"); err == nil {
		return "sudo"
	}
	return "pkexec"
}

func stopServer(in *Install) {
	if serviceCmd(in.Service, "stop") != nil {
		_ = runService(in.Service, "stop")
		return
	}
	pid := readPid(in)
	if pid <= 0 {
		return
	}
	if p, err := os.FindProcess(pid); err == nil {
		_ = terminate(p)
		for i := 0; i < 20; i++ {
			if !alive(pid) {
				break
			}
			time.Sleep(250 * time.Millisecond)
		}
	}
	_ = os.Remove(pidFile(in))
}

func printAccess(in *Install) {
	ok, ver := healthy(in.Frontend)
	fmt.Printf("  %sFrontend%s   http://localhost:%d/\n", bold, reset, in.Frontend)
	if host, err := os.Hostname(); err == nil {
		fmt.Printf("             http://%s:%d/  (from other devices on your network, if your firewall allows it)\n", host, in.Frontend)
	}
	if ok {
		fmt.Printf("  %sBackend%s    %srunning%s on 127.0.0.1:%d (v%s)\n", bold, reset, green, reset, in.Backend, ver)
	} else {
		fmt.Printf("  %sBackend%s    %snot responding%s (port %d) — run \"gnito logs\"\n", bold, reset, red, reset, in.Backend)
	}
	fmt.Printf("  %sData%s       %s\n", bold, reset, in.DataDir)
	fmt.Println()
	fmt.Println("  Open the frontend URL in a browser. The first visit finishes initialization,")
	fmt.Println("  then asks you to create the Owner account. Stop the server with \"gnito stop\".")
}

func cmdStart(args []string, reinstall bool) int {
	fs := flag.NewFlagSet("start", flag.ContinueOnError)
	tui := fs.Bool("tui", false, "")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	in, err := loadInstall()
	if err == nil && !reinstall {
		fmt.Printf("%sStarting Indognito %s…%s\n", dim, in.Version, reset)
		if err := startServer(in); err != nil {
			fmt.Printf("%s✗ %v%s\n", red, err, reset)
			return 1
		}
		fmt.Printf("%sIndognito is running.%s\n\n", green, reset)
		printAccess(in)
		return 0
	}
	if reinstall && err != nil {
		fmt.Printf("%sNo existing installation was found, so this will be a fresh setup.%s\n", yellow, reset)
	}
	return runWizard(in, *tui)
}

func cmdRestart(args []string) int {
	fs := flag.NewFlagSet("restart", flag.ContinueOnError)
	reinit := fs.Bool("reinit", false, "replay initialization on restart (keeps accounts and files)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	in, err := loadInstall()
	if err != nil {
		fmt.Println("Indognito is not installed. Run \"gnito start\" to set it up.")
		return 1
	}
	fmt.Printf("%sStopping Indognito…%s\n", dim, reset)
	stopServer(in)
	if *reinit {
		// The backend deletes this marker on boot and replays initialization. Accounts, workspaces
		// and limits are kept; only the setup animation and the idempotent setup tasks run again.
		marker := filepath.Join(in.DataDir, ".reinit")
		if err := os.WriteFile(marker, []byte(time.Now().Format(time.RFC3339)), 0o600); err != nil {
			fmt.Printf("%s✗ Could not request re-initialization: %v%s\n", red, err, reset)
			return 1
		}
		fmt.Printf("%sRe-initialization requested — the setup sequence will replay (your accounts are kept).%s\n", yellow, reset)
	}
	fmt.Printf("%sStarting Indognito…%s\n", dim, reset)
	if err := startServer(in); err != nil {
		fmt.Printf("%s✗ %v%s\n", red, err, reset)
		return 1
	}
	fmt.Printf("%sIndognito restarted.%s\n\n", green, reset)
	printAccess(in)
	return 0
}

func cmdStop() int {
	in, err := loadInstall()
	if err != nil {
		fmt.Println("Indognito is not installed.")
		return 1
	}
	stopServer(in)
	fmt.Println("Indognito stopped.")
	return 0
}

func cmdStatus() int {
	in, err := loadInstall()
	if err != nil {
		fmt.Println("Indognito is not installed. Run \"gnito start\" to set it up.")
		return 1
	}
	fmt.Printf("%sIndognito %s%s (%s install at %s)\n\n", bold, in.Version, reset, in.Mode, in.InstallDir)
	printAccess(in)
	return 0
}

func cmdLogs(args []string) int {
	in, err := loadInstall()
	if err != nil {
		fmt.Println("Indognito is not installed.")
		return 1
	}
	if in.Service == "systemd" {
		a := []string{"-u", "indognito.service", "--no-pager", "-n", "200"}
		if len(args) > 0 && args[0] == "-f" {
			a = append(a, "-f")
		}
		cmd := exec.Command("journalctl", a...)
		cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
		_ = cmd.Run()
		return 0
	}
	f, err := os.Open(logFile(in))
	if err != nil {
		fmt.Println("No log yet.")
		return 0
	}
	defer f.Close()
	_, _ = io.Copy(os.Stdout, f)
	if len(args) > 0 && args[0] == "-f" {
		for {
			time.Sleep(500 * time.Millisecond)
			_, _ = io.Copy(os.Stdout, f)
		}
	}
	return 0
}

func cmdUninstall(args []string) int {
	in, err := loadInstall()
	if err != nil {
		fmt.Println("Indognito is not installed.")
		return 1
	}
	keep := !(len(args) > 0 && args[0] == "--purge")
	fmt.Printf("This removes Indognito from %s.\n", in.InstallDir)
	if keep {
		fmt.Printf("Your data (accounts, workspaces) in %s is kept. Use \"gnito uninstall --purge\" to delete it too.\n", in.DataDir)
	} else {
		fmt.Printf("%sYour data in %s will be DELETED.%s\n", red, in.DataDir, reset)
	}
	fmt.Print("Type \"yes\" to continue: ")
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	if strings.TrimSpace(line) != "yes" {
		fmt.Println("Cancelled.")
		return 1
	}
	stopServer(in)
	if serviceCmd(in.Service, "stop") != nil {
		script := removeServiceScript(in.Service) + "rm -rf '" + in.InstallDir + "'"
		if !keep {
			script += "; rm -rf '" + in.DataDir + "'"
		}
		cmd := exec.Command(elevator(), "sh", "-c", script)
		cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
		_ = cmd.Run()
	} else {
		for _, d := range []string{filepath.Join(in.InstallDir, "app"), filepath.Join(in.InstallDir, "runtime")} {
			_ = os.RemoveAll(d)
		}
		if !keep {
			_ = os.RemoveAll(in.DataDir)
			_ = os.RemoveAll(in.InstallDir)
		}
	}
	_ = os.Remove(stateFile())
	fmt.Println("Indognito was removed. The gnito command itself can be deleted with: rm \"$(command -v gnito)\"")
	return 0
}

// cmdServe is the foreground supervisor started by "gnito start" (detached). It runs the
// backend and frontend as two Node.js processes and restarts them if they crash.
func cmdServe() int {
	in, err := loadInstall()
	if err != nil {
		fmt.Fprintln(os.Stderr, "not installed")
		return 1
	}
	env := append(os.Environ(), "GNITO_CONFIG="+in.ConfigFile)
	entry := filepath.Join(in.AppDir, "server", "src", "main.js")
	cmd := exec.Command(in.NodePath, "--disable-warning=ExperimentalWarning", entry)
	cmd.Env, cmd.Stdout, cmd.Stderr, cmd.Dir = env, os.Stdout, os.Stderr, in.AppDir
	if err := cmd.Start(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGTERM, os.Interrupt)
	go func() { <-sig; _ = terminate(cmd.Process) }()
	_ = cmd.Wait()
	return 0
}

var _ = runtime.GOOS
