"""Engineering sources: GitHub merged PRs / release notes and blog feeds, the keyword filter and the incremental run."""

from datetime import UTC, datetime, timedelta

import httpx
import pytest
import yaml
from sqlalchemy import select

from paperatlas.discovery.config import EngineeringSettings, Upstream
from paperatlas.discovery.signal import SignalFilter
from paperatlas.discovery.sources import github as github_module
from paperatlas.discovery.sources.feeds import FeedClient, parse_feed
from paperatlas.discovery.sources.github import GitHubClient, github_token
from paperatlas.discovery.upstream import CursorStore, discover_upstream, fetch_upstream

NOW = datetime(2026, 11, 28, 8, 0, tzinfo=UTC)
SETTINGS = EngineeringSettings()
APPLE = SignalFilter(SETTINGS, exclude=["CUDA", "ROCm", "NPU"], include=["Metal", "MLX"])

PERF_BODY = "Decode speed on M5 Pro: 41.2 tok/s -> 48.9 tok/s (1.19x), TTFT 210 ms -> 182 ms; 18% faster prefill."


def pr(number, title, labels=(), body=PERF_BODY, merged="2026-11-27T10:00:00Z"):
    return {
        "number": number,
        "title": title,
        "labels": [{"name": label} for label in labels],
        "body": body,
        "user": {"login": "dev"},
        "html_url": f"https://github.com/acme/engine/pull/{number}",
        "pull_request": {"merged_at": merged},
    }


RELEASE_BODY = """## Highlights
- Fused SDPA kernel for head_dim 256, 1.4x faster prefill by @a in https://github.com/acme/engine/pull/7
- [CUDA] Faster window attention by @b in https://github.com/acme/engine/pull/8
- Fix crash when loading empty adapters (#9)
## Docs
- Update README badges
"""

RSS = """<?xml version="1.0"?>
<rss version="2.0"><channel><title>Lab blog</title>
<item><title>Speculative decoding 2x faster on a laptop GPU</title><link>https://blog.example.com/spec</link>
<pubDate>Wed, 26 Nov 2026 00:00:00 GMT</pubDate>
<description>&lt;p&gt;We cut decode latency by 45% and reach 2.1x throughput with lookahead drafting.&lt;/p&gt;</description></item>
<item><title>Our offsite in Lisbon</title><link>https://blog.example.com/offsite</link>
<pubDate>Tue, 25 Nov 2026 00:00:00 GMT</pubDate><description>Team photos.</description></item>
<item><title>An old post</title><link>https://blog.example.com/old</link>
<pubDate>Mon, 01 Sep 2025 00:00:00 GMT</pubDate><description>Faster kernels, 3x speedup, lower latency.</description></item>
</channel></rss>"""


class FakeGitHub:
    """A mock GitHub API: merged PRs per repo, releases per repo, optional rate limit / token rejection."""

    def __init__(self, pulls=None, releases=None, rate_limited=(), reject_token=False):
        self.pulls = pulls or {}
        self.releases = releases or {}
        self.rate_limited = set(rate_limited)
        self.reject_token = reject_token
        self.requests: list[httpx.Request] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.reject_token and "authorization" in request.headers:
            return httpx.Response(401, json={"message": "Bad credentials"})
        if request.url.path == "/search/issues":
            query = request.url.params["q"]
            repo = query.split()[0].removeprefix("repo:")
            if repo in self.rate_limited:
                return httpx.Response(
                    403, json={"message": "API rate limit exceeded"}, headers={"x-ratelimit-remaining": "0", "x-ratelimit-reset": "1795000000"}
                )
            items = self.pulls.get(repo, [])
            return httpx.Response(200, json={"total_count": len(items), "items": items})
        repo = request.url.path.removeprefix("/repos/").removesuffix("/releases")
        return httpx.Response(200, json=self.releases.get(repo, []))

    def client(self, token="secret", use_token=True) -> GitHubClient:
        client = GitHubClient(token=token, use_token=use_token, client=httpx.Client(transport=httpx.MockTransport(self)))
        client.min_interval = client.search_interval_token = client.search_interval_anonymous = 0.0
        return client

    def queries(self) -> list[str]:
        return [request.url.params["q"] for request in self.requests if request.url.path == "/search/issues"]


