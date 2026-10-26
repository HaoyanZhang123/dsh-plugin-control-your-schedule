#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build client.js from src/client.src.js and the two paper-page variants.

The page source (assets/paper-os.html) is the single Chinese UI source. This
script produces two embedded pages:

  zh  source + __PAGE_VERSION__ + <html lang="zh"> + window.__PAPER_LANG__='zh'
  en  the same page translated through assets/i18n/en.json (text nodes,
      aria-label/title/placeholder/alt/content values, quoted JS literals),
      <html lang="en">, window.__PAPER_LANG__='en' and window.__PAPER_TEMPLATES__
      read from assets/i18n/en.templates.json.

Translation rules (output/_probe/i18n/CONTRACT.md):
  * exact match on the trimmed string, source edge whitespace kept unless the
    English value supplies its own whitespace on that edge;
  * literals containing < or > are left whole (F() templates take them over);
  * F(...) first arguments are skipped - they are resolved at runtime;
  * data:/http(s)/API URLs are never rewritten;
  * text nodes and attribute values are inserted as-is; inside a quoted JS
    literal the value is escaped for its own quote kind so a value such as
    "couldn't" can never truncate the string.

The template map is injected ASCII-escaped on purpose: it is machine data, so
the "no CJK outside the whitelist" gate stays strict for real page copy.

Run with --check in CI to prove the committed client.js matches both pages
byte for byte. No third-party dependencies.
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
SIDEBAR_ICON = ROOT / "sidebar-icon.svg"
ICON_STROKE = "#8a8f98"
PKG = ROOT / "package.json"
I18N = ROOT / "assets" / "i18n"
EN_JSON = I18N / "en.json"
EN_TEMPLATES = I18N / "en.templates.json"

CJK = re.compile(r"[\u4e00-\u9fff]")
TEXT_RE = re.compile(r">([^<>]+)<")
ATTR_RE = re.compile(r'(?<![\w-])(aria-label|title|placeholder|alt|content)="([^"]*)"')
LIT_RE = re.compile(r"'((?:[^'\\\n]|\\.)*)'|\"((?:[^\"\\\n]|\\.)*)\"")
# Any F(...) call, including P.F(...): only the first argument is a template.
F_CALL_RE = re.compile(r"(?<![\w$])F\s*\(\s*")
URL_PREFIXES = ("data:", "http://", "https://", "//", "/api/")


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


def package_version() -> str:
    package = json.loads(PKG.read_text(encoding="utf-8"))
    return str(package.get("version", "0.0.0"))


def _read_json(path: Path, label: str):
    if not path.is_file():
        fail("%s is missing: %s (i18n assets are build inputs, never optional)" % (label, path))
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        fail("%s is not valid JSON: %s" % (label, error))
        raise AssertionError("unreachable")


def load_dictionary() -> tuple[dict[str, str], dict]:
    """Read en.json + en.templates.json; both are required build inputs."""
    table = _read_json(EN_JSON, "en.json")
    if not isinstance(table, dict):
        fail("en.json must be a flat object of Chinese -> English strings")
    bad = [key for key, value in table.items()
           if not isinstance(key, str) or not isinstance(value, str) or not value.strip()]
    if bad:
        fail("en.json has empty / non-string values: %r" % bad[:5])
    templates = _read_json(EN_TEMPLATES, "en.templates.json")
    if not isinstance(templates, dict):
        fail("en.templates.json must be an object of Chinese template -> English")
    return table, templates


def _literal_inner(match: re.Match) -> str:
    return match.group(1) if match.group(1) is not None else match.group(2)


def _is_url(text: str) -> bool:
    core = text.strip()
    return core.startswith(URL_PREFIXES)


def strip_comments(text: str) -> str:
    """Blank HTML / CSS / JS comments while keeping the line count intact."""
    text = re.sub(r"<!--.*?-->", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)
    text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group(0).count("\n"), text, flags=re.S)
    return re.sub(r"(?m)^\s*//.*$", "", text)


