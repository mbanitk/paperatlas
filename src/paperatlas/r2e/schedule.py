"""Scheduled runs via macOS launchd (opt-in: printed unless --install).

- weekly: scan + digest;
- daily: `r2e daily` (new papers → claim cards → experiments; see r2e/daily.py).
"""

from __future__ import annotations

import plistlib
import shlex
import shutil
import subprocess
import sys
from pathlib import Path

LABEL = "com.paperatlas.r2e-weekly-scan"
DAILY_LABEL = "com.paperatlas.r2e-daily"


def plist_for(project: str, weekday: int, hour: int, workdir: Path, daily: bool = False, minute: int = 0) -> dict:
    executable = shutil.which("paperatlas") or str(Path(sys.executable).with_name("paperatlas"))
    run, name = shlex.quote(executable), shlex.quote(project)
    if daily:
        script = f"cd {shlex.quote(str(workdir))} && /usr/bin/caffeinate -i {run} r2e daily --project {name}"
        logs = workdir / "data" / "logs" / "daily.log"
        when = {"Hour": hour, "Minute": minute}
    else:
        script = (
            f"cd {shlex.quote(str(workdir))} && {run} r2e scan --project {name} --refresh-topics --inline "
            f"&& {run} r2e digest --project {name}"
        )
        logs = workdir / "data" / "r2e" / "schedule.log"
        when = {"Weekday": weekday, "Hour": hour, "Minute": minute}
    plist = {
        "Label": DAILY_LABEL if daily else LABEL,
        "ProgramArguments": ["/bin/zsh", "-lc", script],
        "StartCalendarInterval": when,
        "StandardOutPath": str(logs),
        "StandardErrorPath": str(logs),
        "WorkingDirectory": str(workdir),
    }
    if daily:
        # The run starts the services/batch in their own sessions; launchd must not kill them when it exits.
        plist["AbandonProcessGroup"] = True
    return plist


def schedule(
    project: str,
    weekday: int = 1,
    hour: int = 8,
    install: bool = False,
    workdir: Path | None = None,
    daily: bool = False,
    minute: int = 0,
) -> Path | str:
    workdir = (workdir or Path.cwd()).resolve()
    plist = plist_for(project, weekday, hour, workdir, daily, minute)
    payload = plistlib.dumps(plist).decode()
    if not install:
        return payload
    Path(plist["StandardOutPath"]).parent.mkdir(parents=True, exist_ok=True)
    path = Path.home() / "Library" / "LaunchAgents" / f"{plist['Label']}.plist"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(payload, encoding="utf-8")
    subprocess.run(["launchctl", "unload", str(path)], capture_output=True)
    subprocess.run(["launchctl", "load", str(path)], check=True)
    return path


def unschedule(daily: bool = False) -> bool:
    path = Path.home() / "Library" / "LaunchAgents" / f"{DAILY_LABEL if daily else LABEL}.plist"
    if not path.exists():
        return False
    subprocess.run(["launchctl", "unload", str(path)], capture_output=True)
    path.unlink()
    return True
