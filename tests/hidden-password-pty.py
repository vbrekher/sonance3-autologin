#!/usr/bin/env python3
"""End-to-end TTY regression: pasted Navidrome passwords must never echo."""
import hashlib
import os
import pty
import select
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PASSWORD = "test-only password: S3cret $&!\\ backslash and spaces"
EXPECTED_HASH = hashlib.sha256(PASSWORD.encode("utf-8")).hexdigest()

node_code = (
    "import {readHiddenPassword} from './scripts/build-personal.mjs';"
    "import {createHash} from 'node:crypto';"
    "const secret=readHiddenPassword();"
    "console.log('SECRET_SHA256='+createHash('sha256').update(secret).digest('hex'));"
)

pid, fd = pty.fork()
if pid == 0:
    os.chdir(ROOT)
    os.execvp("node", ["node", "--input-type=module", "-e", node_code])

captured = bytearray()
sent = False
status = None
deadline = time.monotonic() + 20

try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.1)
        if ready:
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                chunk = b""
            if chunk:
                captured.extend(chunk)
                if not sent and b"Password (hidden; paste is fine): " in captured:
                    # The Bash 'read -s' call has already disabled echo.
                    os.write(fd, PASSWORD.encode("utf-8") + b"\r")
                    sent = True
        done, code = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            status = code
            break
    if status is None:
        os.kill(pid, 9)
        os.waitpid(pid, 0)
        raise AssertionError("Password prompt timed out")
    output = captured.decode("utf-8", "replace")
    if not sent:
        raise AssertionError("The password prompt never appeared")
    if PASSWORD in output:
        raise AssertionError("Password was echoed to the controlling TTY")
    if "SECRET_SHA256=" + EXPECTED_HASH not in output:
        raise AssertionError("Password value was not passed intact")
    if os.waitstatus_to_exitcode(status) != 0:
        raise AssertionError("Hidden password subprocess failed")
    print("PASS: password prompt visible; pasted password hidden and received intact")
finally:
    os.close(fd)
