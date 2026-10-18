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
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src" / "client.src.js"
PAGE = ROOT / "assets" / "paper-os.html"
OUT = ROOT / "client.js"
ICON = ROOT / "icon.svg"
PKG = ROOT / "package.json"


def fail(message: str) -> None:
    print("FAIL:", message)
    raise SystemExit(1)


def extract_icon(page: str) -> str:
    match = re.search(r"sticky:\s*'((?:<svg).*?</svg>)'", page, re.S)
    if not match:
        fail("could not find the sticky app icon in assets/paper-os.html")
    svg = match.group(1)
    svg = re.sub(r"<svg\b[^>]*>", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">', svg, count=1)
    return svg


def render() -> str:
    source = SRC.read_text(encoding="utf-8")
    page = PAGE.read_text(encoding="utf-8")
    package = json.loads(PKG.read_text(encoding="utf-8"))
    version = str(package.get("version", "0.0.0"))
    encoded = base64.b64encode(page.encode("utf-8")).decode("ascii")
    icon = extract_icon(page)
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
    page = PAGE.read_text(encoding="utf-8")
    ICON.write_text(extract_icon(page) + "\n", encoding="utf-8")
    print("OK: wrote %s (%d bytes) and %s" % (OUT, len(output.encode("utf-8")), ICON))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
