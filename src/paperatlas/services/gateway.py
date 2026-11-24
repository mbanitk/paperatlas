"""gateway — serves the web console and proxies /api/research/* and /api/lab/* to the services."""

from __future__ import annotations

from pathlib import Path
from typing import AsyncIterator
from urllib.parse import quote

import httpx
from fastapi import Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from starlette.background import BackgroundTask

from paperatlas.services.common import LAB_URL, RESEARCH_URL, create_app
from paperatlas.settings import env

WEB_DIST = Path(env("PAPERATLAS_WEB_DIST") or Path(__file__).resolve().parents[3] / "web" / "dist")
BACKENDS = {"research": RESEARCH_URL, "lab": LAB_URL}
HOP_HEADERS = {"host", "content-length", "connection", "keep-alive", "transfer-encoding", "upgrade"}

app = create_app("gateway", "Web console + API gateway.")
client = httpx.AsyncClient(timeout=httpx.Timeout(60.0, read=None))


def _raw_subpath(request: Request, service: str, path: str) -> str:
    """The still-percent-encoded path after /api/{service}/ (so %23 / %3F in ids survive)."""
    raw = request.scope.get("raw_path")
    prefix = f"/api/{service}/".encode()
    if raw and raw.startswith(prefix):
        return raw[len(prefix):].decode("latin-1")
    return quote(path, safe="/:@!$&'()*+,;=-._~")


async def _stream(response: httpx.Response) -> AsyncIterator[bytes]:
    try:
        async for chunk in response.aiter_raw():
            yield chunk
    finally:
        await response.aclose()


@app.api_route("/api/{service}/{path:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE"])
async def proxy(service: str, path: str, request: Request):
    base = BACKENDS.get(service)
    if base is None:
        return JSONResponse({"detail": f"unknown service '{service}'"}, status_code=404)
    upstream = client.build_request(
        request.method,
        f"{base}/{_raw_subpath(request, service, path)}",
        params=request.query_params,
        headers={k: v for k, v in request.headers.items() if k.lower() not in HOP_HEADERS},
        content=await request.body(),
    )
    try:
        response = await client.send(upstream, stream=True)
    except httpx.ConnectError:
        return JSONResponse({"detail": f"{service} service is not reachable at {base}"}, status_code=502)
    return StreamingResponse(
        _stream(response),
        status_code=response.status_code,
        headers={k: v for k, v in response.headers.items() if k.lower() not in HOP_HEADERS},
        background=BackgroundTask(response.aclose),
    )


@app.get("/api/services", tags=["system"])
async def services_health() -> dict[str, dict]:
    result = {}
    for name, base in BACKENDS.items():
        try:
            response = await client.get(f"{base}/health", timeout=3.0)
            result[name] = {"url": base, "status": "ok" if response.status_code == 200 else f"http {response.status_code}"}
        except httpx.HTTPError as exc:
            result[name] = {"url": base, "status": f"down ({type(exc).__name__})"}
    return result


@app.get("/{path:path}", include_in_schema=False)
async def web(path: str):
    if not WEB_DIST.exists():
        return JSONResponse(
            {"detail": "Web console not built. Run `npm install && npm run build` in web/ (or `npm run dev`)."},
            status_code=503,
        )
    candidate = (WEB_DIST / path).resolve()
    if path and candidate.is_file() and WEB_DIST.resolve() in candidate.parents:
        return FileResponse(candidate)
    return FileResponse(WEB_DIST / "index.html")
