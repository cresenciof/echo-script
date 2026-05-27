"""CLI entrypoint: `python -m whisper_sidecar --port 0`.

The Tauri parent reads `SIDECAR_READY <port>` from stdout to learn which
ephemeral port we bound to. We pre-bind a socket so we can print the
actual port BEFORE uvicorn finishes starting up, then hand the FD to
uvicorn so there's no race window.
"""

from __future__ import annotations

import argparse
import logging
import os
import signal
import socket
import sys
import threading
import time

# Make sibling binaries (ffmpeg, ffprobe — bundled next to the Python
# interpreter inside .venv-bundle/bin/) discoverable via subprocess.
# mlx_whisper shells out to ffmpeg to decode audio, and audio.py uses
# shutil.which("ffprobe"). When the macOS .app is launched via Finder
# the inherited PATH is minimal and won't include /opt/homebrew/bin or
# similar, so we explicitly inject our own bin dir.
_sibling_bin = os.path.join(sys.prefix, "bin")
if os.path.isdir(_sibling_bin):
    os.environ["PATH"] = _sibling_bin + os.pathsep + os.environ.get("PATH", "")

import uvicorn

from .app import create_app
from .config import Settings


def _pick_port(host: str, requested: int) -> tuple[int, socket.socket]:
    """Bind a TCP socket and return the (port, socket) for uvicorn to adopt."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, requested))
    sock.listen(128)
    port = sock.getsockname()[1]
    return port, sock


def _announce_ready(port: int) -> None:
    """Single-line handshake Tauri parses. Flush so the parent never blocks."""
    sys.stdout.write(f"SIDECAR_READY {port}\n")
    sys.stdout.flush()


def _install_signal_handlers(server: uvicorn.Server) -> None:
    def handler(signum, _frame):  # noqa: ANN001 — signal signature
        logging.getLogger(__name__).info("signal %s received, shutting down", signum)
        server.should_exit = True

    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)


def _watch_parent(initial_ppid: int, interval_s: float = 5.0) -> None:
    """Daemon thread: poll the parent PID. If it changes (i.e. Tauri died
    ungracefully and we got reparented to launchd) self-SIGTERM so the
    Whisper model — up to ~3 GB of unified memory — is released within
    a few seconds instead of lingering as a zombie.

    Without this guard, kill -9 / force-quit / kernel panic on the Tauri
    parent leaves us holding RAM that contributes to system-wide memory
    pressure on subsequent runs.
    """
    log = logging.getLogger(__name__)
    while True:
        time.sleep(interval_s)
        current = os.getppid()
        if current != initial_ppid:
            log.warning(
                "parent process %d died (now reparented to %d) — exiting",
                initial_ppid,
                current,
            )
            os.kill(os.getpid(), signal.SIGTERM)
            return


def run(argv: list[str] | None = None) -> None:
    settings = Settings()
    parser = argparse.ArgumentParser(prog="whisper-sidecar")
    parser.add_argument("--host", default=settings.host)
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("PORT", settings.port)),
        help="0 = pick an ephemeral port",
    )
    parser.add_argument("--log-level", default=settings.log_level)
    args = parser.parse_args(argv)

    settings = Settings(host=args.host, port=args.port, log_level=args.log_level)

    # Parent watchdog — orphan-detection. Set WHISPER_SIDECAR_NO_PARENT_WATCH=1
    # to disable when running the sidecar standalone from a terminal where
    # the shell may legitimately exit and re-attach.
    if not os.environ.get("WHISPER_SIDECAR_NO_PARENT_WATCH"):
        initial_ppid = os.getppid()
        # ppid==1 means we were already launched directly by launchd; nothing
        # to watch in that case.
        if initial_ppid != 1:
            threading.Thread(
                target=_watch_parent,
                args=(initial_ppid,),
                daemon=True,
                name="parent-watch",
            ).start()

    port, sock = _pick_port(settings.host, settings.port)
    _announce_ready(port)

    app = create_app(settings)
    config = uvicorn.Config(
        app,
        log_level=settings.log_level,
        access_log=False,
        # Even though we provide a socket, uvicorn still surfaces these in logs.
        host=settings.host,
        port=port,
        loop="asyncio",
    )
    server = uvicorn.Server(config)
    _install_signal_handlers(server)
    server.run(sockets=[sock])


if __name__ == "__main__":
    run()
