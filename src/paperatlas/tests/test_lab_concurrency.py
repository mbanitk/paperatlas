"""run_command keeps enforcing its deadline/cancellation after the child closes stdout, and a
worker shutdown kills the child's process group."""

import threading
import time

import pytest

from paperatlas.lab import process
from paperatlas.lab.process import Cancelled, WorkerShutdown, run_command

CLOSES_STDOUT = "exec >/dev/null 2>&1; sleep 30"


def test_timeout_is_enforced_after_stdout_closes(tmp_path):
    started = time.monotonic()
    result = run_command(CLOSES_STDOUT, tmp_path, tmp_path / "run.log", timeout_s=1)
    assert result.returncode == 124 and time.monotonic() - started < 10


def test_cancel_is_enforced_after_stdout_closes(tmp_path):
    deadline = time.monotonic() + 1
    started = time.monotonic()
    with pytest.raises(Cancelled):
        run_command(CLOSES_STDOUT, tmp_path, tmp_path / "run.log", should_cancel=lambda: time.monotonic() > deadline)
    assert time.monotonic() - started < 10


def test_worker_shutdown_kills_running_commands(tmp_path, monkeypatch):
    monkeypatch.setattr(process, "_shutdown", threading.Event())
    errors = []

    def run():
        try:
            run_command("sleep 30", tmp_path, tmp_path / "run.log")
        except WorkerShutdown as exc:
            errors.append(exc)

    thread = threading.Thread(target=run)
    thread.start()
    time.sleep(0.5)
    process.request_shutdown()
    thread.join(timeout=10)
    assert not thread.is_alive() and errors
    with pytest.raises(WorkerShutdown):
        run_command("true", tmp_path, tmp_path / "run.log")