def f_arg_positions(text: str) -> set[int]:
    """Offsets where an F(...) first-argument string literal opens.

    One linear scan: asking a regex "does a 500 KB prefix end with F(" for every
    literal would be quadratic (that cost a 50 s build).
    """
    return {match.end() for match in F_CALL_RE.finditer(text)
            if match.end() < len(text) and text[match.end()] in "'\""}


def iter_f_first_args(text: str):
    """Yield the match of every F(...) first-argument string literal.

    Single source for both the build (skip + protect) and the gate (template
    alignment), so P.F(...) and F(...) can never drift apart between them.
    """
    positions = f_arg_positions(text)
    for match in LIT_RE.finditer(text):
        if match.start() in positions:
            yield match


def f_template_keys(page: str) -> set[str]:
    """Chinese templates passed as the first argument of F(...) (comments stripped)."""
    keys: set[str] = set()
    for match in iter_f_first_args(strip_comments(page)):
        core = _literal_inner(match).strip()
        if core:
            keys.add(core)
    return keys


def mask_f_args(text: str) -> str:
    """Blank F() first arguments, preserving line numbers (for static gates)."""
    pieces: list[str] = []
    pos = 0
    for match in iter_f_first_args(text):
        pieces.append(text[pos:match.start()])
        pieces.append("".join(ch if ch == "\n" else " " for ch in match.group(0)))
        pos = match.end()
    pieces.append(text[pos:])
    return "".join(pieces)


def _edges(raw: str, value: str) -> tuple[str, str]:
    """Source edge whitespace, dropped on a side where the value has its own."""
    lead = raw[:len(raw) - len(raw.lstrip())]
    trail = raw[len(raw.rstrip()):]
    head = "" if value[:1].isspace() else lead
    tail = "" if value[-1:].isspace() else trail
    return head, tail


def _wrap(raw: str, value: str) -> str:
    head, tail = _edges(raw, value)
    return head + value + tail


def _escape_literal(value: str, quote: str) -> str:
    """Escape for the literal's own quote kind so English can never truncate it.

    Existing backslashes are left alone on purpose: en.json carries deliberate
    JS escape sequences such as "desk:\\n", and doubling them would render a
    visible backslash-n. Only the quote, real line breaks and "</" are touched.
    """
    escaped = value.replace(quote, "\\" + quote)
    escaped = escaped.replace("\r", "\\r").replace("\n", "\\n")
    return escaped.replace("</", "<\\/")


def _in_spans(pos: int, spans: list[tuple[int, int]]) -> bool:
    return any(start <= pos < end for start, end in spans)


def _translate_html_string(inner: str, table: dict[str, str], quote: str,
                           stats: dict) -> str:
    """Translate an HTML template string by segments: never across a tag/quote."""
    out = []
    for part in re.split(r"(<[^>]*>)", inner):
        if not part:
            continue
        if part.startswith("<") and part.endswith(">"):
            out.append(part)
            continue
        core = part.strip()
        value = table.get(core) if core else None
        if value is None:
            if core and CJK.search(core):
                stats["untranslated"].add(core)
            out.append(part)
            continue
        stats["literal"] += 1
        head, tail = _edges(part, value)
        out.append(head + _escape_literal(value, quote) + tail)
    return "".join(out)


