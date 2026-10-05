#!/usr/bin/env python3
"""Render reproducible README screenshots from a real pi TUI session.

Captures the autoresume extension running in pi's terminal UI through a PTY,
interprets the ANSI stream with pyte, and draws the final screen with Pillow.

Requirements (dev-only, not a package dependency):
    python3 -m pip install --user pyte pillow

Usage:
    python3 scripts/make-screenshots.py
Writes: assets/autoresume-waiting.png, assets/autoresume-status.png
"""

from __future__ import annotations

import fcntl
import json
import os
import pty
import select
import shutil
import struct
import sys
import tempfile
import termios
import time
from pathlib import Path

import pyte
from PIL import Image, ImageDraw, ImageFont

REPO = Path(__file__).resolve().parent.parent
COLS, ROWS = 100, 30
FONT_PATH = "/System/Library/Fonts/Menlo.ttc"
BG = "#16181c"
CHROME = "#1f2229"
FG = "#cfd4dc"
DIM = "#8b93a1"

# pyte reports terminal colors as named values or hex strings.
NAMED = {
    "default": None,
    "red": "#cd0000",
    "green": "#00cd00",
    "yellow": "#cdcd00",
    "blue": "#0000cd",
    "magenta": "#cd00cd",
    "cyan": "#00cdcd",
    "white": "#e5e5e5",
    "black": "#000000",
}
HOURGLASS = "\u23f3"


def color(value: str | None, fallback: str) -> str:
    if not value or value == "default":
        return fallback
    if value in NAMED and NAMED[value]:
        return NAMED[value]
    if len(value) == 6:
        try:
            int(value, 16)
            return "#" + value
        except ValueError:
            pass
    return fallback


def draw_hourglass(draw: ImageDraw.ImageDraw, x: int, y: int, w: int, h: int) -> None:
    """Menlo has no U+23F3 glyph; draw the footer hourglass by hand."""
    top = y + 5
    bottom = y + h - 4
    mid = (top + bottom) // 2
    left = x + 2
    right = x + w - 3
    draw.line([(left, top), (right, top)], fill="#e0b64a", width=2)
    draw.line([(left, bottom), (right, bottom)], fill="#e0b64a", width=2)
    draw.polygon([(left + 1, top + 2), (right - 1, top + 2), (x + w // 2, mid)], fill="#e0b64a")
    draw.polygon([(left + 1, bottom - 2), (right - 1, bottom - 2), (x + w // 2, mid)], fill="#e0b64a")


def render(screen: pyte.Screen, title: str) -> Image.Image:
    size = 22
    regular = ImageFont.truetype(FONT_PATH, size, index=0)
    bold = ImageFont.truetype(FONT_PATH, size, index=1)
    cw = round(regular.getlength("M"))
    ch = size + 7
    pad, chrome_h = 16, 46
    width, height = COLS * cw + pad * 2, ROWS * ch + chrome_h + pad
    img = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(img)
    draw.rounded_rectangle([0, 0, width - 1, height - 1], radius=12, fill=BG, outline="#2a2d33")
    draw.rounded_rectangle([0, 0, width - 1, chrome_h], radius=12, fill=CHROME)
    draw.rectangle([0, chrome_h - 12, width - 1, chrome_h], fill=CHROME)
    for i, dot in enumerate(("#ff5f57", "#febc2e", "#28c840")):
        draw.ellipse([pad + i * 22, chrome_h // 2 - 7, pad + i * 22 + 14, chrome_h // 2 + 7], fill=dot)
    draw.text((pad + 84, chrome_h // 2 - 11), title, fill=DIM, font=regular)

    for y in range(ROWS):
        for x in range(COLS):
            cell = screen.buffer[y][x]
            fg = color(cell.fg, FG)
            bg = color(cell.bg, BG)
            if cell.reverse:
                fg, bg = bg, fg
            px, py = pad + x * cw, chrome_h + y * ch
            if cell.data == HOURGLASS:
                draw_hourglass(draw, px, py, cw, ch)
                continue
            if bg != BG:
                draw.rectangle([px, py, px + cw - 1, py + ch - 1], fill=bg)
            if cell.data and cell.data != " ":
                draw.text((px, py + 2), cell.data, fill=fg, font=bold if cell.bold else regular)
    return img


def capture() -> tuple[bytes, bytes]:
    """Run the real TUI in a PTY and return the waiting-state and status-state byte streams."""
    agent_dir = tempfile.mkdtemp(prefix="pi-shot-agent-")
    try:
        (Path(agent_dir) / "settings.json").write_text(json.dumps({"retry": {"enabled": False}}))

        cmd = [
            "pi",
            "--no-session",
            "-a",
            "-ne",
            "-e",
            str(REPO / "extensions" / "autoresume.ts"),
            "-e",
            str(REPO / "test" / "integration" / "stub-provider.ts"),
            "--provider",
            "stub",
            "--model",
            "stub-limit",
        ]
        env = dict(
            os.environ,
            PI_CODING_AGENT_DIR=agent_dir,
            PI_OFFLINE="1",
            PI_SKIP_VERSION_CHECK="1",
            TERM="xterm-256color",
            STUB_LIMIT_TEXT="Rate limit reached. Please try again in 42 min.",
        )
        pid, fd = pty.fork()
        if pid == 0:  # child
            os.chdir(REPO)
            os.execvpe(cmd[0], cmd, env)

        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

        def read_until(needle: str, timeout: float) -> bytes:
            out = b""
            deadline = time.time() + timeout
            while needle.encode() not in out and time.time() < deadline:
                ready, _, _ = select.select([fd], [], [], 0.2)
                if ready:
                    try:
                        chunk = os.read(fd, 1 << 16)
                    except OSError:
                        break
                    if not chunk:
                        break
                    out += chunk
            return out

        try:
            read_until("__startup__", 3.0)  # let the TUI paint its first frame
            os.write(fd, b"hello\r")
            first = read_until("limit hit", 20)
            time.sleep(0.5)
            first += read_until("__drain__", 0.5)
            os.write(fd, b"/autoresume status\r")
            second = read_until("waiting", 10)
            time.sleep(0.5)
            second += read_until("__drain__", 0.5)
        finally:
            os.kill(pid, 15)
            for _ in range(20):
                try:
                    if os.waitpid(pid, os.WNOHANG)[0] != 0:
                        break
                except ChildProcessError:
                    break
                time.sleep(0.05)
            try:
                os.close(fd)
            except OSError:
                pass
        return first, second
    finally:
        shutil.rmtree(agent_dir, ignore_errors=True)


def main() -> int:
    first, second = capture()
    waiting = pyte.Screen(COLS, ROWS)
    pyte.Stream(waiting).feed(first.decode("utf-8", "replace"))
    status = pyte.Screen(COLS, ROWS)
    pyte.Stream(status).feed((first + second).decode("utf-8", "replace"))

    assets = REPO / "assets"
    assets.mkdir(exist_ok=True)
    out1, out2 = assets / "autoresume-waiting.png", assets / "autoresume-status.png"
    render(waiting, "pi — autoresume").save(out1)
    render(status, "pi — autoresume").save(out2)
    print(f"wrote {out1}\nwrote {out2}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
