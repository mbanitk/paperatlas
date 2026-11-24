"""Shared FastAPI plumbing for the PaperAtlas microservices."""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator, Callable, Optional

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse

from paperatlas.lab.service import ServiceError
from paperatlas.settings import env

GATEWAY_PORT = int(env("PAPERATLAS_GATEWAY_PORT", "8100"))
RESEARCH_PORT = int(env("PAPERATLAS_RESEARCH_PORT", "8101"))
LAB_PORT = int(env("PAPERATLAS_LAB_PORT", "8102"))
RESEARCH_URL = env("PAPERATLAS_RESEARCH_URL", f"http://127.0.0.1:{RESEARCH_PORT}")
LAB_URL = env("PAPERATLAS_LAB_URL", f"http://127.0.0.1:{LAB_PORT}")


def configure_logging(level: int = logging.INFO) -> None:
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    for noisy in ("httpx", "httpx2", "httpcore", "huggingface_hub", "sentence_transformers", "transformers"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def create_app(name: str, description: str) -> FastAPI:
    app = FastAPI(title=f"PaperAtlas {name}", description=description, version="0.2.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"http://(localhost|127\.0\.0\.1)(:\d+)?",
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.exception_handler(ServiceError)
    async def _service_error(_: Request, exc: ServiceError) -> JSONResponse:
        return JSONResponse({"detail": str(exc)}, status_code=exc.status_code)

    @app.get("/health", tags=["system"])
    def health() -> dict[str, str]:
        return {"service": name, "status": "ok"}

    return app


def sse_response(
    fetch: Callable[[int], list[dict[str, Any]]],
    request: Request,
    after_id: int = 0,
    poll_s: float = 1.0,
    heartbeat_s: float = 15.0,
) -> StreamingResponse:
    """Stream rows returned by `fetch(after_id)` as Server-Sent Events (polling Postgres)."""
    last_event = request.headers.get("last-event-id")
    cursor = int(last_event) if last_event and last_event.isdigit() else after_id

    async def generate() -> AsyncIterator[str]:
        nonlocal cursor
        idle = 0.0
        yield "retry: 3000\n\n"
        while not await request.is_disconnected():
            rows = await asyncio.to_thread(fetch, cursor)
            for row in rows:
                cursor = max(cursor, int(row["id"]))
                yield f"id: {row['id']}\nevent: progress\ndata: {json.dumps(row, default=str)}\n\n"
            if rows:
                idle = 0.0
            else:
                idle += poll_s
                if idle >= heartbeat_s:
                    idle = 0.0
                    yield ": keep-alive\n\n"
            await asyncio.sleep(poll_s)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


def body_value(body: Optional[dict], key: str, default: Any = None) -> Any:
    return (body or {}).get(key, default)
