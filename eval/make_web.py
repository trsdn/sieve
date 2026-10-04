#!/usr/bin/env python3
"""Two large pages for the browser test. Prints the expected answers as JSON."""
import json, os, random, sys
root = sys.argv[1]
os.makedirs(root, exist_ok=True)
random.seed(5)
names = [f"{a} {b}" for a in ["Mira", "Jan", "Lee", "Ana", "Kofi", "Sven", "Ines", "Omar", "Yuki", "Lena"] for b in ["Okafor", "Weber", "Chen", "Souza", "Mensah", "Berg", "Silva", "Haddad", "Sato", "Kraft"]]
rows, totals, over = [], {}, 0
for i in range(450):
    c = random.choice(names); q = random.randint(1, 6); p = round(random.uniform(5, 220), 2)
    totals[c] = round(totals.get(c, 0) + q * p, 2); over += q * p > 500
    rows.append(f"<tr><td>ORD-{10000 + i}</td><td>{c}</td><td>Product {random.randint(100, 999)}</td><td>{q}</td><td>{p:.2f}</td></tr>")
open(f"{root}/orders.html", "w").write("<html><head><title>Orders</title></head><body><h1>Order ledger</h1><table><thead><tr><th>Order</th><th>Customer</th><th>Item</th><th>Qty</th><th>Unit price</th></tr></thead><tbody>" + "".join(rows) + "</tbody></table></body></html>")
top = max(totals, key=totals.get)
entries, sec = [], 0
for i in range(140):
    v = f"2.{140 - i}.{random.randint(0, 9)}"; s = random.random() < 0.18; sec += s
    entries.append(f"<article><h2>Release {v}</h2><p>{'Security fix: patched a vulnerability in the session handler.' if s else 'Improved performance of the ' + random.choice(['parser', 'renderer', 'scheduler', 'exporter']) + '.'} Also updated {random.choice(['docs', 'tests', 'build scripts'])} and fixed {random.randint(1, 9)} minor issues across the {random.choice(['api', 'cli', 'ui'])}.</p></article>")
open(f"{root}/changelog.html", "w").write("<html><head><title>Changelog</title></head><body><h1>Changelog</h1>" + "".join(entries) + "</body></html>")
print(json.dumps({"top_customer": top, "top_total": totals[top], "orders_over_500": over, "security_entries": sec, "latest": "2.140"}))
