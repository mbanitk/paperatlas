"""Cheap, LLM-free filter for engineering items: keep what describes a performance technique or a measured change.

Merged pull requests, release-note lines and blog posts are scored from their tags and labels (`[Perf]`, `perf:`,
`performance`), the words in their title (faster, fused, throughput, kv cache, …) and whether their text reports
numbers (1.3x, +18% throughput, 42 tok/s, 12 ms). Bug fixes, chores, CI, docs and items about hardware the project
doesn't run are dropped before anything reaches the distiller.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable, Sequence

from paperatlas.discovery.config import EngineeringSettings

_BRACKET_TAG = re.compile(r"\[([^\]]{1,40})\]")
# "CUDA: …", "ggml-zdnn: …", "server : …", conventional commits "perf(kv): …"
_PREFIX_TAG = re.compile(r"^\s*([A-Za-z][\w.\-/]{0,30})\s*(?:\([^)]{0,30}\))?!?\s*:\s")
_FIX_TITLE = re.compile(r"^\s*(?:fix(?:es|ed)?|revert(?:s|ed)?|hotfix)\b", re.IGNORECASE)
_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)
_CHECKBOX = re.compile(r"^\s*[-*]\s*\[[ xX]\].*$", re.MULTILINE)
_SPEEDUP = re.compile(r"(?<![\w.])\d+(?:\.\d+)?\s?[x×](?![\w\d])")
_RATE = re.compile(
    r"(?<![\w.])\d+(?:[.,]\d+)?\s?(?:tok(?:en)?s?/s|t/s|tps|it/s|ms|µs|us|GB/s|GiB/s|TFLOPS|GFLOPS|GB|GiB|MB)(?![\w/])",
    re.IGNORECASE,
)
_PERCENT = re.compile(r"[+\-−]?\d+(?:\.\d+)?\s?%")
_PERCENT_CONTEXT = re.compile(
    r"faster|slower|speed|throughput|latency|improv|reduc|lower|higher|tok|ttft|tpot|itl|memory|e2e|perf|gain|overhead",
    re.IGNORECASE,
)
_LINE_ITEM = re.compile(r"^\s*(?:[-*+]|\d+[.)]|\|)\s*")
_PR_URL = re.compile(r"https?://github\.com/[\w.-]+/[\w.-]+/(?:pull|issues)/(\d+)\S*")
_MD_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]*\)")
_URL = re.compile(r"https?://\S+")
_BY_AUTHOR = re.compile(r"\s+by\s+@[\w-]+(?:\s+in)?(?=\s|$)")
_HEADING = re.compile(r"^\s*#{1,6}\s+(.*\S)\s*$")


@dataclass
class Assessment:
    keep: bool
    score: float
    reasons: list[str] = field(default_factory=list)


def _phrases(words: Iterable[str]) -> re.Pattern[str] | None:
    terms = sorted({word.strip().lower() for word in words if word and word.strip()}, key=len, reverse=True)
    if not terms:
        return None
    return re.compile(r"(?<![\w])(?:" + "|".join(re.escape(term) for term in terms) + r")(?![\w])", re.IGNORECASE)


def _hits(pattern: re.Pattern[str] | None, text: str) -> set[str]:
    return {match.group(0).lower() for match in pattern.finditer(text)} if pattern and text else set()


def title_tags(title: str) -> set[str]:
    """Bracket tags and a leading `area:` prefix of a title, lower-cased, also split on `/` and `,`."""
    raw = _BRACKET_TAG.findall(title)
    if prefix := _PREFIX_TAG.match(_BRACKET_TAG.sub("", title)):
        raw.append(prefix.group(1))
    tags: set[str] = set()
    for tag in raw:
        tag = tag.strip().lower()
        tags.add(tag)
        tags.update(part.strip() for part in re.split(r"[/,]", tag) if part.strip())
    return tags


def clean_body(body: str | None) -> str:
    """PR / release text without template comments and checklists."""
    text = _COMMENT.sub("", body or "")
    return _CHECKBOX.sub("", text).strip()


def plain_line(line: str) -> str:
    """A release-note line without links, URLs and `by @author in` (PR links become `#123`)."""
    text = _MD_LINK.sub(r"\1", line)
    text = _PR_URL.sub(r"#\1", text)
    text = _URL.sub("", text)
    text = _BY_AUTHOR.sub("", text)
    return re.sub(r"\s+", " ", text).strip(" :")


def measurements(text: str) -> int:
    """How many reported numbers look like a performance measurement (speed-ups, rates, timings, % changes)."""
    if not text:
        return 0
    count = len(_SPEEDUP.findall(text)) + len(_RATE.findall(text))
    for match in _PERCENT.finditer(text):
        window = text[max(0, match.start() - 80) : match.end() + 40]
        if _PERCENT_CONTEXT.search(window):
            count += 1
    return count


class SignalFilter:
    def __init__(self, settings: EngineeringSettings, exclude: Sequence[str] = (), include: Sequence[str] = ()) -> None:
        self.settings = settings
        self.perf_tags = {tag.lower() for tag in settings.perf_tags}
        self.noise_tags = {tag.lower() for tag in settings.noise_tags}
        self.fix_tags = {tag.lower() for tag in settings.fix_tags}
        self.improvement = _phrases(settings.improvement_words)
        self.metric = _phrases(settings.metric_words)
        self.topic = _phrases(settings.topic_words)
        self.exclude = _phrases(exclude)
        self.include = _phrases(include)

    def _platform(self, title: str, tags: set[str]) -> tuple[str | None, str | None]:
        """(exclude term without an include term, include term) found in the title or a tag."""
        text = " ".join([title, *sorted(tags)])
        excluded, included = _hits(self.exclude, text), _hits(self.include, text)
        return (sorted(excluded)[0] if excluded and not included else None), (sorted(included)[0] if included else None)

    def assess(
        self,
        title: str,
        labels: Iterable[str] = (),
        body: str = "",
        require_title: bool = True,
        min_score: float | None = None,
    ) -> Assessment:
        """Score an item; `require_title=False` lets the body alone qualify it (blog posts with plain titles)."""
        tags = title_tags(title)
        label_set = {label.strip().lower() for label in labels if label and label.strip()}
        off, own = self._platform(title, tags | label_set)
        if off:
            return Assessment(False, 0.0, [f"not this project's hardware: {off}"])
        bare_title = _BRACKET_TAG.sub(" ", title)
        tag_text = " ".join(sorted(tags))
        # A `[Perf]` title tag is the author's call; a label may be applied by path rules (e.g. any benchmark edit).
        perf_tag = bool(tags & self.perf_tags)
        perf_label = not perf_tag and bool(label_set & self.perf_tags)
        improvement = _hits(self.improvement, bare_title) | _hits(self.metric, bare_title)
        topic = _hits(self.topic, f"{bare_title} {tag_text}")
        reasons: list[str] = []
        score = 0.0
        if perf_tag:
            score += 3
            reasons.append("performance tag")
        elif perf_label:
            score += 1
            reasons.append("performance label")
        if improvement:
            score += 2
            reasons.append("title: " + ", ".join(sorted(improvement)[:3]))
        if topic:
            score += 1
            reasons.append("topic: " + ", ".join(sorted(topic)[:3]))
        if own:
            score += 1
            reasons.append(f"project hardware: {own}")
        measured = measurements(body)
        if measured >= 2:
            score += 2
            reasons.append(f"{measured} measurements")
        body_words = _hits(self.improvement, body) | _hits(self.metric, body)
        if len(body_words) >= 3:
            score += 1
            reasons.append("body: " + ", ".join(sorted(body_words)[:3]))
        if ((tags | label_set) & self.fix_tags) or _FIX_TITLE.match(_PREFIX_TAG.sub("", bare_title, count=1)):
            score -= 3
            reasons.append("bug fix")
        # Labels are often applied by path rules (any test or docs edit), so they count less than a title tag.
        noise_tags, noise_labels = sorted(tags & self.noise_tags), sorted(label_set & self.noise_tags)
        if (noise_tags or noise_labels) and not perf_tag:
            score -= 3 if noise_tags else 1
            reasons.append(f"chore: {(noise_tags or noise_labels)[0]}")
        relevant_title = perf_tag or bool(improvement or topic or own)
        threshold = self.settings.min_score if min_score is None else min_score
        keep = score >= threshold and (relevant_title or not require_title)
        if not relevant_title and require_title:
            reasons.append("title not about performance")
        return Assessment(keep, score, reasons)

    def release_lines(self, body: str) -> tuple[list[str], int]:
        """Release-note lines about performance (each under its section heading) and how many lines were read."""
        kept: list[str] = []
        heading: str | None = None
        heading_done = False
        read = 0
        for line in clean_body(body).splitlines():
            if match := _HEADING.match(line):
                heading, heading_done = match.group(1), False
                continue
            item = plain_line(_LINE_ITEM.sub("", line))
            if len(item) < 12 or set(item) <= set("-|: "):
                continue
            read += 1
            # A line has no body to show measurements, so it needs one point less (e.g. "fused" + "SDPA").
            if not self.assess(item, body=item, min_score=self.settings.min_score - 1).keep:
                continue
            if heading and not heading_done:
                kept.append(f"## {heading}")
                heading_done = True
            kept.append(f"- {item}")
            if sum(1 for line in kept if line.startswith("- ")) >= self.settings.release_lines:
                break
        return kept, read
