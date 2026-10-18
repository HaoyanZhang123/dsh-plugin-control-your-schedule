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

    failed = [item for item in checks if not item[0]]
    print("checks: PASS %d / FAIL %d" % (len(checks) - len(failed), len(failed)))
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