def feed_client(pages: dict[str, str]) -> FeedClient:
    def handler(request: httpx.Request) -> httpx.Response:
        body = pages.get(str(request.url))
        if body is None:
            return httpx.Response(404)
        kind = "application/rss+xml" if body.startswith("<?xml") else "text/html"
        return httpx.Response(200, text=body, headers={"content-type": kind})

    client = FeedClient(client=httpx.Client(transport=httpx.MockTransport(handler)))
    client.min_interval = 0.0
    return client


def test_filter_keeps_measured_performance_changes_and_drops_fixes_chores_and_other_hardware():
    keep = [
        ("[Perf] scheduler: cut per-step host work in the decode loop", ["ready"]),
        ("[Metal] Use the int8 path for quantized matmul", []),  # the project's hardware + measurements
        ("vocab : speed up BPE tokenization", ["testing"]),  # a label applied by path rules counts less
    ]
    drop = [
        ("[Bugfix] Fix KV cache corruption after preemption", ["bug"]),
        ("server : fix skipped prompt cache lookups", []),
        ("[CI] Speed up image builds with sccache", ["ci/build"]),
        ("[Docs] Reduce docs build size", ["documentation"]),
        ("[CUDA] Faster and more memory efficient boolean masks in attention", []),
        ("[ROCm][Perf] Tune the fused MoE kernel for MI355", ["performance"]),
        ("Add signbit operation", []),
    ]
    for title, labels in keep:
        assert APPLE.assess(title, labels, PERF_BODY).keep, title
    for title, labels in drop:
        assert not APPLE.assess(title, labels, PERF_BODY).keep, title
    assert APPLE.assess("[CUDA][Metal] Fused rope kernel, 1.3x faster", [], PERF_BODY).keep  # include wins
    assert not APPLE.assess("[Perf] Reuse the parsed request params", [], "Small cleanup.").keep  # a tag alone isn't enough
    assert "not this project's hardware: cuda" in APPLE.assess("[CUDA] faster window attention").reasons


def test_release_notes_keep_only_performance_lines_without_links():
    lines, read = APPLE.release_lines(RELEASE_BODY)
    assert read == 4
    assert lines == ["## Highlights", "- Fused SDPA kernel for head_dim 256, 1.4x faster prefill #7"]


def test_feed_parser_reads_rss_and_atom():
    posts = parse_feed(RSS)
    assert [post.title for post in posts][:2] == ["Speculative decoding 2x faster on a laptop GPU", "Our offsite in Lisbon"]
    assert posts[0].summary.startswith("We cut decode latency by 45%")
    atom = parse_feed(
        '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>KV cache paging</title>'
        '<link rel="alternate" href="https://example.com/kv"/><updated>2026-11-20T10:00:00Z</updated>'
        "<summary>Paged KV cache, 30% less memory.</summary></entry></feed>"
    )
    assert (atom[0].url, atom[0].published) == ("https://example.com/kv", datetime(2026, 11, 20, 10, tzinfo=UTC))


def test_fetch_reads_only_what_is_new_since_the_cursor():
    upstream = Upstream.model_validate(
        {"github": ["acme/engine", {"repo": "acme/server", "releases": False}], "exclude": ["CUDA"], "include": ["Metal"]}
    )
    api = FakeGitHub(
        pulls={"acme/engine": [pr(1, "[Perf] Fused decode kernel"), pr(2, "Fix typo in docs", body="")]},
        releases={
            "acme/engine": [
                {"tag_name": "v2", "name": "v2", "published_at": "2026-11-27T00:00:00Z", "body": RELEASE_BODY, "html_url": "https://x/v2"},
                {"tag_name": "v1", "name": "v1", "published_at": "2026-10-01T00:00:00Z", "body": RELEASE_BODY},
                {"tag_name": "b99", "prerelease": True, "published_at": "2026-11-27T00:00:00Z", "body": RELEASE_BODY},
            ]
        },
    )
    cursor = datetime(2026, 11, 27, 0, 0, tzinfo=UTC)
    candidates, results, advanced = fetch_upstream(
        upstream, SETTINGS, {"github:acme/engine:pulls": cursor}, now=NOW, github=api.client()
    )
    engine_query, server_query = api.queries()
    assert "merged:>=2026-11-26T23:00:00Z" in engine_query  # the cursor, less an hour of search-index lag
    assert f"merged:>={(NOW - timedelta(days=SETTINGS.initial_lookback_days)):%Y-%m-%dT%H:%M:%SZ}" in server_query
    assert not any("releases" in request.url.path and "server" in request.url.path for request in api.requests)
    kept = {candidate.paper_id: candidate for candidate in candidates if candidate.assessment.keep}
    assert set(kept) == {"github:acme/engine/pull/1", "github:acme/engine/releases/v2"}  # no old or pre-release
    release = kept["github:acme/engine/releases/v2"]
    assert (release.metadata.source, release.metadata.doc_type) == ("github_release", "release")
    assert "Faster window attention" not in release.raw_text and "Fused SDPA kernel" in release.raw_text
    pull = kept["github:acme/engine/pull/1"]
    assert (pull.metadata.source, pull.metadata.doc_type, pull.metadata.venue) == ("github_pr", "pull_request", "acme/engine")
    assert [(r.name, r.fetched, r.kept) for r in results][:2] == [("acme/engine merged PRs", 2, 1), ("acme/engine releases", 1, 1)]
    assert advanced == {key: NOW for key in ("github:acme/engine:pulls", "github:acme/engine:releases", "github:acme/server:pulls")}


