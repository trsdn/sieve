#!/usr/bin/env python3
"""Point context-mode's built-in update check at your own npm registry/proxy instead of registry.npmjs.org.

usage: patch_context_mode_registry.py REGISTRY_BASE_URL PLUGIN_DIR...
The proxy must serve the package page at REGISTRY_BASE_URL/context-mode (dist-tags.latest is read from it).
Originals are kept as *.orig. A plugin update restores the unpatched files.
"""
import re, shutil, sys
URL_OLD = "https://registry.npmjs.org/context-mode/latest"
URL_NEW = None  # set from argv[1]
URL_NEW = sys.argv[1].rstrip("/") + "/context-mode"
for root in sys.argv[2:]:
    for f in ("server.bundle.mjs", "cli.bundle.mjs"):
        p = f"{root}/{f}"
        s = open(p, errors="ignore").read()
        if URL_OLD not in s:
            print(p, "already patched or no match"); continue
        shutil.copy(p, p + ".orig")
        out, pos, n = [], 0, 0
        for m in re.finditer(re.escape(URL_OLD), s):
            out.append(s[pos:m.start()]); out.append(URL_NEW)
            tail_end = m.end() + 400
            seg = s[m.end():tail_end]
            seg2 = seg.replace('t(o.version??"unknown")', 't(o["dist-tags"]?.latest??"unknown")', 1)
            out.append(seg2); pos = tail_end; n += seg != seg2
        out.append(s[pos:])
        open(p, "w").write("".join(out))
        print(p, "patched", len(list(re.finditer(re.escape(URL_OLD), s))), "url(s),", n, "parser(s)")
