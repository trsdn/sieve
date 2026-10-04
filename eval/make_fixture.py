#!/usr/bin/env python3
"""Builds a project whose natural exploration produces large tool output. Prints the expected answers."""
import json, os, random, shutil, subprocess, sys

root = sys.argv[1]
random.seed(11)
shutil.rmtree(root, ignore_errors=True)
os.makedirs(f"{root}/logs"); os.makedirs(f"{root}/data"); os.makedirs(f"{root}/src"); os.makedirs(f"{root}/deps")

# logs: 40k lines, three error kinds with known counts
errs = ["ERROR db timeout on shard 3"] * 37 + ["ERROR cache miss storm"] * 12 + ["ERROR auth token expired"] * 5
slots = set(random.sample(range(40000), len(errs)))
it = iter(errs)
with open(f"{root}/logs/app.log", "w") as f:
    for i in range(40000):
        f.write(next(it) + f" ({i})\n" if i in slots else f"2026-10-04T10:{i//3600%60:02d}:{i%60:02d}Z INFO request handled path=/api/v1/items/{i} status=200 ms={i%40}\n")

# data: 5000 records, one target
recs = [{"id": 1000 + i, "name": f"item-{random.randint(0, 9999)}-{i}", "tags": ["a", "b", "c"], "price": round(random.random() * 100, 2)} for i in range(5000)]
recs[3734]["name"] = "zeta-4421"
json.dump(recs, open(f"{root}/data/records.json", "w"), indent=1)
target_id = recs[3734]["id"]

# src: 60 modules, one clearly longest function
for m in range(60):
    body = ""
    for fn in range(6):
        n = random.randint(5, 25)
        body += f"def fn_{m}_{fn}(x):\n" + "".join(f"    x = x + {j}\n" for j in range(n)) + "    return x\n\n"
    if m == 37:
        body += "def rebuild_index(x):\n" + "".join(f"    x = x * {j % 7 + 1}\n" for j in range(120)) + "    return x\n"
    open(f"{root}/src/mod_{m}.py", "w").write(body)

# deps: a deep tree, known count of .py files
py = 0
for p in range(120):
    for q in range(6):
        d = f"{root}/deps/pkg_{p}/sub_{q}/lib"
        os.makedirs(d)
        for k in range(random.randint(3, 9)):
            ext = random.choice([".py", ".pyc", ".txt", ".so", ".md"])
            open(f"{d}/file_{k}{ext}", "w").write("x")
            py += ext == ".py"

# tests: long passing output, one failure
open(f"{root}/run_tests.sh", "w").write("#!/bin/sh\n" + "".join(f"echo 'PASS tests/test_module_{i}.py::test_case_{i} ({i%9+1}.{i%10}s)'\n" for i in range(700))
    + "echo 'FAIL tests/test_billing.py::test_refund_rounding'\n"
    + "echo 'AssertionError: expected 10.05 got 10.04'\n"
    + "".join(f"echo 'PASS tests/test_late_{i}.py::test_tail_{i}'\n" for i in range(150)) + "exit 1\n")

# git: 150 commits, known top author
subprocess.run("git init -q", shell=True, cwd=root)
authors = ["Mira Okafor"] * 61 + ["Jan Weber"] * 44 + ["Lee Chen"] * 30 + ["Ana Souza"] * 15
random.shuffle(authors)
for i, a in enumerate(authors):
    open(f"{root}/CHANGELOG", "a").write(f"change {i}\n")
    subprocess.run(["git", "add", "CHANGELOG"], cwd=root)
    subprocess.run(["git", "-c", f"user.name={a}", "-c", f"user.email=x@example.com", "commit", "-q", "-m", f"update number {i}: tweak component {i%17}"], cwd=root)

print(json.dumps({"target_id": target_id, "py_files": py}))
