"""Subprocess helper with log capture, cancellation and periodic progress callbacks."""

from __future__ import annotations

import os
import queue
import signal
import subprocess
import threading
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Optional, Sequence


class Cancelled(RuntimeError):
    pass


@dataclass
class CommandResult:
    returncode: int
    tail: str
    duration_s: float
    log_path: Path

    @property
    def ok(self) -> bool:
        return self.returncode == 0


def run_command(
    command: Sequence[str] | str,
    cwd: str | Path,
    log_path: Path,
    timeout_s: Optional[float] = None,
    env: Optional[dict[str, str]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
    on_progress: Optional[Callable[[str], None]] = None,
    progress_every_s: float = 20.0,
    tail_lines: int = 60,
) -> CommandResult:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.monotonic()
    last_progress = started
    tail: deque[str] = deque(maxlen=tail_lines)
    shell = isinstance(command, str)
    full_env = {**os.environ, **(env or {})}
    full_env.pop("VIRTUAL_ENV", None)
    lines: queue.Queue[Optional[str]] = queue.Queue()

    with log_path.open("a", encoding="utf-8") as log:
        log.write(f"$ {command if shell else ' '.join(command)}\n")
        log.flush()
        process = subprocess.Popen(
            command,
            cwd=str(cwd),
            shell=shell,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            text=True,
            errors="replace",
            bufsize=1,
            env=full_env,
            start_new_session=True,
        )

        def pump() -> None:
            assert process.stdout is not None
            for line in process.stdout:
                lines.put(line)
            lines.put(None)

        threading.Thread(target=pump, daemon=True).start()
        finished_reading = False
        while not finished_reading:
            try:
                line = lines.get(timeout=0.5)
            except queue.Empty:
                line = ""
            if line is None:
                finished_reading = True
            elif line:
                log.write(line)
                tail.append(line.rstrip())
            now = time.monotonic()
            if should_cancel and should_cancel():
                _kill(process)
                log.write("[cancelled]\n")
                raise Cancelled("cancelled by user")
            if timeout_s and now - started > timeout_s:
                _kill(process)
                tail.append(f"[timeout after {timeout_s:.0f}s]")
                log.write(tail[-1] + "\n")
                return CommandResult(124, "\n".join(tail), now - started, log_path)
            if on_progress and tail and now - last_progress > progress_every_s:
                on_progress(tail[-1])
                last_progress = now
        process.wait()
        log.write(f"[exit {process.returncode}]\n")
    return CommandResult(process.returncode, "\n".join(tail), time.monotonic() - started, log_path)


def _kill(process: subprocess.Popen) -> None:
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=15)
    except (ProcessLookupError, subprocess.TimeoutExpired):
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
