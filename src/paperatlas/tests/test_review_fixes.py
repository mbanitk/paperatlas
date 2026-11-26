import math
import shlex
from datetime import date

import httpx
import numpy as np
import pytest
from pydantic import ValidationError

from paperatlas.distill.claims import ClaimEffect
from paperatlas.distill.concept_map import parse_concept_map
from paperatlas.discovery.config import RankingSettings
from paperatlas.discovery.sources import hf_papers
from paperatlas.discovery.sources.base import HttpSource
from paperatlas.discovery.topics import cluster_papers, score_clusters, select_top


@pytest.mark.parametrize(
    ("baseline", "expected"),
    [("10% error, vanilla decoding", 20.0), ("10", 20.0), ("vanilla decoding", None), (None, None)],
)
def test_percentage_points_are_made_relative_to_the_baseline(baseline, expected):
    effect = ClaimEffect(metric="error rate", value=2, unit="pp", direction="decrease", baseline=baseline)
    gain = effect.gain_pct()
    assert gain == pytest.approx(expected) if expected is not None else gain is None


def test_concept_map_drops_requires_links_that_close_a_cycle():
    payload = {
        "links": [
            {"from": 1, "to": 2, "relation": "requires"},
            {"from": 2, "to": 3, "relation": "requires"},
            {"from": 3, "to": 1, "relation": "requires"},
            {"from": 3, "to": 1, "relation": "builds_on"},
        ]
    }
    links = parse_concept_map(payload, [10, 20, 30])["links"]
    assert [(l["source"], l["target"], l["relation"]) for l in links] == [
        (10, 20, "requires"),
        (20, 30, "requires"),
        (30, 10, "builds_on"),
    ]


@pytest.mark.parametrize("count", [0, 1, 2])
def test_tiny_pools_yield_no_clusters_instead_of_crashing(count):
    vectors = np.eye(4, dtype=np.float32)[:count]
    ids = [f"p{i}" for i in range(count)]
    clusters = cluster_papers(ids, vectors, {}, min_size=3)
    assert clusters == []
    score_clusters(clusters, {}, 90)
    assert select_top(clusters, 5, 2) == []


@pytest.mark.parametrize("half_life", [0, -1, math.nan, math.inf])
def test_half_life_must_be_finite_and_positive(half_life):
    with pytest.raises(ValidationError):
        RankingSettings(half_life_days=half_life)


def test_hf_search_failure_keeps_daily_feed_matches(monkeypatch):
    source = hf_papers.HuggingFacePapersSource()
    feed_item = {"paper": {"id": "2401.00001", "title": "Speculative decoding", "publishedAt": date.today().isoformat(), "upvotes": 3}}

    def request(method, url, **kwargs):
        if url == hf_papers.HF_DAILY_URL:
            return httpx.Response(200, json=[feed_item] if kwargs["params"]["p"] == 0 else [])
        raise httpx.ConnectError("down")

    monkeypatch.setattr(source, "_request", request)
    found = source.search("speculative decoding", date(2000, 1, 1), 10)
    assert [paper.arxiv_id for paper in found] == ["2401.00001"]
    assert source._failures == 0


def test_malformed_xml_is_a_source_failure_not_a_crash():
    from xml.etree import ElementTree

    class Broken(HttpSource):
        name = "broken"

        def _search(self, query, since, limit):
            ElementTree.fromstring("<feed><entry>")

    source = Broken()
    assert source.search("q", None, 5) == []
    assert source._failures == 1


def test_schedule_quotes_paths_with_spaces(tmp_path):
    from paperatlas.r2e.schedule import plist_for

    workdir = tmp_path / "my lab"
    script = plist_for("demo lab", 1, 8, workdir)["ProgramArguments"][2]
    tokens = shlex.split(script)
    assert tokens[:3] == ["cd", str(workdir), "&&"]
    assert tokens[tokens.index("--project") + 1] == "demo lab"


