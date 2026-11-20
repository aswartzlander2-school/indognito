#!/usr/bin/env python3
"""Indognito graphical setup wizard (GTK 3 — follows the desktop theme, e.g. Yaru on Ubuntu).

Launched by `gnito start`. All checks and the installation itself are done by the gnito
binary (`gnito __wizard ...`); this file is only the user interface.
"""
import json
import os
import shutil
import subprocess
import sys
import threading

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk, Pango  # noqa: E402

GNITO = os.environ.get("GNITO_BIN", "gnito")
RESULT = os.environ.get("GNITO_RESULT")
VERSION = os.environ.get("GNITO_VERSION", "1.0.0")
TMP = os.environ.get("GNITO_TMP", "/tmp")
STATE = os.environ.get("GNITO_STATE", "")
REINSTALL = os.environ.get("GNITO_REINSTALL") == "true"


def api(*args):
    out = subprocess.run([GNITO, "__wizard", *args], capture_output=True, text=True, timeout=120)
    return json.loads(out.stdout.strip().splitlines()[-1]) if out.stdout.strip() else {}


def write_result(outcome, reason=""):
    if RESULT:
        with open(RESULT, "w") as f:
            json.dump({"outcome": outcome, "reason": reason}, f)


class NumericEntry(Gtk.Entry):
    """An entry that only accepts digits."""

    def __init__(self, value, width=8, max_len=6):
        super().__init__()
        self.set_text(str(value))
        self.set_width_chars(width)
        self.set_max_length(max_len)
        self.set_input_purpose(Gtk.InputPurpose.DIGITS)
        self.connect("insert-text", self._filter)

    def _filter(self, entry, text, length, position):
        if not text.isdigit():
            entry.stop_emission_by_name("insert-text")
            entry.error_bell()

    def value(self):
        t = self.get_text().strip()
        return int(t) if t.isdigit() else -1


def heading(text, size="x-large"):
    lbl = Gtk.Label(xalign=0)
    lbl.set_markup(f"<span size='{size}' weight='bold'>{GLib.markup_escape_text(text)}</span>")
    lbl.set_line_wrap(True)
    return lbl


def para(text, dim=False):
    lbl = Gtk.Label(label=text, xalign=0)
    lbl.set_line_wrap(True)
    lbl.set_max_width_chars(70)
    if dim:
        lbl.get_style_context().add_class("dim-label")
    return lbl


def table(headers, rows, widths=None):
    """A simple bordered grid table built from standard widgets."""
    frame = Gtk.Frame()
    grid = Gtk.Grid(column_spacing=24, row_spacing=10, margin=14)
    for c, h in enumerate(headers):
        l = Gtk.Label(xalign=0)
        l.set_markup(f"<b>{GLib.markup_escape_text(h)}</b>")
        grid.attach(l, c, 0, 1, 1)
    grid.attach(Gtk.Separator(), 0, 1, len(headers), 1)
    for r, row in enumerate(rows):
        for c, cell in enumerate(row):
            w = cell if isinstance(cell, Gtk.Widget) else Gtk.Label(label=str(cell), xalign=0, selectable=True)
            grid.attach(w, c, r + 2, 1, 1)
    frame.add(grid)
    return frame


