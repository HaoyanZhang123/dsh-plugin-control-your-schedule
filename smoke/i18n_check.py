#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""English page coverage gate (stdlib only).

Builds the en variant in memory and proves it is actually English:
  1. no CJK outside the brand whitelist (comments and F() template keys are
     not page copy, so both are masked first);
  2. en.json is a real lookup table: every key is consumed by the build (dead
     keys fail) and every value is non-empty;
  3. F() first arguments === en.templates.json keys (missing 0 / unused 0):
     a template key that was rewritten by the build would make F() fall back
     to mixed Chinese/English;
  4. every template value is English and keeps the source's {placeholders};
  5. the generated inline scripts pass node --check (SKIP if node is absent).

Usage:
    python smoke/i18n_check.py              # gate the real en page
    python smoke/i18n_check.py --self-test  # mutated fixtures: every one must go red
Exit code: 0 only when every check passes.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001 - older streams may not support it
        pass

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "plugin" if (ROOT / "plugin" / "package.json").is_file() else ROOT
# Importing the build script must not leave __pycache__ inside the package.
sys.dont_write_bytecode = True
sys.path.insert(0, str(PLUGIN / "tools"))
import build_page  # noqa: E402 - shares the exact F()/literal rules with the build

CJK = re.compile(r"[\u4e00-\u9fff]")
PLACEHOLDER = re.compile(r"\{([A-Za-z0-9_]+)\}")
SCRIPT_RE = re.compile(r"<script\b([^>]*)>(.*?)</script>", re.S | re.I)
WHITELIST = ("屿",)  # brand glyph on the favicon / paper seals


class LookupRecorder(dict):
    """A dict that records every key translate_page actually asks for.

    Dead dictionary entries are invisible to a substring scan (a stale fragment
    such as "张" still appears inside other copy), so the gate observes real
    lookups instead of guessing from the source text.
    """

    def __init__(self, table):
        super().__init__(table)
        self.used: set[str] = set()

    def get(self, key, default=None):
        self.used.add(key)
        return super().get(key, default)


def strip_cjk(text: str) -> str:
    for char in WHITELIST:
        text = text.replace(char, "")
    return text


def scan_page(en_page: str) -> list[str]:
    """CJK left in real page copy. F() template keys are runtime data, not copy."""
    clean = build_page.mask_f_args(build_page.strip_comments(en_page))
    problems = []
    for line_no, line in enumerate(clean.splitlines(), 1):
        if not CJK.search(line):
            continue
        if CJK.search(strip_cjk(line)):
            problems.append("en page L%d: %s" % (line_no, line.strip()[:160]))
    return problems


def check_dictionary(table: dict, used: set[str]) -> list[str]:
    """No dead keys: every en.json entry must be consumed by a real lookup."""
    if not isinstance(table, dict):
        return ["en.json is not a flat object"]
    problems: list[str] = []
    unused = sorted(key for key in table if key not in used)
    if unused:
        problems.append("en.json has keys no lookup consumes (%d): %s"
                        % (len(unused), ", ".join(unused[:10])))
    empty = [key for key, value in table.items()
             if not isinstance(value, str) or not value.strip()]
    if empty:
        problems.append("en.json has empty / non-string values (%d): %s"
                        % (len(empty), ", ".join(sorted(empty)[:10])))
    return problems


