#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Project gates for dsh-plugin-control-your-schedule.

No third-party dependencies. Run from anywhere:
    python smoke/run_all_checks.py
Exit code 0 only when every check passes.
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugin" if (ROOT / "plugin" / "package.json").is_file() else ROOT
PAGE = PLUGIN / "assets" / "paper-os.html"
CLIENT = PLUGIN / "client.js"
PKG = PLUGIN / "package.json"
NODE = shutil.which("node") or shutil.which("node.exe") or ""

checks = []
skipped = []


def ok(name: str, detail: str = "") -> None:
    checks.append((True, name, detail))
    print("PASS | %s%s" % (name, (" | " + detail) if detail else ""))


def bad(name: str, detail: str) -> None:
    checks.append((False, name, detail))
    print("FAIL | %s | %s" % (name, detail))


def run(name: str, cmd: list[str], cwd: Path | None = None) -> None:
    try:
        proc = subprocess.run(cmd, cwd=str(cwd or ROOT), capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=120)
    except Exception as error:  # noqa: BLE001
        bad(name, "runner error: %r" % (error,))
        return
    out = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode == 0:
        ok(name, out.strip().splitlines()[-1][:160] if out.strip() else "")
    else:
        bad(name, "exit=%s %s" % (proc.returncode, out.strip()[:500]))


