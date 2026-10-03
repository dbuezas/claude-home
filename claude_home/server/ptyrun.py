#!/usr/bin/env python3
# Run interactive Claude Code in a pseudo-terminal (there is no real terminal in the
# add-on), answer its start-up questions, and copy its screen text to stdout.
# Usage: ptyrun.py <cmd> [args...]
import os, pty, re, select, signal, sys, time

pid, fd = pty.fork()
if pid == 0:
    os.environ["TERM"] = "xterm-256color"
    os.execvp(sys.argv[1], sys.argv[1:])

# Forward a stop request to Claude.
signal.signal(signal.SIGTERM, lambda *_: os.kill(pid, signal.SIGTERM))

ANSI = re.compile(rb"\x1b\[[0-9;?<>=]*[a-zA-Z~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\r")
DOWN, ENTER = b"\x1b[B", b"\r"
# (pattern on screen, keys to send): each answered once.
PROMPTS = [
    (rb"Yes,\s*I\s*accept", DOWN + ENTER),                 # bypass-permissions warning: pick "Yes, I accept"
    (rb"Enable\s*Remote\s*Control\?.*\(y/n\)", b"y" + ENTER),  # first-run Remote Control consent
    (rb"fullscreen\s*renderer\?", DOWN + ENTER),           # renderer offer: pick "Not now"
]
done = set()
screen = b""
while True:
    r, _, _ = select.select([fd], [], [], 1.0)
    if fd in r:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        clean = ANSI.sub(b"", data)
        sys.stdout.buffer.write(clean)
        sys.stdout.flush()
        screen = (screen + clean)[-4000:]
        for i, (pattern, keys) in enumerate(PROMPTS):
            if i not in done and re.search(pattern, screen, re.I | re.S):
                done.add(i)
                time.sleep(0.5)
                for k in (keys[:-1], keys[-1:]) if keys.endswith(ENTER) and len(keys) > 1 else (keys,):
                    os.write(fd, k)
                    time.sleep(0.3)
    try:
        if os.waitpid(pid, os.WNOHANG)[0]:
            break
    except ChildProcessError:
        break