def test_rate_limit_stops_github_for_this_run_and_keeps_the_old_cursors():
    upstream = Upstream.model_validate({"github": ["acme/engine", "acme/server", "acme/third"]})
    api = FakeGitHub(pulls={"acme/engine": [pr(1, "[Perf] Fused decode kernel")]}, rate_limited={"acme/server"})
    candidates, results, advanced = fetch_upstream(upstream, SETTINGS, {}, now=NOW, github=api.client())
    assert [candidate.paper_id for candidate in candidates] == ["github:acme/engine/pull/1"]
    assert set(advanced) == {"github:acme/engine:pulls", "github:acme/engine:releases"}
    blocked = [result for result in results if result.error]
    assert [result.name for result in blocked] == [
        "acme/server merged PRs", "acme/server releases", "acme/third merged PRs", "acme/third releases"
    ]  # fmt: skip
    assert "rate limit" in blocked[0].error
    assert len(api.queries()) == 2  # nothing more was asked of GitHub after the limit


def test_github_works_without_a_token_and_drops_a_rejected_one(monkeypatch):
    for name in github_module.TOKEN_VARIABLES:
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(github_module.shutil, "which", lambda name: None)
    monkeypatch.setattr(github_module, "GH_FALLBACK_PATHS", ())
    assert github_token() is None
    monkeypatch.setenv("GH_TOKEN", "from-env")
    assert github_token() == "from-env"

    assert GitHubClient.search_interval_anonymous > GitHubClient.search_interval_token  # 10 vs 30 searches a minute
    api = FakeGitHub(pulls={"acme/engine": [pr(1, "[Perf] Fused decode kernel")]})
    anonymous = api.client(use_token=False)
    assert len(anonymous.merged_pulls("acme/engine", NOW - timedelta(days=2), 1)[0]) == 1
    assert "authorization" not in api.requests[-1].headers

    rejecting = FakeGitHub(pulls={"acme/engine": [pr(1, "[Perf] Fused decode kernel")]}, reject_token=True)
    client = rejecting.client(token="expired")
    assert len(client.merged_pulls("acme/engine", NOW - timedelta(days=2), 1)[0]) == 1
    assert client.token is None
    assert ["authorization" in request.headers for request in rejecting.requests] == [True, False]