def _template_values(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [value[key] for key in ("one", "other") if isinstance(value.get(key), str)]
    return []


def check_templates(source: str, en_page: str, templates: dict) -> list[str]:
    """F() keys must align both ways and every template value must be English."""
    problems: list[str] = []
    if not isinstance(templates, dict):
        return ["en.templates.json is not an object"]
    source_keys = build_page.f_template_keys(source)
    page_keys = build_page.f_template_keys(en_page)
    template_keys = set(templates)

    missing = sorted(source_keys - template_keys)
    if missing:
        problems.append("F() templates missing from en.templates.json (%d): %s"
                        % (len(missing), " | ".join(missing[:6])))
    orphan = sorted(template_keys - source_keys)
    if orphan:
        problems.append("en.templates.json keys no F() uses (%d): %s"
                        % (len(orphan), " | ".join(orphan[:6])))
    rewritten = sorted(page_keys ^ source_keys)
    if rewritten:
        problems.append("en page F() keys were rewritten by the build (%d): %s"
                        % (len(rewritten), " | ".join(rewritten[:6])))

    for key, value in templates.items():
        values = _template_values(value)
        if not values:
            problems.append("en.templates.json %r has no English value" % key)
            continue
        if isinstance(value, dict) and set(value) - {"one", "other"}:
            problems.append("en.templates.json %r uses unknown plural keys: %s"
                            % (key, sorted(set(value) - {"one", "other"})))
        for text in values:
            if CJK.search(strip_cjk(text)):
                problems.append("en.templates.json %r value still has Chinese: %r"
                                % (key, text[:80]))
            if set(PLACEHOLDER.findall(text)) != set(PLACEHOLDER.findall(key)):
                problems.append("en.templates.json %r placeholders differ: source %s / value %s"
                                % (key, sorted(set(PLACEHOLDER.findall(key))),
                                   sorted(set(PLACEHOLDER.findall(text)))))
    return problems


def check_scripts(en_page: str) -> tuple[list[str], list[str]]:
    """node --check every inline script (the build injects one of them)."""
    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        return [], ["node not found; inline-script syntax check"]
    problems: list[str] = []
    scripts = [(attrs, body) for attrs, body in SCRIPT_RE.findall(en_page)
               if body.strip() and "src=" not in attrs]
    for index, (_attrs, body) in enumerate(scripts):
        with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False,
                                         encoding="utf-8", newline="\n") as handle:
            handle.write(body)
            path = handle.name
        try:
            proc = subprocess.run([node, "--check", path], capture_output=True,
                                  text=True, encoding="utf-8", errors="replace",
                                  timeout=120)
        finally:
            Path(path).unlink(missing_ok=True)
        if proc.returncode != 0:
            problems.append("en page inline script %d fails node --check: %s"
                            % (index, (proc.stderr or proc.stdout).strip()[:400]))
    return problems, []


def build_en(source: str, table: dict, templates: dict) -> str:
    page, _stats = build_page.build_en_page(
        source, build_page.package_version(), table, templates)
    return page


def translate_with_recorder(source: str, table: dict,
                            templates: dict) -> tuple[str, set[str]]:
    """Build the en page while recording which dictionary keys were looked up."""
    recorder = LookupRecorder(table)
    page, _stats = build_page.build_en_page(
        source, build_page.package_version(), recorder, templates)
    return page, recorder.used


def plugin_files(plugin_dir: Path = PLUGIN) -> tuple[str, dict, dict] | None:
    page_path = plugin_dir / "assets" / "paper-os.html"
    en_json = plugin_dir / "assets" / "i18n" / "en.json"
    en_templates = plugin_dir / "assets" / "i18n" / "en.templates.json"
    missing = [path.name for path in (page_path, en_json, en_templates)
               if not path.is_file()]
    if missing:
        print("FAIL | i18n inputs | missing %s" % ", ".join(missing))
        return None
    source = page_path.read_text(encoding="utf-8")
    table = json.loads(en_json.read_text(encoding="utf-8"))
    templates = json.loads(en_templates.read_text(encoding="utf-8"))
    return source, table, templates


def run(plugin_dir: Path = PLUGIN) -> int:
    inputs = plugin_files(plugin_dir)
    if inputs is None:
        print("i18n_check.py: FAIL（缺 i18n 输入）")
        return 1
    source, table, templates = inputs
    en_page, used = translate_with_recorder(source, table, templates)

    scan = scan_page(en_page)
    dictionary = check_dictionary(table, used)
    template_problems = check_templates(source, en_page, templates)
    script_problems, skips = check_scripts(en_page)

    failures = 0
    for name, problems in (("en page has no CJK copy", scan),
                           ("en.json keys and values", dictionary),
                           ("F() templates align with the en page", template_problems),
                           ("en page inline scripts parse", script_problems)):
        if problems:
            failures += len(problems)
            print("FAIL | %s | %d problem(s)" % (name, len(problems)))
            for problem in problems:
                print("  - " + problem)
        else:
            print("PASS | %s" % name)
    for note in skips:
        print("SKIP | " + note)
    if failures:
        print("i18n_check.py: FAIL（%d 项，SKIP %d 项）" % (failures, len(skips)))
        return 1
    print("i18n_check.py: PASS（en 页 CJK 白名单 %s；F 模板 %d 条对齐；SKIP %d 项）"
          % ("/".join(WHITELIST), len(templates), len(skips)))
    return 0