def translate_page(page: str, table: dict[str, str],
                   templates: dict | None = None) -> tuple[str, dict]:
    """Translate markup text/attributes and quoted literals, in trusted spans.

    Three rules keep the en page honest:
      * text nodes and attributes only in real markup (never inside
        <script>/<style>), and never across a quote or a line break;
      * a quoted literal without < or > is matched as a whole string;
      * a quoted literal that builds HTML is split on tags and translated
        segment by segment, so nothing is ever matched across a quote;
      * F(...) first arguments are skipped whole: they are runtime template
        keys and must stay byte-identical to en.templates.json.
    """
    templates = templates or {}
    stats = {"text": 0, "attr": 0, "literal": 0,
             "untranslated": set(), "templates": set()}

    # 1) quoted literals: JS strings, CSS content and HTML template strings.
    literals = []
    f_positions = f_arg_positions(page)
    for match in LIT_RE.finditer(page):
        inner = _literal_inner(match)
        if match.start() in f_positions:
            stats["templates"].add(inner.strip())
            continue
        if _is_url(inner):
            continue
        quote = page[match.start()]
        if "<" in inner or ">" in inner:
            translated = _translate_html_string(inner, table, quote, stats)
            if translated != inner:
                literals.append((match.start(), match.end(), quote + translated + quote))
            continue
        core = inner.strip()
        value = table.get(core) if core else None
        if value is None:
            if core and CJK.search(core) and core not in templates:
                stats["untranslated"].add(core)
            continue
        head, tail = _edges(inner, value)
        stats["literal"] += 1
        literals.append((match.start(), match.end(),
                         quote + head + _escape_literal(value, quote) + tail + quote))
    body = page
    for start, end, replacement in reversed(literals):
        body = body[:start] + replacement + body[end:]

    # F() first arguments are the only untouchable spans: everything else
    # (including markup built inside JS strings) is translated as before.
    f_spans = [(match.start(), match.end()) for match in iter_f_first_args(body)]

    # 2) text nodes: never inside an F() template, never across a quote or line.
    def text_sub(match: re.Match) -> str:
        if _in_spans(match.start(), f_spans):
            return match.group(0)
        raw = match.group(1)
        if "'" in raw or '"' in raw or "\n" in raw or "\r" in raw:
            return match.group(0)
        core = raw.strip()
        value = table.get(core) if core else None
        if value is None:
            if core and CJK.search(core) and core not in templates:
                stats["untranslated"].add(core)
            return match.group(0)
        stats["text"] += 1
        return ">" + _wrap(raw, value) + "<"

    body = TEXT_RE.sub(text_sub, body)

    # 3) attribute values (aria-label / title / placeholder / alt / content),
    #    real markup only.
    def attr_sub(match: re.Match) -> str:
        if _in_spans(match.start(), f_spans):
            return match.group(0)
        name, raw = match.group(1), match.group(2)
        core = raw.strip()
        value = table.get(core) if core else None
        if value is None:
            return match.group(0)
        stats["attr"] += 1
        return name + '="' + _wrap(raw, value) + '"'

    return ATTR_RE.sub(attr_sub, body), stats


def _inject_version(page: str, version: str) -> str:
    if "__PAGE_VERSION__" not in page:
        fail("paper-os.html lost its __PAGE_VERSION__ placeholder; the page version must come from package.json")
    page = page.replace("__PAGE_VERSION__", version)
    if "__PAGE_VERSION__" in page:
        fail("unresolved __PAGE_VERSION__ remains in paper-os.html")
    return page


def set_html_lang(page: str, lang: str) -> str:
    match = re.search(r"<html\b[^>]*>", page, re.I)
    if not match:
        fail("paper-os.html lost its <html> tag")
    tag = match.group(0)
    if re.search(r'\blang="[^"]*"', tag):
        tag = re.sub(r'\blang="[^"]*"', 'lang="%s"' % lang, tag, count=1)
    else:
        tag = tag[:-1] + ' lang="%s">' % lang
    return page[:match.start()] + tag + page[match.end():]


def _js_json(value) -> str:
    text = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(",", ":"))
    return text.replace("</", "<\\/")


def inject_bootstrap(page: str, lang: str, templates: dict | None = None) -> str:
    """Language variables land in <head>, before any app script runs."""
    payload = "window.__PAPER_LANG__='%s';" % lang
    if templates is not None:
        payload += "window.__PAPER_TEMPLATES__=%s;" % _js_json(templates)
    script = "<script>%s</script>" % payload
    head = re.search(r"<head\b[^>]*>", page, re.I)
    if not head:
        fail("paper-os.html lost its <head>; cannot inject the language bootstrap")
    insert_at = head.end()
    charset = re.search(r"<meta\b[^>]*charset=[^>]*>", page[insert_at:insert_at + 400], re.I)
    if charset:
        insert_at += charset.end()
    return page[:insert_at] + "\n  " + script + page[insert_at:]


