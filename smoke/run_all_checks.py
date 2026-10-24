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

# Windows CI runners default stdout to cp1252, while every message here is Chinese:
# printing must never be the thing that turns a gate red. Pin UTF-8 explicitly.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - older streams may not support it
        pass

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
        "standalone command palette overlay": "palette-layer",
        "palette top-bar button": 'id="palette-btn"',
        "palette item class": "palette-item",
        "palette open function": "function openPalette()",
        "paper tone picker": "data-tones",
        "paper tone token": 'html[data-paper=',
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
        "command section panel": "data-section-panel=\"commands\"",
        "command section nav button": "data-section=\"commands\"",
        "command list is the shell's single source": "P.commands = {",
        "ctrl+k lands on the command section": "openSettings('commands')",
        "dock order preference": "dockOrder: []",
        "dock reordering entry": "function commitDockOrder(ids)",
        "settings icon is a gear": "M19.1 12a7 7 0 0 0-.1-1.2l2-1.5",
        "desktop click dismiss": "bindDesktopDismiss",
        "page version placeholder": "__PAGE_VERSION__",
        "schema is v3": "P.schemaVersion = 3;",
        "prompt app registered": "id: 'prompts',",
        "prompt sanitizer": "function sanitizePrompts(raw, now)",
        "prompt migration step": "2: function v2ToV3(raw)",
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

    app_ids = re.findall(r"id: '(stickies|prompts|notes|calendar|draw|files)'", page)
    if "files" not in app_ids and set(app_ids) == {"stickies", "prompts", "notes", "calendar", "draw"}:
        ok("app registry has exactly 5 dock apps")
    else:
        bad("app registry", "found: %r" % (app_ids,))

    # --- the README keeps its top banner, and every local image it points at exists ---
    # Twice now a README rewrite silently dropped the hero image (56aa9f8 removed the
    # file, a later sync removed the line). Both are cheap to assert, so assert them.
    # 中英两份 README 过同一条契约：顶部横幅在标题下方，且引用的本地图片真实存在。
    readme_paths = [PLUGIN / "README.md", PLUGIN / "README.en.md"]
    readme_counts = []
    readme_problems = []
    for readme_path in readme_paths:
        if not readme_path.is_file():
            readme_problems.append("%s missing" % readme_path.name)
            continue
        readme = readme_path.read_text(encoding="utf-8")
        imgs = re.findall(r'<img[^>]*src="([^"]+)"', readme)
        lines = readme.split("\n")
        h1 = next((i for i, line in enumerate(lines) if line.startswith("# ")), None)
        # the banner must live directly under the title, not just "somewhere above ##"
        banner_zone = lines[h1 + 1:h1 + 5] if h1 is not None else []
        has_banner = any("<img" in line for line in banner_zone)
        local = [src for src in imgs if not src.startswith(("http://", "https://"))]
        missing = [src for src in local if not (PLUGIN / src).is_file()]
        remote = [src for src in imgs if src.startswith(("http://", "https://"))]
        if not has_banner:
            readme_problems.append("%s: no <img> within 4 lines after the title" % readme_path.name)
        elif missing:
            readme_problems.append("%s: missing image files: %s" % (readme_path.name, ", ".join(missing)))
        else:
            readme_counts.append("%s %d/%d/%d" % (readme_path.name, len(imgs), len(local), len(remote)))
    if readme_problems:
        bad("README keeps its top banner", "; ".join(readme_problems))
    else:
        ok("README keeps its top banner", "images/local/remote: " + ", ".join(readme_counts))

    # --- every dock app must have its OWN icon ---
    # appIcon(id) silently falls back to the notes icon, so a missing or renamed key
    # ships the wrong icon with no error (this happened: key "prompt" vs id "prompts").
    registered = re.findall(r"P\.registerApp\(\{[^}]*?id: '([a-z-]+)'", page, re.S)
    icon_block = page.split("var appIcons = {", 1)[1].split("\n  };", 1)[0] if "var appIcons = {" in page else ""
    icon_keys = set(re.findall(r"^    ([A-Za-z]+): '<svg", icon_block, re.M))
    aliased = set(re.findall(r"^  appIcons\.([A-Za-z]+) = appIcons\.[A-Za-z]+;", page, re.M))
    missing_icons = [app for app in registered if app not in icon_keys and app not in aliased]
    if not missing_icons and registered:
        ok("every dock app has its own icon", "%d apps, %d icon keys" % (len(registered), len(icon_keys)))
    else:
        bad("every dock app has its own icon", "no icon key for: " + (", ".join(missing_icons) or "none registered"))

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
    # --- composer entry: slot + the public insertion face ---
    src_text = client_src.read_text(encoding="utf-8") if client_src.is_file() else ""
    client_needles = {
        "composer entry registers conversation.input.left": "conversation.input.left",
        "composer entry uses captureInsertion": "captureInsertion",
        "composer entry inserts through insertText": "insertText",
        "composer entry reads the shared workspace route": "loadPrompts",
    }
    missing_client = [label for label, needle in client_needles.items() if needle not in src_text]
    if missing_client:
        bad("composer prompt entry contract", "missing: " + ", ".join(missing_client))
    else:
        ok("composer prompt entry contract", "slot + public insertion API")

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

    # --- build reproducibility, deliberately LAST ---
    # "You edited the page but did not rebuild" is a bookkeeping failure, not a
    # product failure. Parking it before the specific assertions made every
    # page-side injection report only "stale bundle" and hid the real finding
    # (reverse audit 2026-10-21: deleting the prompt body cap went unnoticed).
    run("build reproducibility", [sys.executable, str(PLUGIN / "tools" / "build_page.py"), "--check"])

    # --- migration gate ---
    if NODE:
        run("migration v1 -> v3 keeps every byte", [NODE, str(ROOT / "smoke" / "migrate_test.mjs")])
    else:
        bad("migration v1 -> v3 keeps every byte", "node not found")

    # --- composer insertion model (pure, no browser needed) ---
    if NODE:
        run("prompt insertion model", [NODE, str(ROOT / "smoke" / "prompt_model_test.mjs")])
    else:
        bad("prompt insertion model", "node not found")

    # --- real browser (opt-in: needs a local browser binary) ---
    if "--cdp" not in sys.argv:
        skipped.append("real browser checks (page_e2e.mjs)")
        print("SKIP | real browser checks | 原因：未加 --cdp（需要本机浏览器；不加不算通过）")
    elif NODE:
        run("real browser checks", [NODE, str(ROOT / "smoke" / "page_e2e.mjs")])
    else:
        bad("real browser checks", "node not found")

    # --- composer entry on a real DSH (opt-in: needs DSH_BASE + DSH_WEB_TOKEN) ---
    composer_script = ROOT / "smoke" / "composer_e2e.mjs"
    if composer_script.is_file():
        if "--cdp" not in sys.argv:
            skipped.append("composer entry on a real DSH (composer_e2e.mjs)")
            print("SKIP | composer entry on a real DSH | 原因：未加 --cdp（需要真机 DSH 与 token；不加不算通过）")
        elif NODE:
            rc = run("composer entry on a real DSH", [NODE, str(composer_script)])
            if rc == 3:
                skipped.append("composer entry on a real DSH (no token)")
                print("SKIP | composer entry on a real DSH | 原因：缺 DSH_BASE / DSH_WEB_TOKEN")
        else:
            bad("composer entry on a real DSH", "node not found")

    # --- dark-mode contrast, computed from the token block itself ---
    # The complaint "labels are too faint" was measurable: ink-ghost on paper was 3.16:1.
    # Parse the real declared values so this cannot drift away from the CSS.
    def token(name: str, block: str) -> str:
        found = re.search(re.escape(name) + r"\s*:\s*(#[0-9a-fA-F]{6})", block)
        return found.group(1) if found else ""

    def lum(hex_color: str) -> float:
        r = int(hex_color[1:3], 16) / 255.0
        g = int(hex_color[3:5], 16) / 255.0
        b = int(hex_color[5:7], 16) / 255.0
        def ch(v: float) -> float:
            return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
        return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)

    def ratio(a: str, b: str) -> float:
        la, lb = lum(a), lum(b)
        hi, lo = max(la, lb), min(la, lb)
        return (hi + 0.05) / (lo + 0.05)

    dark_block = page.split('html[data-theme="dark"] {', 1)[1].split("}", 1)[0] if 'html[data-theme="dark"] {' in page else ""
    pairs = [
        ("--ink", "--paper", 12.0, "body text on the window"),
        ("--ink-soft", "--paper", 7.0, "secondary text on the window"),
        ("--ink-faint", "--paper-raised", 4.5, "hints on raised surfaces"),
        ("--ink-faint", "--paper", 5.0, "hints on the window"),
    ]
    contrast_failures = []
    contrast_values = []
    for fg_name, bg_name, floor, what in pairs:
        fg, bg = token(fg_name, dark_block), token(bg_name, dark_block)
        if not fg or not bg:
            contrast_failures.append("%s: token missing (%s/%s)" % (what, fg_name, bg_name))
            continue
        got = ratio(fg, bg)
        contrast_values.append("%s=%.2f" % (what, got))
        if got < floor:
            contrast_failures.append("%s: %.2f < %.1f (%s on %s)" % (what, got, floor, fg, bg))
    if contrast_failures:
        bad("dark text contrast floor", "; ".join(contrast_failures))
    else:
        ok("dark text contrast floor", ", ".join(contrast_values))

    # --- dark elevation ladder: desktop must be visibly darker than the paper ---
    desk = token("--desk-a", dark_block)
    paper = token("--paper", dark_block)
    if desk and paper:
        if lum(paper) - lum(desk) >= 0.004:
            ok("dark elevation ladder", "desk Y=%.4f < paper Y=%.4f" % (lum(desk), lum(paper)))
        else:
            bad("dark elevation ladder", "desk Y=%.4f vs paper Y=%.4f (too close)" % (lum(desk), lum(paper)))
    else:
        bad("dark elevation ladder", "tokens missing")

    # --- 深色里不能有「浅底 + ink 文字」却没落地的面 ---
    # 这类面在深色下是白底白字：hover 一下文字就消失了（坞提示条就是这么被发现的）。
    css = page.split("<style>", 1)[1].split("</style>", 1)[0] if "<style>" in page else ""
    rules = []
    pending_sel = []
    for line in css.splitlines():
        text = line.strip()
        if text.startswith("@") or not text:
            pending_sel = [] if text.startswith("@") else pending_sel
            continue
        if text.endswith("{"):
            sel = " ".join(pending_sel + [text[:-1]]).strip()
            pending_sel = []
            rules.append([sel, []])
            continue
        if text == "}":
            pending_sel = []
            continue
        if text.endswith(","):
            pending_sel.append(text.rstrip(","))
            continue
        if rules:
            rules[-1][1].append(text)
    def _luma(token):
        import re as _re
        rgba = _re.search(r"rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)", token)
        if rgba:
            r, g, b = (int(rgba.group(i)) for i in (1, 2, 3))
            return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
        hexm = _re.search(r"#([0-9a-fA-F]{6})", token)
        if hexm:
            h = hexm.group(1)
            r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
            return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
        return None
    # 已知死代码：文件柜（app 已删）与窗口三件套（0.1.2 已删按钮），保留 CSS 待清理。
    pill_allowlist = {".win-control", ".win-control:hover", ".filecrumbs button:hover"}
    pill_offenders = []
    for sel, decls in rules:
        plain = [s for s in sel.split(",") if s and not s.startswith('html[data-theme="dark"]')]
        if not plain:
            continue
        bg = next((d for d in decls if d.startswith("background")), None)
        if bg is None:
            continue
        lum = _luma(bg)
        if lum is None or lum < 0.8:
            continue
        if not any(d.startswith("color:") and "var(--ink" in d for d in decls):
            continue
        for one in plain:
            one = one.strip()
            if one in pill_allowlist:
                continue
            has_override = 'html[data-theme="dark"] ' + one in css
            if not has_override:
                pill_offenders.append(one)
    if pill_offenders:
        bad("no light pills left uncovered in dark", ", ".join(sorted(set(pill_offenders))[:6]))
    else:
        ok("no light pills left uncovered in dark", "every light surface with ink text has a dark override")

    # --- 深色不能盖灰纱：噪点只在浅色铺一层 ---
    dark_block_src = page.split('html[data-theme="dark"] {', 1)[1].split("}", 1)[0] if 'html[data-theme="dark"] {' in page else ""
    veil_rules = {
        "dark has no noise overlay": "--paper-noise: none;" in dark_block_src,
        "dark has no grain overlay": "--grain: none;" in dark_block_src,
        "only one noise layer per window": "background-image: var(--paper-noise);" not in page.split(".app {", 1)[1].split("}", 1)[0],
        "inactive window does not dim its body": ".window:not(.is-focused) .window__body {" not in page,
        "long buttons never wrap": "white-space: nowrap;" in page.split(".paper-btn {", 1)[1].split("}", 1)[0],
        "sidebar icon follows host colour": 'stroke="currentColor"' in (PLUGIN / "sidebar-icon.svg").read_text(encoding="utf-8") if (PLUGIN / "sidebar-icon.svg").is_file() else False,
        "build reads the sidebar icon": "sidebar-icon.svg" in (PLUGIN / "tools" / "build_page.py").read_text(encoding="utf-8"),
    }
    missing_veil = [label for label, okk in veil_rules.items() if not okk]
    if missing_veil:
        bad("dark mode is not veiled", "missing: " + ", ".join(missing_veil))
    else:
        ok("dark mode is not veiled", "no noise in dark, single layer, no inactive dimming")

    # --- 拖拽的输入路径：触屏不能被浏览器抢手势，取消也不能落盘 ---
    drag_rules = {
        "dock disables browser gestures": ".dock {\n  position: relative;\n  display: flex;\n  height: 70px;\n  touch-action: none;",
        "dock button disables browser gestures": "  display: grid;\n  touch-action: none;",
        "cancel path does not commit": "function onDockPointerCancel()",
        "cancel is bound separately": "window.addEventListener('pointercancel', onDockPointerCancel);",
        "reorder announces position": "function announceDockMove(appId, ids)",
        "command input is a combobox": 'role="combobox"',
        "active option is announced": "setAttribute('aria-activedescendant'",
    }
    missing_drag = [label for label, needle in drag_rules.items() if needle not in page]
    if missing_drag:
        bad("drag + screen reader contract", "missing: " + ", ".join(missing_drag))
    elif "window.addEventListener('pointercancel', onDockPointerUp);" in page:
        bad("drag + screen reader contract", "pointercancel still commits the order")
    else:
        ok("drag + screen reader contract", "touch-action + cancel split + live announcement")

    # --- 端口：ghost 只做装饰，不许当正文 ---
    # 白名单而不是计数：计数只要有人重排 CSS 就会假红/假绿。
    # 允许 ghost 的地方只有三类：占位符、装饰性伪元素/箭头、关闭键。
    ghost_selectors = []
    current_selector = ""
    for line in page.splitlines():
        stripped = line.strip()
        if stripped.endswith("{") and not stripped.startswith(("@", "--")) and not re.search(r"@media|@keyframes|@supports|@font-face", stripped):
            current_selector = stripped[:-1].strip()
        if "color: var(--ink-ghost);" in line:
            ghost_selectors.append(current_selector)
    allowed = re.compile(r"(::placeholder|::before|::after|\bcrumb-sep\b|shortcut-keys|setting-action__arrow|desk-notice__close)")
    offenders = [sel for sel in ghost_selectors if not allowed.search(sel)]
    if offenders:
        bad("ghost stays a decoration token", "used as text by: " + ", ".join(offenders[:6]))
    else:
        ok("ghost stays a decoration token", "%d uses, all placeholders/decorations" % len(ghost_selectors))

    # --- 结构：命令分区必须排在设置导航第一位，且默认分区仍是外观 ---
    if '"commands"' in page and "setSection('commands')" not in page:
        ok("command section is not a second entry point", "no standalone open-command-section call")
    else:
        bad("command section is not a second entry point", "a separate command section opener is back")

    failed = [item for item in checks if not item[0]]
    if skipped:
        print("skip: %d (%s)" % (len(skipped), "; ".join(skipped)))
    print("checks: PASS %d / FAIL %d / SKIP %d" % (len(checks) - len(failed), len(failed), len(skipped)))
    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