class Wizard(Gtk.Window):
    def __init__(self):
        super().__init__(title=f"Indognito {VERSION} Setup")
        self.set_default_size(760, 560)
        self.set_position(Gtk.WindowPosition.CENTER)
        self.set_icon_name("system-software-install")
        self.connect("delete-event", self.on_close)
        self.proc = None
        self.mode = "user"
        self.res = {}
        self.existing = {}
        self.done = False

        outer = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        self.add(outer)
        self.stack = Gtk.Stack(transition_type=Gtk.StackTransitionType.SLIDE_LEFT_RIGHT, transition_duration=220)
        self.stack.set_vexpand(True)
        outer.pack_start(self.stack, True, True, 0)
        outer.pack_start(Gtk.Separator(), False, False, 0)
        self.buttons = Gtk.Box(spacing=8, margin=12)
        outer.pack_end(self.buttons, False, False, 0)
        self.show_welcome()

    # ---------- helpers ----------
    def page(self, name, *children):
        old = self.stack.get_child_by_name(name)
        if old:
            self.stack.remove(old)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14, margin=28)
        for c in children:
            box.pack_start(c, False, False, 0)
        scroller = Gtk.ScrolledWindow(hscrollbar_policy=Gtk.PolicyType.NEVER)
        scroller.add(box)
        self.stack.add_named(scroller, name)
        scroller.show_all()
        self.stack.set_visible_child_name(name)
        return box

    def set_buttons(self, *specs):
        for c in self.buttons.get_children():
            self.buttons.remove(c)
        self.buttons.pack_start(Gtk.Box(), True, True, 0)
        default = None
        for label, cb, kind in specs:
            b = Gtk.Button(label=label)
            if kind == "primary":
                b.get_style_context().add_class("suggested-action")
                default = b
            b.connect("clicked", lambda _b, f=cb: f())
            self.buttons.pack_start(b, False, False, 0)
        self.buttons.show_all()
        if default:
            default.set_can_default(True)
            default.grab_default()
            default.grab_focus()

    def dialog(self, kind, title, text, button="OK"):
        d = Gtk.MessageDialog(transient_for=self, modal=True, message_type=kind, buttons=Gtk.ButtonsType.NONE, text=title)
        d.format_secondary_text(text)
        d.add_button(button, Gtk.ResponseType.OK)
        d.run()
        d.destroy()

    def abort(self, reason="You cancelled setup."):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()
        self.dialog(Gtk.MessageType.ERROR, "The installation process was aborted", reason, "OK")
        self.cleanup_staging()
        write_result("cancelled", reason)
        self.quit()

    def cleanup_staging(self):
        d = self.res.get("installDir") if self.mode == "user" else self.res.get("adminInstallDir")
        if d and os.path.isdir(d):
            for n in os.listdir(d):
                if n.startswith(".staging-"):
                    shutil.rmtree(os.path.join(d, n), ignore_errors=True)

    def quit(self):
        self.done = True
        Gtk.main_quit()

    def on_close(self, *_):
        if self.done:
            return False
        self.abort("The setup window was closed.")
        return True

    # ---------- 1. Welcome ----------
    def show_welcome(self):
        self.existing = api("existing")
        logo = Gtk.Label()
        logo.set_markup("<span size='xx-large' weight='heavy' foreground='#e0312b'>INDOGNITO</span>")
        logo.set_xalign(0)
        title = "Reinstall Indognito" if REINSTALL else f"Welcome to Indognito v{VERSION}"
        if REINSTALL:
            title = f"Welcome to Indognito v{VERSION}"
        kids = [logo, heading(title, "xx-large"),
                para("This assistant sets up Indognito on this computer: an isolated browser, a terminal, "
                     "file storage and an admin dashboard you open in your web browser.")]
        if self.existing.get("version"):
            kids.append(para(f"An existing installation (v{self.existing['version']}, {self.existing['mode']} mode) was found at "
                             f"{self.existing['installDir']}. Continuing will reinstall it; your accounts and workspaces are kept."))
        kids.append(para("Nothing is changed until you press Install on the last screen.", dim=True))
        self.page("welcome", *kids)
        self.set_buttons(("Cancel", lambda: self.abort(), None), ("Next", self.show_checks, "primary"))

    # ---------- 2. Compatibility ----------
    def show_checks(self):
        self.bar = Gtk.ProgressBar(show_text=True)
        self.check_list = Gtk.ListBox(selection_mode=Gtk.SelectionMode.NONE)
        self.check_list.get_style_context().add_class("frame")
        self.page("checks", heading("Checking if your device is compatible..."),
                  para("We're just checking to ensure we can stably run gnito on your machine. This will only take a moment."),
                  self.bar, self.check_list)
        self.set_buttons(("Cancel", lambda: self.abort(), None))
        self.results = []
        threading.Thread(target=self.run_checks, daemon=True).start()
        GLib.timeout_add(120, self.pulse_checks)

    def pulse_checks(self):
        if len(self.results) >= 10 or getattr(self, "checks_done", False):
            return False
        self.bar.set_fraction(min(0.95, len(self.results) / 10 + 0.02))
        return True

    def run_checks(self):
        self.proc = subprocess.Popen([GNITO, "__wizard", "checks"], stdout=subprocess.PIPE, text=True)
        for line in self.proc.stdout:
            try:
                c = json.loads(line)
            except ValueError:
                continue
            self.results.append(c)
            GLib.idle_add(self.add_check, c)
        self.proc.wait()
        self.res = api("resources")
        GLib.idle_add(self.checks_finished)

    def add_check(self, c):
        row = Gtk.Box(spacing=12, margin=8)
        icon = "emblem-ok-symbolic" if c["ok"] else ("dialog-error-symbolic" if c["fatal"] else "dialog-warning-symbolic")
        row.pack_start(Gtk.Image.new_from_icon_name(icon, Gtk.IconSize.BUTTON), False, False, 0)
        col = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        col.pack_start(Gtk.Label(label=c["label"], xalign=0), False, False, 0)
        d = para(c["detail"], dim=True)
        d.set_ellipsize(Pango.EllipsizeMode.END)
        col.pack_start(d, False, False, 0)
        row.pack_start(col, True, True, 0)
        row.show_all()
        self.check_list.add(row)
        self.bar.set_fraction(min(1.0, len(self.results) / 10))
        self.bar.set_text(f"{len(self.results)} of 10 checks")

    def checks_finished(self):
        self.checks_done = True
        if self.done:
            return
        self.bar.set_fraction(1.0)
        self.bar.set_text("Done")
        fails = [f"{c['label']}: {c['detail']}" for c in self.results if c["fatal"] and not c["ok"]]
        if fails:
            self.dialog(Gtk.MessageType.ERROR, "This device can't run Indognito",
                        "Setup stopped because these requirements are not met:\n\n• " + "\n• ".join(fails), "Close")
            write_result("incompatible", "\n".join(fails))
            self.quit()
            return
        self.set_buttons(("Cancel", lambda: self.abort(), None), ("Next", self.show_permissions, "primary"))

    # ---------- 3. Permissions ----------
    def show_permissions(self):
        self.page("perm", heading("How should Indognito be installed?"),
                  para("Continue installs Indognito for your account only, in your home folder. It needs no special "
                       "permissions and is the recommended choice."),
                  para("Continue as Administrator installs it system-wide and creates a system service that starts with "
                       "the computer. It is only needed for privileged ports (below 1024). You will be asked for your "
                       "password when the installation starts, not before."),
                  para("Indognito never asks for administrator rights unless you choose that option.", dim=True))
        has_elev = shutil.which("pkexec") is not None
        specs = [("Cancel", lambda: self.abort(), None)]
        if has_elev:
            specs.append(("Continue as Administrator", lambda: self.pick_mode("admin"), None))
        specs.append(("Continue", lambda: self.pick_mode("user"), "primary"))
        self.set_buttons(*specs)

    def pick_mode(self, mode):
        self.mode = mode
        self.res = api("resources", "--mode", mode)
        self.show_ports()

    # ---------- 4. Ports ----------
    def show_ports(self):
        self.resize(860, 600)
        be = self.existing.get("backendPort", 7710)
        fe = self.existing.get("frontendPort", 7711)
        self.be, self.fe = NumericEntry(be, 7, 5), NumericEntry(fe, 7, 5)
        note = ("Ports below 1024 are allowed because you chose the administrator install." if self.mode == "admin"
                else "Ports must be 1024 or higher for a standard install.")
        self.page("ports", heading("Port configuration"),
                  para("The frontend port is the address you open in a browser. The backend port is used internally "
                       "and only listens on this computer."),
                  table(["Component", "Port", "Purpose"], [
                      ["Backend", self.be, "API, terminal and browser relay (127.0.0.1 only)"],
                      ["Frontend", self.fe, "Web interface you open in your browser"]]),
                  para(note, dim=True))
        self.set_buttons(("Cancel", lambda: self.abort(), None), ("Back", self.show_permissions, None),
                         ("Next", self.check_ports, "primary"))

    def check_ports(self):
        args = ["validate-ports", "--backend", str(self.be.value()), "--frontend", str(self.fe.value())]
        if self.mode == "admin":
            args.append("--admin")
        errs = api(*args).get("errors", [])
        if errs:
            self.dialog(Gtk.MessageType.ERROR, "Please check the ports", "\n\n".join(errs))
            return
        self.ports = (self.be.value(), self.fe.value())
        self.show_storage()

    # ---------- 5. Storage allocations ----------
    def show_storage(self):
        r = self.res
        relax = os.environ.get("GNITO_DEV_RELAX") == "1"
        self.min_ram, self.min_store = (256, 512) if relax else (3072, 8192)
        total_ram, avail_store = r.get("ramTotalMB", 0), r.get("storageAvailMB", 0)
        self.ram = NumericEntry(max(self.min_ram, min(4096, total_ram)))
        self.store = NumericEntry(max(self.min_store, min(16384, avail_store)), 9, 9)
        cores = r.get("cpuCores", 1)
        self.cores = NumericEntry(cores, 4, 3)
        self.pct = NumericEntry(100, 4, 3)
        mb = lambda v: f"{v:,} MB ({v / 1024:.1f} GB)"
        self.page("storage", heading("Storage allocations"),
                  para("Choose how much of this computer Indognito's workspaces may use. Values are in megabytes."),
                  table(["Resource", "Minimum", "Maximum", "Allocate (MB)"], [
                      ["RAM", mb(self.min_ram), mb(total_ram) + " installed", self.ram],
                      ["Storage", mb(self.min_store), mb(avail_store) + " free", self.store]]),
                  heading("Processor allocation", "large"),
                  table(["Detected", "Available capacity", "Cores to use", "Capacity per core (%)"], [
                      [f"{cores} CPU core(s), {r.get('arch', '')}", f"{cores * 100}% (100% = one full core)", self.cores, self.pct]]))
        self.set_buttons(("Cancel", lambda: self.abort(), None), ("Back", self.show_ports, None),
                         ("Next", self.check_storage, "primary"))

    def check_storage(self):
        vals = [self.ram.value(), self.store.value(), self.cores.value(), self.pct.value()]
        if min(vals) < 0:
            self.dialog(Gtk.MessageType.ERROR, "Please fill in every value", "Each allocation must be a whole number.")
            return
        errs = api("validate-alloc", "--ram", str(vals[0]), "--storage", str(vals[1]), "--cores", str(vals[2]),
                   "--pct", str(vals[3])).get("errors", [])
        if errs:
            self.dialog(Gtk.MessageType.ERROR, "These allocations are not possible", "\n\n".join(errs))
            return
        self.alloc = vals
        self.install_dir = self.res["adminInstallDir"] if self.mode == "admin" else self.res["installDir"]
        if self.existing.get("installDir") and self.existing.get("mode") == self.mode:
            self.install_dir = self.existing["installDir"]
        self.show_confirm()

    # ---------- 6. Confirmation ----------
    def show_confirm(self):
        ram, store, cores, pct = self.alloc
        rows = [["Backend port", self.ports[0]], ["Frontend port", self.ports[1]],
                ["Permission mode", "Administrator" if self.mode == "admin" else "Standard user"],
                ["RAM allocation", f"{ram:,} MB"], ["Storage allocation", f"{store:,} MB"],
                ["CPU allocation", f"{cores} core(s) at {pct}%"], ["Installation destination", self.install_dir]]
        self.page("confirm", heading("Ready to install"), table(["Setting", "Value"], rows),
                  para("Install starts now. Continue lets you choose a different installation folder first.", dim=True))
        self.set_buttons(("Cancel", lambda: self.abort(), None), ("Continue", self.choose_dir, None),
                         ("Install", self.show_progress, "primary"))

    def choose_dir(self):
        d = Gtk.FileChooserDialog(title="Choose the installation folder", transient_for=self,
                                  action=Gtk.FileChooserAction.SELECT_FOLDER)
        d.add_buttons("Cancel", Gtk.ResponseType.CANCEL, "Select", Gtk.ResponseType.OK)
        if d.run() == Gtk.ResponseType.OK:
            self.install_dir = os.path.join(d.get_filename(), "indognito")
        d.destroy()
        self.show_confirm()

    # ---------- 7. Progress ----------
    def show_progress(self):
        self.pbar = Gtk.ProgressBar(show_text=True)
        self.l_activity = para("Starting…")
        self.l_component = para("—", dim=True)
        self.l_dir = para(self.install_dir, dim=True)
        self.l_transfer = para("—", dim=True)
        info = Gtk.Grid(column_spacing=18, row_spacing=8)
        for i, (k, v) in enumerate([("Current activity", self.l_activity), ("Most recently installed", self.l_component),
                                    ("Installation directory", self.l_dir), ("Download / extraction", self.l_transfer)]):
            lk = Gtk.Label(xalign=0)
            lk.set_markup(f"<b>{k}</b>")
            info.attach(lk, 0, i, 1, 1)
            info.attach(v, 1, i, 1, 1)
        self.page("progress", heading("Installing Indognito"), self.pbar, info)
        self.set_buttons(("Cancel", lambda: self.abort("Installation was cancelled while in progress."), None))
        ram, store, cores, pct = self.alloc
        data_dir = os.path.join(self.install_dir, "data") if self.mode == "user" else None
        if self.mode == "admin" and self.install_dir == self.res.get("adminInstallDir"):
            data_dir = "/var/lib/indognito"
        elif self.mode == "admin":
            data_dir = os.path.join(self.install_dir, "data")
        if self.existing.get("installDir") == self.install_dir:
            data_dir = self.existing.get("dataDir", data_dir)
        plan = {"mode": self.mode, "backend": self.ports[0], "frontend": self.ports[1], "ramMB": ram, "storageMB": store,
                "cpuCores": cores, "cpuPercent": pct, "installDir": self.install_dir, "dataDir": data_dir,
                "reinstall": bool(self.existing.get("version")), "keepData": True, "stateFile": STATE,
                "env": {k: v for k, v in os.environ.items() if k in ("GNITO_RELEASE_URL", "GNITO_BUNDLE", "GNITO_DEV_RELAX", "GNITO_NODE_VERSION")}}
        pf = os.path.join(TMP, "plan.json")
        with open(pf, "w") as f:
            json.dump(plan, f)
        os.chmod(pf, 0o644)
        cmd = [GNITO, "__wizard", "install", "--plan", pf]
        if self.mode == "admin" and os.geteuid() != 0:
            cmd = ["pkexec", *cmd]  # native Linux authorization prompt (polkit)
        threading.Thread(target=self.run_install, args=(cmd,), daemon=True).start()

    def run_install(self, cmd):
        last = {}
        try:
            self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, text=True)
            for line in self.proc.stdout:
                try:
                    p = json.loads(line)
                except ValueError:
                    continue
                last = p
                GLib.idle_add(self.update_progress, p)
            self.proc.wait()
            if self.proc.returncode in (126, 127) and cmd[0] == "pkexec" and not last:
                last = {"error": "Administrator authorization was refused or is not available."}
        except OSError as e:
            last = {"error": str(e)}
        GLib.idle_add(self.install_finished, last)

    def update_progress(self, p):
        if "percent" in p:
            self.pbar.set_fraction(p["percent"] / 100)
            self.pbar.set_text(f"{p['percent']}%")
        if p.get("activity"):
            self.l_activity.set_text(p["activity"])
        if p.get("component"):
            self.l_component.set_text(p["component"])
        if p.get("dir"):
            self.l_dir.set_text(p["dir"])
        if p.get("transfer"):
            self.l_transfer.set_text(p["transfer"])

    def install_finished(self, last):
        if self.done:
            return
        if last.get("done") and not last.get("error"):
            self.show_complete()
        else:
            reason = last.get("error") or "The installer stopped unexpectedly."
            self.dialog(Gtk.MessageType.ERROR, "Installation failed", reason, "Close")
            self.cleanup_staging()
            write_result("failed", reason)
            self.quit()

    # ---------- 8. Completion ----------
    def show_complete(self):
        self.page("complete", heading("Everything has installed successfully!", "xx-large"),
                  para("Press OK to close this window. The terminal will start Indognito and show the address to open."))
        self.set_buttons(("OK", self.finish_ok, "primary"))

    def finish_ok(self):
        write_result("installed")
        self.quit()


if __name__ == "__main__":
    win = Wizard()
    win.show_all()
    Gtk.main()
    sys.exit(0)
