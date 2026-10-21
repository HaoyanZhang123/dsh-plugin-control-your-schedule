#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build the bundled handwriting subset used by the sticky-note page.

Input  : upstream LXGW WenKai Regular TTF (SIL Open Font License 1.1)
Output : assets/fonts/lxgw-wenkai-hand.woff2  (single file, WOFF2, no hinting)

The glyph inventory is fixed in code, so any run on any machine yields the same
character set: printable ASCII, the GB2312 symbol/punctuation block, GB2312
level-1 hanzi (3755) + level-2 hanzi (3008), plus a few UI symbols.

Dev-time dependencies only -- never a runtime dependency of the plugin:
    pip install fonttools brotli

Usage
    python tools/subset_font.py                       # build the woff2
    python tools/subset_font.py --check               # prove the committed file is up to date
    python tools/subset_font.py --source <path.ttf>   # explicit upstream font

Upstream URL, version, licence and the exact rebuild command: assets/fonts/SOURCE.md
"""
from __future__ import annotations

import argparse
import hashlib
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUTPUT = ROOT / "assets" / "fonts" / "lxgw-wenkai-hand.woff2"

# Pinned upstream release. Rebuilds must reproduce these values.
SOURCE_URL = "https://github.com/lxgw/LxgwWenKai/releases/download/v1.530/LXGWWenKai-Regular.ttf"
SOURCE_VERSION = "v1.530"
SOURCE_SHA256 = "2d73eea94ad808999d90c0000c239a84a33b09d4bc6ab6c5b8bbf1eda8a7fc8b"
SOURCE_BYTES = 25928940

# GB2312 rows: 0xA1-0xA9 symbols/punctuation, 0xB0-0xD7 level 1, 0xD8-0xF7 level 2.
GB2312_ROWS = ((0xA1, 0xA9), (0xB0, 0xD7), (0xD8, 0xF7))

# Symbols the page UI uses that live outside the GB2312 blocks.
UI_EXTRAS = "\u00b7\u2014\u2026\u22ef\u2022\u2197\u2713\u2717\u2318\u2325"

# Deliberately outside the plugin package: the 25 MB TTF must never be packed.
PROBE_SOURCE = (ROOT / ".." / ".." / ".." / "output" / "_probe" / "fontwork"
                / "LXGWWenKai-Regular.ttf")


def fail(message: str) -> None:
    print("FAIL:", message, file=sys.stderr)
    raise SystemExit(1)


def gb2312_chars(low: int, high: int) -> list:
    """Decode GB2312 rows [low, high] into characters (skipping undefined cells)."""
    out = []
    for lead in range(low, high + 1):
        for trail in range(0xA1, 0xFF):
            try:
                out.append(bytes((lead, trail)).decode("gb2312"))
            except UnicodeDecodeError:
                continue
    return out


def ascii_printable() -> list:
    return [chr(cp) for cp in range(0x20, 0x7F)]


def gb2312_symbols() -> list:
    return gb2312_chars(*GB2312_ROWS[0])


def gb2312_level1() -> list:
    return [ch for ch in gb2312_chars(*GB2312_ROWS[1]) if "\u4e00" <= ch <= "\u9fff"]


def gb2312_level2() -> list:
    return [ch for ch in gb2312_chars(*GB2312_ROWS[2]) if "\u4e00" <= ch <= "\u9fff"]


def groups() -> dict:
    return {
        "ascii": ascii_printable(),
        "gb2312-symbols": gb2312_symbols(),
        "gb2312-level1": gb2312_level1(),
        "gb2312-level2": gb2312_level2(),
        "ui-extras": list(UI_EXTRAS),
    }


def wanted_chars() -> list:
    return sorted({ch for chars in groups().values() for ch in chars})


def resolve_source(explicit: str | None) -> Path:
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_file():
            fail("source font not found: %s" % path)
        return path
    if PROBE_SOURCE.is_file():
        return PROBE_SOURCE.resolve()
    fail(
        "no upstream font found. Download (dev-time only, %d bytes, sha256 %s):\n  %s\n"
        "then rerun with --source <path.ttf>." % (SOURCE_BYTES, SOURCE_SHA256, SOURCE_URL)
    )


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def make_subset(source: Path, output: Path, wanted: list) -> dict:
    """Subset to WOFF2 and report what actually landed in the cmap."""
    try:
        from fontTools import subset
        from fontTools.ttLib import TTFont
    except ImportError as exc:  # dev environment guard
        fail("fontTools is required (dev-time only): pip install fonttools brotli -- %s" % exc)

    # recalcTimestamp=False keeps head.modified stable, so rebuilds are byte-identical.
    font = TTFont(str(source), recalcTimestamp=False)
    source_cmap = font.getBestCmap()
    kept = [ch for ch in wanted if ord(ch) in source_cmap]
    missing = [ch for ch in wanted if ord(ch) not in source_cmap]

    options = subset.Options()
    options.flavor = "woff2"            # --flavor=woff2
    options.hinting = False             # --no-hinting
    options.desubroutinize = True
    options.notdef_outline = True       # --notdef-outline
    options.recalc_bounds = True
    options.recalc_timestamp = False    # keep rebuilds byte-identical
    options.name_IDs = ["*"]
    options.name_languages = ["*"]
    options.name_legacy = True
    options.layout_features = ["*"]
    options.glyph_names = False
    options.drop_tables = list(options.drop_tables) + ["DSIG"]

    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text="".join(kept))
    subsetter.subset(font)

    output.parent.mkdir(parents=True, exist_ok=True)
    font.flavor = "woff2"
    font.save(str(output))

    return {
        "covered": len(kept),
        "missing": missing,
        "num_glyphs": font["maxp"].numGlyphs,
        "cmap_size": len(font.getBestCmap()),
    }


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(
        description="Build the bundled LXGW WenKai woff2 subset for the sticky-note page.")
    parser.add_argument("--source", help="upstream LXGWWenKai-Regular.ttf")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="woff2 output path")
    parser.add_argument("--check", action="store_true",
                        help="rebuild in a temp file and verify the committed woff2 matches")
    parser.add_argument("--allow-source-mismatch", action="store_true",
                        help="proceed even if the upstream font sha256 is not the pinned one")
    args = parser.parse_args(argv)

    source = resolve_source(args.source)
    actual = sha256_of(source)
    if actual != SOURCE_SHA256:
        if not args.allow_source_mismatch:
            fail("upstream font sha256 mismatch\n  expected %s\n  actual   %s\n"
                 "re-download %s or pass --allow-source-mismatch."
                 % (SOURCE_SHA256, actual, SOURCE_URL))
        print("WARN   : unpinned upstream font (sha256 %s); output may differ" % actual)

    output = Path(args.output)
    wanted = wanted_chars()
    # --check rebuilds into the system temp dir so the package tree never sees a
    # half-written font, even if the process is killed mid-run.
    tempdir = Path(tempfile.mkdtemp(prefix="subset-font-")) if args.check else None
    staging = (tempdir / output.name) if tempdir else output

    print("input  : %s" % source)
    print("         %d bytes, sha256 %s (pinned %s)" % (source.stat().st_size, actual, SOURCE_VERSION))
    print("target : %s" % output)
    try:
        result = make_subset(source, staging, wanted)
        covered = result["covered"]
        for label, chars in groups().items():
            print("group  : %-15s %5d codepoints" % (label, len(chars)))
        if result["missing"]:
            print("dropped: %d codepoints absent upstream: %s"
                  % (len(result["missing"]), "".join(result["missing"])))
        print("glyphs : %d glyphs, %d codepoints in cmap" % (result["num_glyphs"], result["cmap_size"]))
        print("cover  : %d / %d requested codepoints covered" % (covered, len(wanted)))

        if args.check:
            if not output.is_file():
                fail("nothing to compare: %s does not exist; run python tools/subset_font.py" % output)
            current = output.read_bytes()
            rebuilt = staging.read_bytes()
            if current != rebuilt:
                fail("committed woff2 is stale; run python tools/subset_font.py")
            print("bytes  : %d" % len(rebuilt))
            print("OK: %s is up to date" % output)
            return 0
    finally:
        if tempdir is not None:
            for leftover in tempdir.iterdir():
                leftover.unlink(missing_ok=True)
            tempdir.rmdir()

    size = output.stat().st_size
    print("bytes  : %d (%.2f MiB)" % (size, size / (1024 * 1024)))
    print("OK: wrote %s" % output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
