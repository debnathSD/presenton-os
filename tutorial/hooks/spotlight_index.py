"""MkDocs hook: build a compact, section-level search index for the Spotlight search.

Every page is split at its h2/h3 headings. Each section becomes one entry with its
heading, page title, Part (breadcrumb), anchor URL, plain body text and the code
identifiers found in it (so names like `get_slide_content_from_type_and_outline`
are searchable even though code blocks are dropped from the body text).

Output: <site_dir>/assets/spotlight/index.json
"""

from __future__ import annotations

import html
import json
import os
import re

_ENTRIES: list[dict] = []

HEADING_RE = re.compile(r"<h([1-3])([^>]*)>(.*?)</h\1>", re.S)
ID_RE = re.compile(r'\bid="([^"]+)"')
# Tags, allowing ">" inside quoted attribute values (abbr/tooltip titles).
TAG_RE = re.compile(r"""<(?:[^>"']|"[^"]*"|'[^']*')*>""")
# Inline tags are removed without a space so "(<code>x</code>)" reads "(x)", not "( x )".
INLINE_TAG_RE = re.compile(
    r"""</?(?:a|abbr|b|code|em|i|kbd|mark|small|span|strong|sub|sup|del|ins|s|u)\b(?:[^>"']|"[^"]*"|'[^']*')*>""",
    re.I,
)
WS_RE = re.compile(r"\s+")
PRE_RE = re.compile(r"<pre\b.*?</pre>", re.S)
CODE_INLINE_RE = re.compile(r"<code\b[^>]*>(.*?)</code>", re.S)
DROP_RE = re.compile(
    r'<(svg|script|style)\b.*?</\1>|<div class="mermaid".*?</div>|<pre class="mermaid".*?</pre>'
    r'|<a class="headerlink"[^>]*>.*?</a>',
    re.S,
)
IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]*(?:[./:-][A-Za-z0-9_]+)*")
SKIP_HEADINGS = {"next", "what you now know"}  # boilerplate chapter endings
MAX_BODY = 2400
MAX_KEYWORDS = 60


def _text(fragment: str) -> str:
    fragment = INLINE_TAG_RE.sub("", fragment)
    return WS_RE.sub(" ", html.unescape(TAG_RE.sub(" ", fragment))).strip()


def _clip(text: str, size: int) -> str:
    """Cut at a word boundary so the last indexed word is not a fragment."""
    if len(text) <= size:
        return text
    cut = text.rfind(" ", 0, size)
    return text[:cut if cut > size * 0.8 else size]


def _identifiers(fragment: str) -> list[str]:
    """Code-like tokens: snake_case, camelCase, dotted or slashed paths, HTTP paths."""
    found: list[str] = []
    for raw in IDENT_RE.findall(html.unescape(TAG_RE.sub(" ", fragment))):
        token = raw.strip("./:-")
        if len(token) < 4:
            continue
        if ("_" in token or "/" in token or "." in token
                or re.search(r"[a-z][A-Z]", token)):
            if token not in found:
                found.append(token)
    return found


def _breadcrumb(page) -> str:
    ancestors = list(page.ancestors)
    # A section's own index page is shown as the section itself, so drop that level.
    if page.file.name == "index" and ancestors:
        ancestors = ancestors[1:]
    parts = [a.title for a in reversed(ancestors) if getattr(a, "title", None)]
    return " › ".join(parts)


def on_pre_build(config, **kwargs):
    _ENTRIES.clear()


def on_page_content(html_content, page, config, files):
    if page.file.src_uri.startswith("assets/") or page.is_homepage:
        return html_content
    url = page.url  # e.g. "presenton/08-standard-pipeline/"
    crumb = _breadcrumb(page)
    cleaned = DROP_RE.sub(" ", html_content)

    # Split into (heading, body) chunks at h1-h3.
    pieces = []
    has_h1 = False
    last_end = 0
    current = {"level": 1, "id": "", "title": page.title}
    for m in HEADING_RE.finditer(cleaned):
        pieces.append((current, cleaned[last_end:m.start()]))
        has_h1 = has_h1 or m.group(1) == "1"
        attrs = m.group(2)
        hid = ID_RE.search(attrs)
        current = {
            "level": int(m.group(1)),
            "id": hid.group(1) if hid else "",
            "title": _text(m.group(3)),
        }
        last_end = m.end()
    pieces.append((current, cleaned[last_end:]))

    for i, (head, body) in enumerate(pieces):
        if head["level"] > 1 and head["title"].strip().lower() in SKIP_HEADINGS:
            continue
        code_blocks = " ".join(PRE_RE.findall(body))
        inline_code = " ".join(CODE_INLINE_RE.findall(body))
        keywords = _identifiers(code_blocks + " " + inline_code)[:MAX_KEYWORDS]
        text = _text(PRE_RE.sub(" ", body))
        if not text and not keywords and (head["level"] > 1 or (i == 0 and has_h1)):
            # Empty sections, and the empty chunk before the page's own <h1>, which would
            # otherwise duplicate the page entry.
            continue
        anchor = f"#{head['id']}" if head["id"] and head["level"] > 1 else ""
        _ENTRIES.append({
            "u": url + anchor,
            "t": head["title"] or page.title,
            "p": page.title,
            "b": crumb,
            "l": head["level"],
            "x": _clip(text, MAX_BODY),
            "k": keywords,
        })
    return html_content


def on_post_build(config, **kwargs):
    out_dir = os.path.join(config["site_dir"], "assets", "spotlight")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, "index.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"v": 1, "docs": _ENTRIES}, fh, ensure_ascii=False, separators=(",", ":"))