def test_temperature_rejection_on_the_last_attempt_is_resent(monkeypatch):
    from paperatlas.llm import client as llm_client

    payloads = []

    def post(url, headers, json, timeout):
        payloads.append(dict(json))
        if len(payloads) < 3:
            return httpx.Response(503, text="busy")
        if "temperature" in json:
            return httpx.Response(400, text="Unsupported parameter: 'temperature'")
        return httpx.Response(200, json={"output": [{"content": [{"type": "output_text", "text": "ok"}]}]})

    monkeypatch.setattr(llm_client.httpx, "post", post)
    monkeypatch.setattr(llm_client.time, "sleep", lambda _: None)
    llm = llm_client.LLMClient(llm_client.LLMConfig(api_key="k", max_retries=3))
    assert llm._call("sys", "user", None) == "ok"
    assert len(payloads) == 4 and "temperature" not in payloads[-1]


def test_gateway_keeps_encoded_path_and_closes_failed_streams(monkeypatch):
    from fastapi.testclient import TestClient

    from paperatlas.services import gateway

    seen, closed = [], []

    class FailingStream(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b"partial"
            raise httpx.ReadError("upstream died")

        async def aclose(self):
            closed.append(True)

    class Body(httpx.AsyncByteStream):
        async def __aiter__(self):
            yield b'{"ok": true}'

    class Upstream(httpx.AsyncBaseTransport):
        async def handle_async_request(self, request):
            seen.append(request.url.raw_path)
            if b"fail" in request.url.raw_path:
                return httpx.Response(200, stream=FailingStream())
            return httpx.Response(200, headers={"content-type": "application/json"}, stream=Body())

    monkeypatch.setattr(gateway, "client", httpx.AsyncClient(transport=Upstream()))
    monkeypatch.setitem(gateway.BACKENDS, "research", "http://research.test")
    web = TestClient(gateway.app)
    assert web.get("/api/research/papers/arxiv%3A2401.1%23x%3Fy", params={"a": "1"}).json() == {"ok": True}
    assert seen[-1] == b"/papers/arxiv%3A2401.1%23x%3Fy?a=1"
    with pytest.raises(httpx.ReadError):
        web.get("/api/research/fail")
    assert closed


def test_openai_key_takes_precedence_over_copilot_and_copilot_works_alone(monkeypatch):
    from paperatlas.llm import client as llm

    monkeypatch.delenv("PAPERATLAS_LLM_API_KEY", raising=False)
    monkeypatch.setenv("PAPERATLAS_LLM_PROVIDER", "copilot")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    chain = llm.build_default_llm_client(use_cache=False)
    assert isinstance(chain, llm.FallbackLLMClient)
    assert [type(c) for c in chain.clients] == [llm.LLMClient, llm.CopilotCliLLMClient]

    monkeypatch.delenv("OPENAI_API_KEY")
    assert isinstance(llm.build_default_llm_client(use_cache=False), llm.CopilotCliLLMClient)
    monkeypatch.delenv("PAPERATLAS_LLM_PROVIDER")
    assert llm.build_default_llm_client(use_cache=False) is None


def test_fallback_client_uses_copilot_when_openai_fails_and_skips_a_rejected_key():
    from paperatlas.llm.client import FallbackLLMClient, LLMClient, LLMConfig, LLMError

    class Provider(LLMClient):
        def __init__(self, name, error=None):
            super().__init__(LLMConfig(api_key="", model=name))
            self.error, self.calls = error, 0

        def _call(self, system_prompt, user_prompt, schema):
            self.calls += 1
            if self.error:
                raise self.error
            return '{"answer": "%s"}' % self.model

    flaky = Provider("openai", LLMError("LLM error 500: overloaded"))
    copilot = Provider("copilot")
    chain = FallbackLLMClient([flaky, copilot])
    assert chain.generate_json("s", "u", "answer", {}) == {"answer": "copilot"}
    assert chain.model == "copilot"
    flaky.error = None
    assert chain.generate("s", "u") == '{"answer": "openai"}' and chain.model == "openai"

    revoked = Provider("openai", LLMError("LLM error 401: invalid key", unavailable=True))
    chain = FallbackLLMClient([revoked, Provider("copilot")])
    chain.generate("s", "u")
    chain.generate("s", "u")
    assert revoked.calls == 1

    with pytest.raises(LLMError, match="All LLM providers failed"):
        FallbackLLMClient([Provider("a", LLMError("down")), Provider("b", LLMError("down"))]).generate("s", "u")
