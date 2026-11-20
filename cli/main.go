// gnito — the Indognito command-line tool.
//
//	gnito start       first run: opens the graphical setup wizard; afterwards: starts Indognito
//	gnito stop        stops the running server
//	gnito status      shows the frontend URL and backend status
//	gnito re-install  reinstalls over an existing installation (keeps data unless told otherwise)
//	gnito uninstall   removes Indognito
//	gnito logs        prints the server log
//	gnito version
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// Version is set at build time: -ldflags "-X main.Version=1.0.0"
var Version = "1.0.0"

// ReleaseURL is where app bundles are downloaded from; override with GNITO_RELEASE_URL.
var ReleaseURL = "https://github.com/aswartzlander2-school/indognito/releases/download/v{version}"

const (
	red    = "\x1b[31m"
	bred   = "\x1b[1;31m"
	green  = "\x1b[1;32m"
	yellow = "\x1b[33m"
	dim    = "\x1b[2m"
	bold   = "\x1b[1m"
	reset  = "\x1b[0m"
)

const banner = `
██╗███╗   ██╗██████╗  ██████╗  ██████╗ ███╗   ██╗██╗████████╗ ██████╗
██║████╗  ██║██╔══██╗██╔═══██╗██╔════╝ ████╗  ██║██║╚══██╔══╝██╔═══██╗
██║██╔██╗ ██║██║  ██║██║   ██║██║  ███╗██╔██╗ ██║██║   ██║   ██║   ██║
██║██║╚██╗██║██║  ██║██║   ██║██║   ██║██║╚██╗██║██║   ██║   ██║   ██║
██║██║ ╚████║██████╔╝╚██████╔╝╚██████╔╝██║ ╚████║██║   ██║   ╚██████╔╝
╚═╝╚═╝  ╚═══╝╚═════╝  ╚═════╝  ╚═════╝ ╚═╝  ╚═══╝╚═╝   ╚═╝    ╚═════╝`

func printBanner() {
	fmt.Println(bred + banner + reset)
	fmt.Printf("%s                                                     v%s%s\n\n", dim, Version, reset)
}

func usage() {
	printBanner()
	fmt.Println(`Usage: gnito <command>

Commands:
  start        Start Indognito (opens the setup wizard the first time)
  stop         Stop the running server
  restart      Restart the server (add --reinit to replay setup)
  status       Show the frontend URL and backend status
  re-install   Reinstall over an existing installation
  uninstall    Remove Indognito from this machine
  logs         Show the server log (use -f to follow)
  version      Print the version

Options:
  --tui        (start / re-install) Use the text-mode setup wizard
  --reinit     (restart) Replay initialization, keeping accounts and files`)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		return
	}
	cmd, args := os.Args[1], os.Args[2:]
	var code int
	switch cmd {
	case "start":
		code = cmdStart(args, false)
	case "re-install", "reinstall":
		code = cmdStart(args, true)
	case "stop":
		code = cmdStop()
	case "restart":
		code = cmdRestart(args)
	case "status":
		code = cmdStatus()
	case "uninstall":
		code = cmdUninstall(args)
	case "logs":
		code = cmdLogs(args)
	case "version", "--version", "-v":
		fmt.Printf("gnito %s (%s/%s)\n", Version, runtime.GOOS, runtime.GOARCH)
	case "help", "--help", "-h":
		usage()
	case "__pty":
		code = cmdPty(args)
	case "__wizard":
		code = cmdWizardAPI(args)
	case "__serve":
		code = cmdServe()
	case "__bundle": // release builds: gnito __bundle <repo-root> <out.tar.gz>
		code = cmdBundle(args)
	default:
		fmt.Fprintf(os.Stderr, "Unknown command %q. Run \"gnito help\".\n", cmd)
		code = 2
	}
	os.Exit(code)
}

func cmdPty(args []string) int {
	fs := flag.NewFlagSet("__pty", flag.ExitOnError)
	cols := fs.Int("cols", 100, "")
	rows := fs.Int("rows", 30, "")
	_ = fs.Parse(args)
	argv := fs.Args()
	if len(argv) > 0 && argv[0] == "--" {
		argv = argv[1:]
	}
	if len(argv) == 0 {
		fmt.Fprintln(os.Stderr, "__pty: no command")
		return 2
	}
	return runPty(argv, *cols, *rows)
}

func atoi(s string, def int) int {
	n, err := strconv.Atoi(strings.TrimSpace(s))
	if err != nil {
		return def
	}
	return n
}

func releaseURL() string {
	u := os.Getenv("GNITO_RELEASE_URL")
	if u == "" {
		u = ReleaseURL
	}
	return strings.TrimRight(strings.ReplaceAll(u, "{version}", Version), "/")
}

func cmdBundle(args []string) int {
	if len(args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: gnito __bundle <repo-root> <out.tar.gz>")
		return 2
	}
	sum, err := bundleSource(args[0], args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if err := os.WriteFile(args[1]+".sha256", []byte(sum+"  "+filepath.Base(args[1])+"\n"), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Println(sum)
	return 0
}
