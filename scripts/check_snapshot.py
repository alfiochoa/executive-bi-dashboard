"""Sanity checks for data/snapshot.json (run in CI). Figures match the assistant project's README."""
import json
import sys

d = json.load(open("data/snapshot.json"))
assert d["meta"]["synthetic"] is True
days, rows = d["days"], d["rows"]
assert days[0] == "2023-01-01" and days[-1] == "2024-12-31", (days[0], days[-1])
apr = [r for r in rows if days[r[0]].startswith("2024-04")]
rev = sum(r[4] for r in apr) / 100
tx = sum(r[5] for r in apr)
failed = sum(r[6] + r[7] for r in apr)
assert abs(rev - 450473.13) < 0.01, rev          # April 2024 revenue quoted in project 1
assert (tx, failed) == (1708, 269), (tx, failed)  # 15.8% failure rate quoted in project 1
assert sum(r[4] for r in rows) == sum(r[4] for r in d["segRows"]), "category and segment totals must match"
print("snapshot OK:", len(rows), "rows,", round(rev, 2), "April 2024 revenue")
sys.exit(0)
