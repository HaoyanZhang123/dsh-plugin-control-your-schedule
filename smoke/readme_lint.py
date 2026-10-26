#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""README structure lint for dsh-plugin-control-your-schedule. Stdlib only.

GitHub renders a standalone <img> line as a raw HTML block (CommonMark type 7),
and that block runs until the next blank line. A feature line such as
"- **feature**" placed right after a screenshot is therefore emitted as literal
text and the list never renders. Both READMEs must surround every standalone
<img> line with blank lines. The banner / local-image contract already enforced
by run_all_checks.py is carried here too, so wiring this tool into the gate
loses no coverage.

Usage (run from anywhere):
    python smoke/readme_lint.py                       # lint README.md and README.en.md
    python smoke/readme_lint.py --self-test           # fixtures: good PASS, bad FAIL + line
    python smoke/readme_lint.py --plugin-dir <dir>    # point at a copy (fixtures / CI)
Exit code: 0 only when every check passes, 1 when anything is reported.
"""
from __future__ import annotations

import argparse
import contextlib
import io
import re
import sys
import tempfile
from pathlib import Path

# Windows CI runners default stdout to cp1252 while the messages are Chinese:
# printing must never be the thing that turns a gate red.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - older streams may not support it
        pass

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugin" if (ROOT / "plugin" / "package.json").is_file() else ROOT
README_NAMES = ("README.md", "README.en.md")
REMOTE_PREFIXES = ("http://", "https://")
IMAGE_RE = re.compile(r'<img[^>]*src="([^"]+)"')


def is_blank(line: str) -> bool:
    return not line.strip()


def standalone_img_lines(lines: list[str]):
    """Yield (0-based index, stripped text) for lines that are one <img ...> tag."""
    for index, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("<img") and stripped.endswith(">"):
            yield index, stripped


def lint_readme(path: Path, plugin_dir: Path = PLUGIN) -> tuple[list[str], str]:
    """Return (problems, stats) for one README; every problem names file + line."""
    name = path.name
    text = path.read_text(encoding="utf-8")
    lines = text.split("\n")
    problems: list[str] = []

    standalone = 0
    for index, _tag in standalone_img_lines(lines):
        standalone += 1
        line_no = index + 1
        if index > 0 and not is_blank(lines[index - 1]):
            problems.append(
                "%s L%d: standalone <img> must be preceded by a blank line (found %r)"
                % (name, line_no, lines[index - 1].strip()[:60]))
        if index + 1 < len(lines) and not is_blank(lines[index + 1]):
            problems.append(
                "%s L%d: standalone <img> must be followed by a blank line (found %r)"
                % (name, line_no, lines[index + 1].strip()[:60]))

    # the banner must live directly under the title, not just "somewhere above ##"
    h1 = next((i for i, line in enumerate(lines) if line.startswith("# ")), None)
    banner_zone = lines[h1 + 1:h1 + 5] if h1 is not None else []
    if not any("<img" in line for line in banner_zone):
        problems.append("%s: no <img> within 4 lines after the title" % name)

    # every local image must exist next to the README
    sources = IMAGE_RE.findall(text)
    local = [src for src in sources if not src.startswith(REMOTE_PREFIXES)]
    missing = [src for src in local if not (plugin_dir / src).is_file()]
    if missing:
        problems.append("%s: missing image files: %s" % (name, ", ".join(missing)))

    stats = "%d standalone <img> framed by blank lines; banner under title; %d images (%d local, %d remote)" % (
        standalone, len(sources), len(local), len(sources) - len(local))
    return problems, stats


def check(plugin_dir: Path = PLUGIN) -> list[tuple[str, str, list[str]]]:
    """Return [(readme name, stats, problems)] for every README that must exist."""
    reports: list[tuple[str, str, list[str]]] = []
    for name in README_NAMES:
        path = plugin_dir / name
        if not path.is_file():
            reports.append((name, "", ["%s: missing" % name]))
            continue
        found, stats = lint_readme(path, plugin_dir)
        reports.append((name, stats, found))
    return reports


def run(plugin_dir: Path = PLUGIN) -> int:
    reports = check(plugin_dir)
    total = 0
    for name, stats, found in reports:
        if found:
            total += len(found)
            print("FAIL | %s | %d problem(s)" % (name, len(found)))
            for problem in found:
                print("  - " + problem)
        else:
            print("PASS | %s | %s" % (name, stats))
    if total:
        print("readme_lint.py: FAIL（%d 项）" % total)
        return 1
    print("readme_lint.py: PASS（%d 份 README · 独立 <img> 空行 + 顶部横幅 + 本地图片存在）"
          % len(reports))
    return 0


# ------------------------------------------------------------------ self-test
def _fixture(*, bad_before: bool = False, bad_after: bool = False,
             drop_banner: bool = False) -> tuple[str, int]:
    """A README whose only screenshot is framed correctly unless asked otherwise."""
    lines = ["# demo", ""]
    if not drop_banner:
        lines += ['<img width="2172" alt="banner" src="assets/banner.webp">', ""]
    else:
        # push the screenshot out of the 4-line banner zone so the banner check really fires
        lines += ["Some intro paragraph.", ""]
    lines += ["- **one**: text"]
    if not bad_before:
        lines.append("")
    shot_index = len(lines)
    lines.append('<img width="1400" alt="shot" src="assets/shot.webp">')
    if not bad_after:
        lines.append("")
    lines += ["- **two**: text", ""]
    return "\n".join(lines), shot_index + 1


def _write_fixture(root: Path, *, assets: bool = True, crlf: bool = False,
                   **flags) -> int:
    (root / "assets").mkdir(parents=True)
    text, shot_line = _fixture(**flags)
    if assets:
        for asset in ("banner.webp", "shot.webp"):
            (root / "assets" / asset).write_bytes(b"fixture")
    payload = text.replace("\n", "\r\n") if crlf else text
    for name in README_NAMES:
        (root / name).write_bytes(payload.encode("utf-8"))
    return shot_line


def _exit_code(plugin_dir: Path) -> tuple[int, str]:
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = run(plugin_dir)
    return code, buffer.getvalue()


def self_test() -> int:
    """正反两侧：好样例必须绿，已知坏输入必须红并点名行号；夹具真写盘。"""
    fails: list[str] = []

    def probe(**kwargs):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            shot_line = _write_fixture(root, **kwargs)
            code, output = _exit_code(root)
            return code, output, shot_line

    # 正向 1：好样例（截图前后都有空行）→ 必须绿
    code, output, _line = probe()
    if code != 0:
        fails.append("正向 1：好样例应 PASS，实际 exit=%s\n%s" % (code, output))
    # 正向 2：同一好样例用 CRLF 写盘（工作区真实形态）→ 也必须绿
    code, output, _line = probe(crlf=True)
    if code != 0:
        fails.append("正向 2：CRLF 好样例应 PASS，实际 exit=%s\n%s" % (code, output))
    # 反向 1：img 紧邻下一行列表（真实复发的坏形态）→ 必须红并点名行号
    code, output, shot_line = probe(bad_after=True)
    if code != 1:
        fails.append("反向 1：img 后缺空行必须 exit=1，实际 exit=%s" % code)
    if ("README.md L%d" % shot_line) not in output or "followed by a blank line" not in output:
        fails.append("反向 1：必须点名 README.md L%d 与 after 原因，实际输出：\n%s" % (shot_line, output))
    # 反向 2：img 紧邻上一行列表正文 → 必须红并点名行号
    code, output, shot_line = probe(bad_before=True)
    if code != 1:
        fails.append("反向 2：img 前缺空行必须 exit=1，实际 exit=%s" % code)
    if ("README.md L%d" % shot_line) not in output or "preceded by a blank line" not in output:
        fails.append("反向 2：必须点名 README.md L%d 与 before 原因，实际输出：\n%s" % (shot_line, output))
    # 反向 3：本地图片文件不存在 → 必须红并点名文件
    code, output, _line = probe(assets=False)
    if code != 1 or "missing image files" not in output or "assets/shot.webp" not in output:
        fails.append("反向 3：缺本地图片必须红并点名 assets/shot.webp，实际 exit=%s\n%s" % (code, output))
    # 反向 4：标题下没有横幅 → 必须红并点名横幅契约
    code, output, _line = probe(drop_banner=True)
    if code != 1 or "no <img> within 4 lines after the title" not in output:
        fails.append("反向 4：缺顶部横幅必须红，实际 exit=%s\n%s" % (code, output))

    if fails:
        print("readme_lint.py --self-test: FAIL")
        for item in fails:
            print("  - " + item)
        return 1
    print("readme_lint.py --self-test: PASS（正向 2 + 反向 4；夹具真写盘，坏样例真红并点名行号，"
          "临时目录自动清理不留产物）")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="README 结构门禁：独立 <img> 前后空行 + 顶部横幅 + 本地图片存在")
    parser.add_argument("--self-test", action="store_true",
                        help="离线自检：好样例 PASS，坏样例 FAIL 并点名行号")
    parser.add_argument("--plugin-dir", type=Path, default=None,
                        help="插件目录（默认按本文件位置自动发现；供夹具 / CI 指向临时副本）")
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    return run(args.plugin_dir or PLUGIN)


if __name__ == "__main__":
    sys.exit(main())