def main() -> int:
    if not PAGE.is_file():
        bad("page asset exists", str(PAGE))
        return 1
    page = PAGE.read_text(encoding="utf-8")

    removed = {
        "desktop icon container": 'id="desktop"',
        "desktop icon class": "desk-icon",
        "file cabinet string": "文件柜",
        "file cabinet app id": "id: 'files'",
        "old double-click copy": "双击纸页开始",
        "old left-entry copy": "打开左边一张纸",
        "window control buttons": "data-win-action",
        "dock caption": "点击图标打开应用",
        "desk focus placeholder": "选择底部应用开始",
        "desk intro caption": "从底部应用坞打开应用",
        "day card kicker": "TODAY'S PAPER",
        "notes foot auto-save copy": "自动保存 · 无需手动提交",
        "notes foot delete button": "删除这张纸页",
        "notes rail saved label": "已保存到纸屿",
        "day card overflow copy": "件 · 翻开日历",
        "sticky delete undo toast": "便签已经揭下来了",
        "settings header section list": "外观 · 数据 · 快捷键 · 关于",
        "hardcoded page version": "P.version = '1.",
    }
    for label, needle in removed.items():
        if needle in page:
            bad("removed: " + label, "still present: " + needle)
        else:
            ok("removed: " + label)

    expected = {
        "bottom dock home": 'data-testid="dock-home"',
        "sticky drag handle": 'class="sticky__drag"',
        "guided tour api": "P.tour =",
        "host bootstrap": "__SCHEDULE_HOST_SNAPSHOT__",
        "host save bridge": "__SCHEDULE_RESTART__",
        "dynamic day summary": "daySummaryText",
        "fixed right calendar rail": "right: 18px;",
        "uniform surface radius": "--radius-win: 18px;",
        "dialog radius": ".paper-dialog,",
        "window paper layers removed": ".window::before,",
        "delete palette action": "关闭当前窗口",
        "desktop click dismiss": "bindDesktopDismiss",
        "page version placeholder": "__PAGE_VERSION__",
        "schema is v2": "P.schemaVersion = 2;",
        "migration markers": "/* @migrate-begin */",
        "single ingest gate": "function ingestWorkspace(raw)",
        "priority table": "P.TASK_PRIORITIES = [",
        "task completion is day-based": "function setTaskDone(id, day, done)",
        "recurring resolution": "function resolveTask(id)",
        "sticky trash retention": "var TRASH_DAYS = 7;",
        "sticky raise on touch": "P.data.raiseSticky(",
        "whole-card sticky drag": "if (event.target.closest('.sticky__text, .sticky__swatches, .sticky__del')) return;",
        "theme resolution": "function resolveTheme(mode)",
        "host dark signal": "data-ds-dark-theme",
        "builtin hand font face": "font-family: \"LXGW WenKai\";",
        "corner toast placement": "placement: 'corner'",
        "almanac table": "var ALMANAC = [",
        "first open fills work area": "function defaultBounds(app)",
        "drawing paging": "function stepGallery(direction)",
        "drawing delete": "function confirmDeleteDrawing()",
    }
    for label, needle in expected.items():
        if needle in page:
            ok("present: " + label)
        else:
            bad("present: " + label, "missing: " + needle)

    app_ids = re.findall(r"id: '(stickies|notes|calendar|draw|files)'", page)
    if "files" not in app_ids and set(app_ids) == {"stickies", "notes", "calendar", "draw"}:
        ok("app registry has exactly 4 dock apps")
    else:
        bad("app registry", "found: %r" % (app_ids,))

    sizes = [float(value) for value in re.findall(r"font-size:\s*([0-9.]+)px", page)]
    if sizes and min(sizes) >= 10:
        ok("minimum font size", "min=%gpx, declarations=%d" % (min(sizes), len(sizes)))
    else:
        bad("minimum font size", "min=%r" % (min(sizes) if sizes else None,))

    if "--dock-height: 96px" in page and "width: 56px;" in page:
        ok("dock geometry", "height var 96px, button 56px")
    else:
        bad("dock geometry", "expected --dock-height: 96px and 56px dock buttons")

    pkg = json.loads(PKG.read_text(encoding="utf-8"))
    name = pkg.get("name")
    if name == "dsh-plugin-control-your-schedule":
        ok("package name")
    else:
        bad("package name", repr(name))
    if pkg.get("dsh", {}).get("bundle", {}).get("patch"):
        ok("package declares dsh.bundle.patch")
    else:
        bad("package declares dsh.bundle.patch", "missing")
    if pkg.get("dsh", {}).get("client", {}).get("platform") == "web":
        ok("package declares web client")
    else:
        bad("package declares web client", "missing")
    if pkg.get("private") is True:
        bad("package is publishable", "private=true")
    else:
        ok("package is publishable")

    if CLIENT.is_file():
        client = CLIENT.read_text(encoding="utf-8")
        if ("id: '" + name + "'") in client and "__PAGE_B64__" not in client and "var PAGE_B64 = '" in client:
            ok("client bundle matches package id and has embedded page")
        else:
            bad("client bundle", "id/placeholder mismatch")
        if NODE:
            run("client.js syntax", [NODE, "--check", str(CLIENT)])
        else:
            bad("client.js syntax", "node not found")
    else:
        bad("client bundle exists", str(CLIENT))

    run("build reproducibility", [sys.executable, str(PLUGIN / "tools" / "build_page.py"), "--check"])
    if NODE:
        run("host route persistence", [NODE, str(ROOT / "smoke" / "host_route_test.mjs")])
    else:
        bad("host route persistence", "node not found")

    # Toast policy guard: the desk must never stack toasts again. One node,
    # short dwell, newer message replaces the older one.
    toast_rules = {
        "single-slot variable": "var currentToast = null;",
        "replace instead of append": "region.removeChild(currentToast);",
        "duplicate detection": "if (signature === currentToastText) {",
        "dwell table": "var TOAST_DWELL = {",
        "dwell cap": "Math.min(dwell, TOAST_DWELL_MAX)",
    }
    missing_toast = [label for label, needle in toast_rules.items() if needle not in page]
    if missing_toast:
        bad("toast policy: single, short-lived", "missing: " + ", ".join(missing_toast))
    elif "existing.length > 3" in page:
        bad("toast policy: single, short-lived", "old stacking path still present: existing.length > 3")
    else:
        ok("toast policy: single, short-lived", "one slot, replace-in-place, capped dwell")

    # macOS fullscreen guard: the frame must subtract the top clearance from its
    # height. Pushing it down while keeping height:100% overflowed the panel by
    # 48px and the clip ate the bottom of the desk's dock.
    client_src = PLUGIN / "src" / "client.src.js"
    src_text = client_src.read_text(encoding="utf-8") if client_src.is_file() else ""
    if "calc(100% - var(--dsh-frame-top-clearance,48px))" in src_text:
        ok("macOS frame height accounts for top clearance")
    else:
        bad("macOS frame height accounts for top clearance", "frame height does not subtract --dsh-frame-top-clearance")

    # Structural regression guard: the window layer must live inside #stage.
    # A stray closing tag once moved it to page top, hiding every titlebar.
    from html.parser import HTMLParser
    class _Nest(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.stack = []
            self.parents = {}
        def handle_starttag(self, tag, attrs):
            attrs = dict(attrs)
            ident = attrs.get('id')
            if ident in ('stage', 'windows-layer', 'day-card', 'dock-wrap', 'first-run'):
                self.parents[ident] = list(self.stack)
            self.stack.append((tag, ident))
        def handle_endtag(self, tag):
            for index in range(len(self.stack) - 1, -1, -1):
                if self.stack[index][0] == tag:
                    del self.stack[index:]
                    break
    nest = _Nest(); nest.feed(page)
    stage_parents = {name: parents for name, parents in nest.parents.items()}
    required_inside_stage = ['windows-layer', 'day-card', 'dock-wrap', 'first-run']
    missing = [name for name in required_inside_stage if 'stage' not in [ident for _, ident in stage_parents.get(name, [])]]
    if missing:
        bad('DOM nesting: window layer inside #stage', 'outside stage: ' + ', '.join(missing))
    else:
        ok('DOM nesting: window layer inside #stage', 'all four key blocks inside stage')

    # --- migration / data-safety contracts ---
    # The page must offer exactly one ingest gate and no bare schema comparisons
    # outside it: a second load path is how "upgrade loses everyone's data" happens.
    # Four sources call it directly: recovery journal, import, replaceWith, start().
    # The Host snapshot deliberately funnels through start() instead of carrying a
    # second version comparison of its own.
    ingest_calls = page.count("P.ingestWorkspace(")
    if ingest_calls == 4:
        ok("all load paths go through ingestWorkspace", "%d call sites" % ingest_calls)
    else:
        bad("all load paths go through ingestWorkspace", "%d call sites (expected 4)" % ingest_calls)
    if "hostSnapshot.version === P.schemaVersion" in page:
        bad("host snapshot has no private version gate", "old equality check is back")
    else:
        ok("host snapshot has no private version gate")

    if page.count("raw.version !== P.schemaVersion") == 1:
        ok("schema equality checked once, inside validateWorkspace")
    else:
        bad("schema equality checked once, inside validateWorkspace",
            "%d occurrences" % page.count("raw.version !== P.schemaVersion"))

    client_src_path = PLUGIN / "src" / "client.src.js"
    if not any("done: !!" in line for line in page.splitlines() if "rawTask" in line):
        ok("task validator has no legacy done flag")
    else:
        bad("task validator has no legacy done flag", "rawTask.done still whitelisted")

    if "rawTask.doneOn" in page and "sanitizeDayKeys" in page:
        ok("validator keeps doneOn through strict whitelist")
    else:
        bad("validator keeps doneOn through strict whitelist", "doneOn would be dropped on load")

    # --- bundled font ---
    font = PLUGIN / "assets" / "fonts" / "lxgw-wenkai-hand.woff2"
    license_file = PLUGIN / "assets" / "fonts" / "LICENSE-lxgw-wenkai.txt"
    if font.is_file() and font.stat().st_size > 200000:
        ok("bundled handwriting font", "%d bytes" % font.stat().st_size)
    else:
        bad("bundled handwriting font", "missing or too small")
    if license_file.is_file() and "SIL OPEN FONT LICENSE" in license_file.read_text(encoding="utf-8").upper():
        ok("font license shipped")
    else:
        bad("font license shipped", "OFL text missing")
    if "FONT_ROUTE" in (PLUGIN / "index.js").read_text(encoding="utf-8"):
        ok("host serves the bundled font")
    else:
        bad("host serves the bundled font", "no font route in index.js")

    # --- build injects the page version ---
    if "__PAGE_VERSION__" in (PLUGIN / "tools" / "build_page.py").read_text(encoding="utf-8"):
        ok("build injects page version from package.json")
    else:
        bad("build injects page version from package.json", "build_page.py does not know the placeholder")
    built = CLIENT.read_text(encoding="utf-8") if CLIENT.is_file() else ""
    if str(pkg.get("version", "")) and str(pkg.get("version", "")) not in page:
        ok("page keeps the version placeholder only", "single source = package.json")
    else:
        bad("page keeps the version placeholder only", "page hardcodes a version")
    if str(pkg.get("version", "")) in built:
        ok("built client carries the package version", str(pkg.get("version")))
    else:
        bad("built client carries the package version", "version %s not found in client.js" % pkg.get("version"))

    # --- migration gate ---
    if NODE:
        run("migration v1 -> v2 keeps every byte", [NODE, str(ROOT / "smoke" / "migrate_test.mjs")])
    else:
        bad("migration v1 -> v2 keeps every byte", "node not found")

    # --- real browser (opt-in: needs a local browser binary) ---
    if "--cdp" not in sys.argv:
        skipped.append("real browser checks (page_e2e.mjs)")
        print("SKIP | real browser checks | 原因：未加 --cdp（需要本机浏览器；不加不算通过）")
    elif NODE:
        run("real browser checks", [NODE, str(ROOT / "smoke" / "page_e2e.mjs")])
    else:
        bad("real browser checks", "node not found")

    failed = [item for item in checks if not item[0]]
    if skipped:
        print("skip: %d (%s)" % (len(skipped), "; ".join(skipped)))
    print("checks: PASS %d / FAIL %d / SKIP %d" % (len(checks) - len(failed), len(failed), len(skipped)))
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
