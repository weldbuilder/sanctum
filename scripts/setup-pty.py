#!/usr/bin/env python3
"""Drive an interactive CLI through a pseudo-terminal from a script of [prompt, answer] pairs.

usage: setup-pty.py job.json
job.json: { "cmd": [...], "cwd": "...", "env": {...}, "answers": [[expected prompt text, answer], ...], "out": "transcript path" }

Each answer is sent only when the output has been quiet for a moment AND ends with the text the script
expects at that point, so a script that has drifted from the program fails loudly instead of answering the
wrong question. Developer tool for the setup proof (not part of the test suite).
"""
import json, os, pty, re, select, sys, time

job = json.load(open(sys.argv[1]))
pid, fd = pty.fork()
if pid == 0:
    os.chdir(job["cwd"])
    os.execvpe(job["cmd"][0], job["cmd"], job["env"])

buf = b""
mark = 0
answers = list(job["answers"])
quiet_for = job.get("quiet", 0.2)
deadline = time.time() + job.get("timeout", 90)
last = time.time()
status = "ok"
ansi = re.compile(rb"\x1b\[[0-9;?]*[A-Za-z]")
while True:
    if time.time() > deadline:
        status = "timeout"
        break
    r, _, _ = select.select([fd], [], [], 0.05)
    if r:
        try:
            chunk = os.read(fd, 65536)
        except OSError:
            break
        if not chunk:
            break
        buf += chunk
        last = time.time()
        continue
    if answers and time.time() - last >= quiet_for and len(buf) > mark:
        want, ans = answers[0]
        tail = ansi.sub(b"", buf[mark:]).decode("utf-8", "replace").replace("\r", "")
        if want not in tail.split("\n")[-1]:
            status = "mismatch: wanted prompt containing %r but the last line is %r" % (want, tail.split("\n")[-1])
            break
        answers.pop(0)
        mark = len(buf)
        os.write(fd, (ans + "\r").encode())
        mark = len(buf)
        last = time.time()
if status != "ok":
    try:
        os.kill(pid, 9)
    except Exception:
        pass
try:
    _, code = os.waitpid(pid, 0)
except ChildProcessError:
    code = 0
open(job["out"], "wb").write(buf)
if answers and status == "ok":
    status = "unused answers: %r" % (answers[:2],)
print(json.dumps({"status": status, "exit": code}))
sys.exit(0 if status == "ok" else 1)
