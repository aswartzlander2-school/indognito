#!/usr/bin/env python3
"""Indognito setup wizard — Tk/ttk version.

Used on macOS (ttk's native "aqua" theme) and on Linux desktops without GTK bindings.
Same screens and the same `gnito __wizard` backend as wizard_gtk.py.
"""
import json
import os
import shutil
import subprocess
import sys
import threading
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

GNITO = os.environ.get("GNITO_BIN", "gnito")
RESULT = os.environ.get("GNITO_RESULT")
VERSION = os.environ.get("GNITO_VERSION", "1.0.0")
TMP = os.environ.get("GNITO_TMP", "/tmp")
STATE = os.environ.get("GNITO_STATE", "")
MAC = sys.platform == "darwin"


def api(*args):
    out = subprocess.run([GNITO, "__wizard", *args], capture_output=True, text=True, timeout=120)
    lines = out.stdout.strip().splitlines()
    return json.loads(lines[-1]) if lines else {}


def write_result(outcome, reason=""):
    if RESULT:
        with open(RESULT, "w") as f:
            json.dump({"outcome": outcome, "reason": reason}, f)


class Wizard:
    def __init__(self, root):
        self.root = root
        root.title(f"Indognito {VERSION} Setup")
        root.geometry("780x560")
        root.protocol("WM_DELETE_WINDOW", lambda: self.abort("The setup window was closed."))
        style = ttk.Style()
        if MAC and "aqua" in style.theme_names():
            style.theme_use("aqua")
        self.body = ttk.Frame(root, padding=24)
        self.body.pack(fill="both", expand=True)
        ttk.Separator(root).pack(fill="x")
        self.bar = ttk.Frame(root, padding=12)
        self.bar.pack(fill="x")
        self.proc, self.mode, self.res, self.done = None, "user", {}, False
        self.existing = api("existing")
        self.digits = (root.register(lambda s: s.isdigit() or s == ""), "%P")
        self.welcome()

    def clear(self):
        for w in self.body.winfo_children() + self.bar.winfo_children():
            w.destroy()

    def h(self, text, size=18):
        ttk.Label(self.body, text=text, font=("TkDefaultFont", size, "bold")).pack(anchor="w", pady=(0, 10))

    def p(self, text):
        ttk.Label(self.body, text=text, wraplength=700, justify="left").pack(anchor="w", pady=4)

    def buttons(self, *specs):
        for label, cb, primary in reversed(specs):
            b = ttk.Button(self.bar, text=label, command=cb, default="active" if primary else "normal")
            b.pack(side="right", padx=4)

    def entry(self, parent, value, width=8):
        v = tk.StringVar(value=str(value))
        ttk.Entry(parent, textvariable=v, width=width, validate="key", validatecommand=self.digits).grid_configure()
        return v

    def grid_table(self, headers, rows):
        f = ttk.Frame(self.body, padding=10, relief="groove")
        f.pack(anchor="w", fill="x", pady=8)
        for c, hd in enumerate(headers):
            ttk.Label(f, text=hd, font=("TkDefaultFont", 11, "bold")).grid(row=0, column=c, sticky="w", padx=10, pady=4)
        for r, row in enumerate(rows):
            for c, cell in enumerate(row):
                if isinstance(cell, tk.StringVar):
                    ttk.Entry(f, textvariable=cell, width=10, validate="key", validatecommand=self.digits).grid(row=r + 1, column=c, sticky="w", padx=10, pady=4)
                else:
                    ttk.Label(f, text=str(cell)).grid(row=r + 1, column=c, sticky="w", padx=10, pady=4)

    def abort(self, reason="You cancelled setup."):
        if self.done:
            return
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
        messagebox.showerror("Indognito Setup", "The installation process was aborted", detail=reason)
        write_result("cancelled", reason)
        self.quit()

    def quit(self):
        self.done = True
        self.root.destroy()

    # 1
    def welcome(self):
        self.clear()
        self.h(f"Welcome to Indognito v{VERSION}", 22)
        self.p("This assistant sets up Indognito on this computer: an isolated browser, a terminal, file storage and an admin dashboard.")
        if self.existing.get("version"):
            self.p(f"An existing installation (v{self.existing['version']}) was found at {self.existing['installDir']}. It will be reinstalled; your data is kept.")
        self.buttons(("Cancel", self.abort, False), ("Next", self.checks, True))

    # 2
    def checks(self):
        self.clear()
        self.h("Checking if your device is compatible...")
        self.p("We're just checking to ensure we can stably run gnito on your machine. This will only take a moment.")
        self.pb = ttk.Progressbar(self.body, maximum=10, length=700)
        self.pb.pack(anchor="w", pady=10)
        self.list = tk.Listbox(self.body, height=10, activestyle="none")
        self.list.pack(fill="both", expand=True)
        self.buttons(("Cancel", self.abort, False))
        self.results = []

        def work():
            self.proc = subprocess.Popen([GNITO, "__wizard", "checks"], stdout=subprocess.PIPE, text=True)
            for line in self.proc.stdout:
                try:
                    c = json.loads(line)
                except ValueError:
                    continue
                self.results.append(c)
                self.root.after(0, self.add_check, c)
            self.proc.wait()
            self.res = api("resources")
            self.root.after(0, self.checks_done)
        threading.Thread(target=work, daemon=True).start()

    def add_check(self, c):
        mark = "✓" if c["ok"] else ("✗" if c["fatal"] else "!")
        self.list.insert("end", f" {mark}  {c['label']} — {c['detail']}")
        self.pb["value"] = len(self.results)

    def checks_done(self):
        if self.done:
            return
        fails = [f"{c['label']}: {c['detail']}" for c in self.results if c["fatal"] and not c["ok"]]
        if fails:
            messagebox.showerror("Indognito Setup", "This device can't run Indognito", detail="\n".join(fails))
            write_result("incompatible", "\n".join(fails))
            self.quit()
            return
        self.buttons(("Next", self.perms, True))

    # 3
    def perms(self):
        self.clear()
        self.h("How should Indognito be installed?")
        self.p("Continue installs for your account only (recommended). Continue as Administrator installs system-wide and is only needed for ports below 1024; you are asked for your password when installation starts.")
        self.buttons(("Cancel", self.abort, False), ("Continue as Administrator", lambda: self.pick("admin"), False),
                     ("Continue", lambda: self.pick("user"), True))

    def pick(self, mode):
        self.mode = mode
        self.res = api("resources", "--mode", mode)
        self.ports()

    # 4
    def ports(self):
        self.clear()
        self.root.geometry("880x600")
        self.h("Port configuration")
        self.be = tk.StringVar(value=str(self.existing.get("backendPort", 7710)))
        self.fe = tk.StringVar(value=str(self.existing.get("frontendPort", 7711)))
        self.grid_table(["Component", "Port", "Purpose"], [["Backend", self.be, "API and relay (127.0.0.1 only)"],
                                                           ["Frontend", self.fe, "Web interface"]])
        self.buttons(("Cancel", self.abort, False), ("Back", self.perms, False), ("Next", self.check_ports, True))

    def check_ports(self):
        args = ["validate-ports", "--backend", self.be.get() or "0", "--frontend", self.fe.get() or "0"] + (["--admin"] if self.mode == "admin" else [])
        errs = api(*args).get("errors", [])
        if errs:
            messagebox.showerror("Indognito Setup", "Please check the ports", detail="\n\n".join(errs))
            return
        self.storage()

    # 5
    def storage(self):
        self.clear()
        r = self.res
        relax = os.environ.get("GNITO_DEV_RELAX") == "1"
        mr, ms = (256, 512) if relax else (3072, 8192)
        self.ram = tk.StringVar(value=str(max(mr, min(4096, r.get("ramTotalMB", 0)))))
        self.store = tk.StringVar(value=str(max(ms, min(16384, r.get("storageAvailMB", 0)))))
        self.cores = tk.StringVar(value=str(r.get("cpuCores", 1)))
        self.pct = tk.StringVar(value="100")
        self.h("Storage allocations")
        self.grid_table(["Resource", "Minimum", "Maximum", "Allocate (MB)"], [
            ["RAM", f"{mr} MB", f"{r.get('ramTotalMB')} MB installed", self.ram],
            ["Storage", f"{ms} MB", f"{r.get('storageAvailMB')} MB free", self.store]])
        self.h("Processor allocation", 14)
        self.grid_table(["Detected", "Available", "Cores", "Per core (%)"], [
            [f"{r.get('cpuCores')} core(s)", f"{r.get('cpuCores', 1) * 100}%", self.cores, self.pct]])
        self.buttons(("Cancel", self.abort, False), ("Back", self.ports, False), ("Next", self.check_storage, True))

    def check_storage(self):
        vals = [v.get() or "0" for v in (self.ram, self.store, self.cores, self.pct)]
        errs = api("validate-alloc", "--ram", vals[0], "--storage", vals[1], "--cores", vals[2], "--pct", vals[3]).get("errors", [])
        if errs:
            messagebox.showerror("Indognito Setup", "These allocations are not possible", detail="\n\n".join(errs))
            return
        self.alloc = [int(v) for v in vals]
        self.dir = self.res["adminInstallDir"] if self.mode == "admin" else self.res["installDir"]
        self.confirm()

    # 6
    def confirm(self):
        self.clear()
        ram, store, cores, pct = self.alloc
        self.h("Ready to install")
        self.grid_table(["Setting", "Value"], [["Backend port", self.be.get()], ["Frontend port", self.fe.get()],
                                               ["Permission mode", "Administrator" if self.mode == "admin" else "Standard user"],
                                               ["RAM allocation", f"{ram} MB"], ["Storage allocation", f"{store} MB"],
                                               ["CPU allocation", f"{cores} core(s) at {pct}%"], ["Installation destination", self.dir]])
        self.p("Continue lets you choose a different installation folder first.")
        self.buttons(("Cancel", self.abort, False), ("Continue", self.choose, False), ("Install", self.install, True))

    def choose(self):
        d = filedialog.askdirectory(title="Choose the installation folder")
        if d:
            self.dir = os.path.join(d, "indognito")
        self.confirm()

    # 7
    def install(self):
        self.clear()
        self.h("Installing Indognito")
        self.ipb = ttk.Progressbar(self.body, maximum=100, length=700)
        self.ipb.pack(anchor="w", pady=10)
        self.vars = {k: tk.StringVar(value="—") for k in ("activity", "component", "dir", "transfer")}
        self.vars["dir"].set(self.dir)
        g = ttk.Frame(self.body)
        g.pack(anchor="w")
        for i, (k, label) in enumerate([("activity", "Current activity"), ("component", "Most recently installed"),
                                        ("dir", "Installation directory"), ("transfer", "Download / extraction")]):
            ttk.Label(g, text=label, font=("TkDefaultFont", 11, "bold")).grid(row=i, column=0, sticky="w", padx=(0, 16), pady=3)
            ttk.Label(g, textvariable=self.vars[k], wraplength=520).grid(row=i, column=1, sticky="w")
        self.buttons(("Cancel", lambda: self.abort("Installation was cancelled while in progress."), False))
        ram, store, cores, pct = self.alloc
        data = os.path.join(self.dir, "data")
        if self.existing.get("installDir") == self.dir:
            data = self.existing.get("dataDir", data)
        plan = {"mode": self.mode, "backend": int(self.be.get()), "frontend": int(self.fe.get()), "ramMB": ram, "storageMB": store,
                "cpuCores": cores, "cpuPercent": pct, "installDir": self.dir, "dataDir": data, "keepData": True, "stateFile": STATE,
                "env": {k: v for k, v in os.environ.items() if k in ("GNITO_RELEASE_URL", "GNITO_BUNDLE", "GNITO_DEV_RELAX", "GNITO_NODE_VERSION")}}
        pf = os.path.join(TMP, "plan.json")
        with open(pf, "w") as f:
            json.dump(plan, f)
        cmd = [GNITO, "__wizard", "install", "--plan", pf]
        if self.mode == "admin" and os.geteuid() != 0:
            if MAC:  # native macOS authorization dialog
                inner = " ".join("'" + a.replace("'", "'\\''") + "'" for a in cmd)
                cmd = ["osascript", "-e", f'do shell script "{inner}" with administrator privileges']
            elif shutil.which("pkexec"):
                cmd = ["pkexec", *cmd]

        def work():
            last = {}
            self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)
            for line in self.proc.stdout:
                for part in line.replace("\r", "\n").splitlines():
                    try:
                        p = json.loads(part)
                    except ValueError:
                        continue
                    last = p
                    self.root.after(0, self.progress, p)
            self.proc.wait()
            self.root.after(0, self.finished, last)
        threading.Thread(target=work, daemon=True).start()

    def progress(self, p):
        self.ipb["value"] = p.get("percent", 0)
        for k in ("activity", "component", "dir", "transfer"):
            if p.get(k):
                self.vars[k].set(p[k])

    def finished(self, last):
        if self.done:
            return
        if last.get("done") and not last.get("error"):
            self.clear()
            self.h("Everything has installed successfully!", 22)
            self.buttons(("OK", self.ok, True))
        else:
            reason = last.get("error") or "The installer stopped unexpectedly (authorization refused?)."
            messagebox.showerror("Indognito Setup", "Installation failed", detail=reason)
            write_result("failed", reason)
            self.quit()

    # 8
    def ok(self):
        write_result("installed")
        self.quit()


if __name__ == "__main__":
    root = tk.Tk()
    Wizard(root)
    root.mainloop()
