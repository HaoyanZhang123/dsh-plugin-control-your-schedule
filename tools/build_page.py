#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build client.js from src/client.src.js and assets/paper-os.html.

The paper page is embedded as base64 so its inline script and CSS cannot break
the client bundle. Run with --check in CI / gates to prove the committed
client.js matches its inputs byte for byte.
"""
from __future__ import annotations

import base64
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "client.src.js"
PAGE = ROOT / "assets" / "paper-os.html"
OUT = ROOT / "client.js"
ICON = ROOT / "icon.svg"
SIDEBAR_ICON = ROOT / "sidebar-icon.svg"
ICON_STROKE = "#8a8f98"
PKG = ROOT / "package.json"


def fail(message: str) -> None:
    print("FAIL:", message)
    raise SystemExit(1)


def sidebar_icon() -> str:
    """侧栏图标：单色线性图，stroke=currentColor，跟着宿主深浅色自动变。"""
    if not SIDEBAR_ICON.is_file():
        fail("sidebar-icon.svg is missing")
    svg = SIDEBAR_ICON.read_text(encoding="utf-8").strip()
    if 'stroke="currentColor"' not in svg:
        fail("sidebar-icon.svg must use stroke=currentColor (the sidebar icon follows the host text colour)")
    return svg


def package_icon(svg: str) -> str:
    """包图标走 <img>，拿不到 currentColor，所以固定一个中性灰（深浅底都看得见）。"""
    return svg.replace('stroke="currentColor"', 'stroke="%s"' % ICON_STROKE)


def render() -> str:
    source = SRC.read_text(encoding="utf-8")
    page = PAGE.read_text(encoding="utf-8")
    package = json.loads(PKG.read_text(encoding="utf-8"))
    version = str(package.get("version", "0.0.0"))
    if "__PAGE_VERSION__" not in page:
        fail("paper-os.html lost its __PAGE_VERSION__ placeholder; the page version must come from package.json")
    # The page has one version source: package.json. Inject it before embedding.
    page = page.replace("__PAGE_VERSION__", version)
    if "__PAGE_VERSION__" in page:
        fail("unresolved __PAGE_VERSION__ remains in paper-os.html")
    encoded = base64.b64encode(page.encode("utf-8")).decode("ascii")
    icon = sidebar_icon()
    if "__PAGE_B64__" not in source:
        fail("client.src.js lost its __PAGE_B64__ placeholder")
    if "__STICKY_ICON_JSON__" not in source:
        fail("client.src.js lost its __STICKY_ICON_JSON__ placeholder")
    if "__VERSION__" not in source:
        fail("client.src.js lost its __VERSION__ placeholder")
    output = (source.replace("__PAGE_B64__", encoded)
                    .replace("__STICKY_ICON_JSON__", json.dumps(icon, ensure_ascii=False))
                    .replace("__VERSION__", version))
    for marker in ("__PAGE_B64__", "__STICKY_ICON_JSON__", "__VERSION__"):
        if marker in output:
            fail("unresolved placeholder remains in client.js: " + marker)
    if "__PAGE_VERSION__" in output:
        fail("unresolved placeholder remains in client.js: __PAGE_VERSION__")
    return output


def main() -> int:
    output = render()
    if "--check" in sys.argv:
        if not OUT.is_file():
            fail("client.js is missing; run python tools/build_page.py")
        if OUT.read_text(encoding="utf-8") != output:
            fail("client.js is stale; run python tools/build_page.py")
        print("OK: client.js is up to date")
        return 0
    OUT.write_text(output, encoding="utf-8")
    ICON.write_text(package_icon(sidebar_icon()) + "\n", encoding="utf-8")
    print("OK: wrote %s (%d bytes) and %s" % (OUT, len(output.encode("utf-8")), ICON))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