# ------------------------------------------------------------------ self-test
GOOD_DICT = {
    "纸屿测试": "Paper Isle test",
    "你好": "Hello",
    "保存": "Save",
    "打开": "Open",
    "搜索": "Search",
}
GOOD_TEMPLATES = {
    "点<b>按钮</b>完成。": "Tap <b>Button</b> to finish.",
    "还有 {n} 件": {"one": "{n} item left", "other": "{n} items left"},
}
FIXTURE = """<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="paper-version" content="__PAGE_VERSION__">
  <title>纸屿测试</title>
</head>
<body>
  <!-- 注释里的中文不算页面文案 -->
  <h1>你好</h1>
  <button aria-label="打开">保存</button>
  <script>
  var label = '搜索';
  var tour = F('点<b>按钮</b>完成。', {});
  var left = F('还有 {n} 件', 3);
  </script>
</body>
</html>
"""


def self_test() -> int:
    """Every mutation must produce a named failure; the good fixture must pass."""
    fails: list[str] = []

    def audit(table=None, templates=None) -> list[str]:
        table = dict(GOOD_DICT if table is None else table)
        templates = dict(GOOD_TEMPLATES if templates is None else templates)
        en_page, used = translate_with_recorder(FIXTURE, table, templates)
        problems = []
        problems += scan_page(en_page)
        problems += check_dictionary(table, used)
        problems += check_templates(FIXTURE, en_page, templates)
        return problems

    good = audit()
    if good:
        fails.append("正向：完整词典 + 完整模板应 PASS，实际 %s" % good)

    # F 首参保护：en 页的 F 键必须与原模板键逐字相同（含 <b> 中文）
    en_page = build_en(FIXTURE, GOOD_DICT, GOOD_TEMPLATES)
    if build_page.f_template_keys(en_page) != build_page.f_template_keys(FIXTURE):
        fails.append("正向：F 首参被构建改写：%s" % sorted(build_page.f_template_keys(en_page)))

    missing_key = dict(GOOD_DICT)
    missing_key.pop("保存")
    problems = audit(table=missing_key)
    if not any("en page L" in p for p in problems):
        fails.append("反向 a：删一条 en.json 键必须红并点名行号，实际 %s" % problems)

    chinese_value = dict(GOOD_DICT)
    chinese_value["搜索"] = "搜索"
    problems = audit(table=chinese_value)
    if not any("en page L" in p for p in problems):
        fails.append("反向 b：英文值塞回中文必须红，实际 %s" % problems)

    missing_template = dict(GOOD_TEMPLATES)
    missing_template.pop("还有 {n} 件")
    problems = audit(templates=missing_template)
    if not any("missing from en.templates.json" in p for p in problems):
        fails.append("反向 c：删一条 F 模板必须红，实际 %s" % problems)

    chinese_template = dict(GOOD_TEMPLATES)
    chinese_template["点<b>按钮</b>完成。"] = "点<b>Button</b>完成。"
    problems = audit(templates=chinese_template)
    if not any("value still has Chinese" in p for p in problems):
        fails.append("反向 d：F 模板值塞中文必须红，实际 %s" % problems)

    extra_key = dict(GOOD_DICT)
    extra_key["这条文案已不存在"] = "Gone"
    problems = audit(table=extra_key)
    if not any("no lookup consumes" in p and "这条文案已不存在" in p for p in problems):
        fails.append("反向 e：从未被查询的死键必须红并点名，实际 %s" % problems)

    if fails:
        print("i18n_check.py --self-test: FAIL")
        for item in fails:
            print("  - " + item)
        return 1
    print("i18n_check.py --self-test: PASS（正向 2 + 反向 5；夹具在内存里构建，"
          "5 类变异（删键 / 塞中文 / 删模板 / 模板塞中文 / 死键）全部点名）")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="英文页覆盖门禁：CJK 扫描 + en.json 覆盖 + F 模板对齐 + 脚本语法")
    parser.add_argument("--self-test", action="store_true",
                        help="离线自检：好样例 PASS，每个变异必须红")
    parser.add_argument("--plugin-dir", type=Path, default=None,
                        help="插件目录（默认按本文件位置自动发现；供夹具 / CI 指向临时副本）")
    args = parser.parse_args(argv)
    if args.self_test:
        return self_test()
    return run(args.plugin_dir or PLUGIN)


if __name__ == "__main__":
    sys.exit(main())
