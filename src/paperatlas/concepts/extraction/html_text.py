"""Readable text of an HTML page (a blog post), standard library only."""

from __future__ import annotations

import re
from html.parser import HTMLParser
from typing import Optional

_SKIP = {"script", "style", "noscript", "svg", "nav", "header", "footer", "aside", "form", "button", "template", "iframe"}
_BLOCK = {
    "p", "div", "section", "article", "main", "li", "ul", "ol", "br", "tr", "table", "pre", "blockquote",
    "h1", "h2", "h3", "h4", "h5", "h6", "figcaption", "dt", "dd",
}  # fmt: skip
_VOID = {"br", "img", "meta", "link", "input", "hr", "source", "wbr", "area", "base", "col", "embed", "param", "track"}


class _TextCollector(HTMLParser):
    """Visible text, separately for the whole body and inside <article> and <main>."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.skip_depth = 0
        self.stack: list[str] = []
        self.containers: dict[str, list[str]] = {"article": [], "main": [], "body": []}
        self.depth = {"article": 0, "main": 0}

    def handle_starttag(self, tag: str, attrs: list[tuple[str, Optional[str]]]) -> None:
        if tag in _VOID:
            if tag == "br":
                self._emit("\n")
            return
        self.stack.append(tag)
        if tag in _SKIP:
            self.skip_depth += 1
        if tag in self.depth:
            self.depth[tag] += 1
        if tag in _BLOCK:
            self._emit("\n")

    def handle_endtag(self, tag: str) -> None:
        if tag in _VOID or tag not in self.stack:
            return
        while self.stack:
            open_tag = self.stack.pop()
            if open_tag in _SKIP:
                self.skip_depth -= 1
            if open_tag in self.depth:
                self.depth[open_tag] -= 1
            if open_tag == tag:
                break
        if tag in _BLOCK:
            self._emit("\n")

    def handle_data(self, data: str) -> None:
        if self.skip_depth == 0:
            self._emit(data)

    def _emit(self, text: str) -> None:
        self.containers["body"].append(text)
        for name, depth in self.depth.items():
            if depth > 0:
                self.containers[name].append(text)


def normalize_whitespace(text: str) -> str:
    lines = [re.sub(r"[ \t\r\f\v]+", " ", line).strip() for line in text.split("\n")]
    return re.sub(r"\n{3,}", "\n\n", "\n".join(lines)).strip()


def html_to_text(page: str, min_chars: int = 500) -> str:
    """Main text of an HTML page: the <article> if it has real content, else <main>, else the whole body
    (scripts, styles, navigation, headers, footers and asides are dropped)."""
    collector = _TextCollector()
    collector.feed(page)
    collector.close()
    for name in ("article", "main", "body"):
        text = normalize_whitespace("".join(collector.containers[name]))
        if (text and len(text) >= min_chars) or name == "body":
            return text
    return ""