def build_zh_page(page: str, version: str) -> str:
    page = _inject_version(page, version)
    page = set_html_lang(page, "zh")
    return inject_bootstrap(page, "zh")


def build_en_page(page: str, version: str, table: dict[str, str],
                  templates: dict) -> tuple[str, dict]:
    page = _inject_version(page, version)
    page, stats = translate_page(page, table, templates)
    page = set_html_lang(page, "en")
    return inject_bootstrap(page, "en", templates), stats


def translatable_units(page: str) -> set[str]:
    """Every trimmed string the translate pass could rewrite (used by the gate)."""
    units: set[str] = set()
    for match in TEXT_RE.finditer(page):
        core = match.group(1).strip()
        if core:
            units.add(core)
    for match in ATTR_RE.finditer(page):
        core = match.group(2).strip()
        if core:
            units.add(core)
    f_positions = f_arg_positions(page)
    for match in LIT_RE.finditer(page):
        inner = _literal_inner(match)
        if match.start() in f_positions:
            continue
        if "<" in inner or ">" in inner:
            continue
        if _is_url(inner):
            continue
        core = inner.strip()
        if core:
            units.add(core)
    return units


def build_client() -> tuple[str, dict]:
    source = SRC.read_text(encoding="utf-8")
    page = PAGE.read_text(encoding="utf-8")
    version = package_version()
    table, templates = load_dictionary()
    zh = build_zh_page(page, version)
    en, stats = build_en_page(page, version, table, templates)
    info = {
        "zh_bytes": len(zh.encode("utf-8")),
        "en_bytes": len(en.encode("utf-8")),
        "stats": stats,
    }
    icon = sidebar_icon()
    markers = ("__PAGE_B64__", "__PAGE_B64_EN__", "__STICKY_ICON_JSON__", "__VERSION__")
    for marker in markers:
        if marker not in source:
            fail("client.src.js lost its %s placeholder" % marker)
    output = (source.replace("__PAGE_B64_EN__", base64.b64encode(en.encode("utf-8")).decode("ascii"))
                    .replace("__PAGE_B64__", base64.b64encode(zh.encode("utf-8")).decode("ascii"))
                    .replace("__STICKY_ICON_JSON__", json.dumps(icon, ensure_ascii=False))
                    .replace("__VERSION__", version))
    for marker in markers:
        if marker in output:
            fail("unresolved placeholder remains in client.js: " + marker)
    if "__PAGE_VERSION__" in output:
        fail("unresolved placeholder remains in client.js: __PAGE_VERSION__")
    return output, info


def main() -> int:
    output, info = build_client()
    stats = info["stats"]
    icon = package_icon(sidebar_icon()) + "\n"
    summary = ("zh %d B / en %d B; text %d / attr %d / literal %d; untranslated units %d"
               % (info["zh_bytes"], info["en_bytes"],
                  stats["text"], stats["attr"], stats["literal"], len(stats["untranslated"])))
    if "--check" in sys.argv:
        if not OUT.is_file():
            fail("client.js is missing; run python tools/build_page.py")
        if OUT.read_text(encoding="utf-8") != output:
            fail("client.js is stale; run python tools/build_page.py")
        if not ICON.is_file():
            fail("icon.svg is missing; run python tools/build_page.py")
        if ICON.read_text(encoding="utf-8") != icon:
            fail("icon.svg is stale; run python tools/build_page.py")
        print("OK: client.js and icon.svg are up to date (%s)" % summary)
        return 0
    OUT.write_text(output, encoding="utf-8")
    ICON.write_text(icon, encoding="utf-8")
    print("OK: wrote %s (%d bytes) and %s; %s"
          % (OUT, len(output.encode("utf-8")), ICON, summary))
    if stats["untranslated"]:
        missing = sorted(stats["untranslated"])
        print("  untranslated CJK units (%d): %s"
              % (len(missing), " | ".join(missing[:10]) + (" …" if len(missing) > 10 else "")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