def test_discover_upstream_stores_new_items_once_and_selects_them_for_distillation(db, demo_repo, tmp_path):
    from paperatlas.db.engine import session_scope
    from paperatlas.db.schema import Paper
    from paperatlas.lab.profiler import register_project

    profile = yaml.safe_load((demo_repo / "lab.yaml").read_text())
    profile["upstream"] = {
        "github": ["acme/engine", "acme/server"],
        "feeds": [{"name": "Lab blog", "url": "https://blog.example.com/feed.xml"}],
        "exclude": ["CUDA"],
    }
    (demo_repo / "lab.yaml").write_text(yaml.safe_dump(profile))
    project_id = register_project(demo_repo)["id"]
    recent = (datetime.now(UTC) - timedelta(days=1)).strftime("%Y-%m-%dT%H:%M:%SZ")
    api = FakeGitHub(
        pulls={
            "acme/engine": [
                pr(1, "[Perf] Fused decode kernel", merged=recent),
                pr(2, "[Perf] Overlap prefill and decode scheduling", merged=recent),
                pr(3, "[Bugfix] Fix crash", merged=recent),
            ],
            "acme/server": [pr(4, "[Perf] Prefix cache hit rate up 30%", merged=recent)],
        }
    )
    rss = RSS.replace("26 Nov 2026", datetime.now(UTC).strftime("%d %b %Y"))
    feeds = feed_client(
        {
            "https://blog.example.com/feed.xml": rss,
            "https://blog.example.com/spec": "<html><body><article>" + "Lookahead drafting halves decode latency. " * 60 + "</article></body></html>",
        }
    )
    cursors = CursorStore(tmp_path / "cursors.json")

    dry = discover_upstream(project_id, github=api.client(), feeds=feeds, cursors=cursors, dry_run=True)
    assert len(dry.kept) == 4 and not dry.stored and not cursors.path.exists()

    stats = discover_upstream(project_id, github=api.client(), feeds=feeds, cursors=cursors)
    assert sorted(stats.stored) == sorted(
        ["github:acme/engine/pull/1", "github:acme/engine/pull/2", "github:acme/server/pull/4", stats.kept[-1].paper_id]
    )
    assert stats.kept[-1].paper_id.startswith("blog:")
    # the best of each source in turn: engine, server, blog, then engine's second
    assert [paper_id.split("/pull/")[0] if "/pull/" in paper_id else "blog" for paper_id in stats.selected] == [
        "github:acme/engine", "github:acme/server", "blog", "github:acme/engine"
    ]  # fmt: skip
    with session_scope() as session:
        rows = {p.paper_id: p for p in session.scalars(select(Paper).where(Paper.paper_id.in_(stats.stored)))}
        assert {p.source for p in rows.values()} == {"github_pr", "engineering_blog"}
        assert all(p.embedding is not None for p in rows.values())
        blog = rows[stats.kept[-1].paper_id]
        assert blog.doc_type == "blog" and "halves decode latency" in blog.raw_text  # read from the post page
        assert rows["github:acme/engine/pull/1"].source_payload["upstream"]["score"] >= SETTINGS.min_score
    assert set(cursors.load()) == {
        "github:acme/engine:pulls", "github:acme/engine:releases", "github:acme/server:pulls",
        "github:acme/server:releases", "feed:https://blog.example.com/feed.xml",
    }  # fmt: skip

    again = discover_upstream(project_id, github=api.client(), feeds=feeds, cursors=cursors)
    assert not again.stored  # already stored: nothing new
    assert set(again.selected) == set(stats.selected)  # still undistilled, so still candidates


def test_project_without_upstream_is_a_no_op(db, demo_repo):
    from paperatlas.lab.profiler import register_project

    project_id = register_project(demo_repo)["id"]
    stats = discover_upstream(project_id, github=pytest.fail, feeds=pytest.fail)
    assert not stats.results and not stats.selected


def test_scan_discovery_adds_the_project_engineering_items_and_survives_their_failure(db, demo_repo, monkeypatch):
    from paperatlas.discovery import ranking, upstream
    from paperatlas.discovery.upstream import UpstreamStats
    from paperatlas.lab.profiler import register_project

    project_id = register_project(demo_repo)["id"]
    seen = {}

    def fake(project, **kwargs):
        seen["project"] = project
        return UpstreamStats(selected=["github:acme/engine/pull/1"])

    monkeypatch.setattr(upstream, "discover_upstream", fake)
    stats = ranking.discover(project_id=project_id, sources=[], expand=False)
    assert seen["project"] == project_id
    assert stats.upstream == stats.selected == ["github:acme/engine/pull/1"]

    def broken(project, **kwargs):
        raise RuntimeError("network down")

    monkeypatch.setattr(upstream, "discover_upstream", broken)
    messages = []
    stats = ranking.discover(project_id=project_id, sources=[], expand=False, report=lambda s, m, d=None: messages.append(m))
    assert stats.upstream == [] and any("network down" in message for message in messages)


def test_engineering_documents_get_their_own_prompt_and_fewer_concepts():
    from paperatlas.distill.extractor import ClaimExtractor

    class Recorder:
        def __init__(self):
            self.systems = []

        def generate_json(self, system, user, schema_name, schema):
            self.systems.append(system)
            return {"paper_summary": "", "concepts": []}

    llm = Recorder()
    extractor = ClaimExtractor(llm)
    extractor._extract_llm({"doc_type": "pull_request", "title": "[Perf] Fused decode kernel"})
    extractor._extract_llm({"doc_type": "paper", "title": "A paper"})
    assert "a merged pull request" in llm.systems[0] and "between 1 and 4" in llm.systems[0]
    assert "a research paper or patent" in llm.systems[1] and "between 5 and 10" in llm.systems[1]
