"""`paperatlas services up` — run all services as local processes with prefixed logs."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import threading
import time
from typing import Optional

from paperatlas.services.common import GATEWAY_PORT, LAB_PORT, RESEARCH_PORT

COLORS = {"gateway": "36", "research": "35", "lab": "34", "worker": "33", "llm": "32"}


def service_commands(host: str = "127.0.0.1", reload: bool = False) -> dict[str, list[str]]:
    python = sys.executable
    uvicorn = [python, "-m", "uvicorn", "--host", host, "--log-level", "warning"] + (["--reload"] if reload else [])
    return {
        "research": uvicorn + ["--port", str(RESEARCH_PORT), "paperatlas.services.research_api:app"],
        "lab": uvicorn + ["--port", str(LAB_PORT), "paperatlas.services.lab_api:app"],
        "gateway": uvicorn + ["--port", str(GATEWAY_PORT), "paperatlas.services.gateway:app"],
        "worker": [python, "-m", "paperatlas.services.worker"],
        **_llm_service(),
    }


def _llm_service() -> dict[str, list[str]]:
    """The local LLM (`mlx_lm.server`) when PAPERATLAS_LLM_PROVIDER=mlx."""
    from paperatlas.llm.client import mlx_server_command
    from paperatlas.settings import env

    if (env("PAPERATLAS_LLM_PROVIDER") or "").lower() != "mlx":
        return {}
    url = env("PAPERATLAS_MLX_LLM_URL", "http://127.0.0.1:8103/v1")
    port = int(url.rsplit(":", 1)[-1].split("/", 1)[0]) if url.count(":") >= 2 else 8103
    return {"llm": mlx_server_command(port)}


def _pump(name: str, process: subprocess.Popen) -> None:
    color = COLORS.get(name, "0")
    prefix = f"\033[{color}m{name:>8}\033[0m | " if sys.stdout.isatty() else f"{name:>8} | "
    assert process.stdout is not None
    for line in process.stdout:
        sys.stdout.write(prefix + line)
        sys.stdout.flush()


def up(only: Optional[list[str]] = None, host: str = "127.0.0.1", reload: bool = False) -> int:
    from paperatlas.db import migrate

    migrate.upgrade()
    commands = service_commands(host, reload)
    names = only or list(commands)
    processes: dict[str, subprocess.Popen] = {}
    for name in names:
        processes[name] = subprocess.Popen(
            commands[name],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        threading.Thread(target=_pump, args=(name, processes[name]), daemon=True).start()
    print(f"PaperAtlas console: http://{host}:{GATEWAY_PORT}  (research :{RESEARCH_PORT}, lab :{LAB_PORT})", flush=True)

    stopping = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())
    exit_code = 0
    while not stopping.is_set():
        for name, process in processes.items():
            if process.poll() is not None:
                print(f"{name} exited with {process.returncode}; stopping all services", flush=True)
                exit_code = process.returncode or 1
                stopping.set()
                break
        stopping.wait(1.0)
    for process in processes.values():
        if process.poll() is None:
            process.terminate()
    deadline = time.monotonic() + 20
    for process in processes.values():
        try:
            process.wait(timeout=max(0.1, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            process.kill()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                print(f"process {process.pid} did not exit after SIGKILL", flush=True)
    return exit_code
