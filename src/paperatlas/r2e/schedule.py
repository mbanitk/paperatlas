"""Weekly scheduled scan + digest via macOS launchd (opt-in: printed unless --install)."""

from __future__ import annotations

import plistlib
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

LABEL = "com.paperatlas.r2e-weekly-scan"


def plist_for(project: str, weekday: int, hour: int, workdir: Path) -> dict:
    executable = shutil.which("paperatlas") or str(Path(sys.executable).with_name("paperatlas"))
    run, name = shlex.quote(executable), shlex.quote(project)
    script = (
        f"cd {shlex.quote(str(workdir))} && {run} r2e scan --project {name} --refresh-topics --inline "
        f"&& {run} r2e digest --project {name}"
    )
    logs = workdir / "data" / "r2e" / "schedule.log"
    return {
        "Label": LABEL,
        "ProgramArguments": ["/bin/zsh", "-lc", script],
        "StartCalendarInterval": {"Weekday": weekday, "Hour": hour, "Minute": 0},
        "StandardOutPath": str(logs),
        "StandardErrorPath": str(logs),
        "WorkingDirectory": str(workdir),
    }


def schedule(project: str, weekday: int = 1, hour: int = 8, install: bool = False, workdir: Path | None = None) -> Path | str:
    workdir = (workdir or Path.cwd()).resolve()
    payload = plistlib.dumps(plist_for(project, weekday, hour, workdir)).decode()
    if not install:
        return payload
    (workdir / "data" / "r2e").mkdir(parents=True, exist_ok=True)
    path = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")
    subprocess.run(["launchctl", "unload", str(path)], capture_output=True)
    subprocess.run(["launchctl", "load", str(path)], check=True)
    return path


def unschedule() -> bool:
    path = Path.home() / "Library" / "LaunchAgents" / f"{LABEL}.plist"
    if not path.exists():
        return False
    subprocess.run(["launchctl", "unload", str(path)], capture_output=True)
    path.unlink()
    return True
