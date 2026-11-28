"""Engineering and research blogs: posts from RSS 2.0 or Atom feeds (no API key)."""

from __future__ import annotations

import html
import logging
from dataclasses import dataclass, field
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Optional
from xml.etree import ElementTree

from paperatlas.concepts.extraction.html_text import html_to_text

from .base import HttpSource, clean_text
from .github import parse_time

logger = logging.getLogger(__name__)

ATOM = "{http://www.w3.org/2005/Atom}"
CONTENT = "{http://purl.org/rss/1.0/modules/content/}encoded"
DC_CREATOR = "{http://purl.org/dc/elements/1.1/}creator"
DC_DATE = "{http://purl.org/dc/elements/1.1/}date"


@dataclass
class FeedPost:
    title: str
    url: str
    published: Optional[datetime]
    summary: str = ""
    content: str = ""
    authors: list[str] = field(default_factory=list)
    categories: list[str] = field(default_factory=list)


class FeedClient(HttpSource):
    name = "feeds"
    min_interval = 0.3

    def posts(self, url: str) -> list[FeedPost]:
        return parse_feed(self._request("GET", url).text)

    def page_text(self, url: str) -> Optional[str]:
        """Main text of a post's page (feeds often carry only a summary)."""
        response = self._request("GET", url)
        if "html" not in response.headers.get("content-type", "html"):
            return None
        return html_to_text(response.text) or None


def _text(element: Optional[ElementTree.Element]) -> str:
    return (element.text or "").strip() if element is not None else ""


def _published(value: str) -> Optional[datetime]:
    if not value:
        return None
    try:
        moment = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return parse_time(value)
    return moment if moment.tzinfo else moment.replace(tzinfo=UTC)


def _plain(fragment: str) -> str:
    if not fragment:
        return ""
    return html_to_text(html.unescape(fragment) if "&lt;" in fragment else fragment, min_chars=0)


def parse_feed(xml_text: str) -> list[FeedPost]:
    """Posts of an RSS 2.0 or Atom feed (titles and links required; HTML in summaries is reduced to text)."""
    root = ElementTree.fromstring(xml_text.lstrip("\ufeff").strip().encode("utf-8"))
    raw: list[dict] = []
    for item in root.iter("item"):
        raw.append(
            {
                "title": _text(item.find("title")),
                "url": _text(item.find("link")) or _text(item.find("guid")),
                "date": _text(item.find("pubDate")) or _text(item.find(DC_DATE)),
                "summary": _text(item.find("description")),
                "content": _text(item.find(CONTENT)),
                "authors": [_text(node) for node in item.findall(DC_CREATOR)] + [_text(n) for n in item.findall("author")],
                "categories": [_text(node) for node in item.findall("category")],
            }
        )
    for entry in root.iter(f"{ATOM}entry"):
        link = next(
            (node.get("href") for node in entry.findall(f"{ATOM}link") if node.get("rel") in (None, "alternate")),
            None,
        )
        raw.append(
            {
                "title": _text(entry.find(f"{ATOM}title")),
                "url": link or "",
                "date": _text(entry.find(f"{ATOM}published")) or _text(entry.find(f"{ATOM}updated")),
                "summary": _text(entry.find(f"{ATOM}summary")),
                "content": _text(entry.find(f"{ATOM}content")),
                "authors": [_text(node.find(f"{ATOM}name")) for node in entry.findall(f"{ATOM}author")],
                "categories": [node.get("term") or "" for node in entry.findall(f"{ATOM}category")],
            }
        )
    posts = []
    for item in raw:
        title = clean_text(html.unescape(item["title"]))
        url = (item["url"] or "").strip()
        if not title or not url.startswith(("http://", "https://")):
            continue
        content = _plain(item["content"])
        posts.append(
            FeedPost(
                title=title,
                url=url,
                published=_published(item["date"]),
                summary=_plain(item["summary"]) or content[:1500],
                content=content,
                authors=[name for name in item["authors"] if name],
                categories=[category for category in item["categories"] if category],
            )
        )
    return posts
