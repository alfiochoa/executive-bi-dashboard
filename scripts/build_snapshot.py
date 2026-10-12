"""Build data/snapshot.json from the synthetic Northstar Goods CSVs.

Usage: python scripts/build_snapshot.py <dir with the CSVs> [out.json]
Input is read-only. Everything is synthetic; no secrets are involved.
"""
import json
import sys
from pathlib import Path

import pandas as pd

src = Path(sys.argv[1])
out = Path(sys.argv[2] if len(sys.argv) > 2 else "data/snapshot.json")

orders = pd.read_csv(src / "orders.csv", parse_dates=["order_date"])
items = pd.read_csv(src / "order_items.csv")
products = pd.read_csv(src / "products.csv")
customers = pd.read_csv(src / "customers.csv")
tx = pd.read_csv(src / "transactions.csv", parse_dates=["transaction_date"])
events = pd.read_csv(src / "operational_events.csv", parse_dates=["event_date"])

RECOGNIZED = ["paid", "shipped", "completed"]  # same definition as the assistant's tools
cats = sorted(products["category"].unique())
cat_idx = {c: i for i, c in enumerate(cats)}
segs = ["new", "returning", "high_value"]
seg_idx = {s: i for i, s in enumerate(segs)}

items = items.merge(products[["product_id", "category", "name", "sku"]], on="product_id")
items["line"] = items["quantity"] * items["unit_price"]

# One category per order: the category with the largest line value (keeps every metric additive).
primary = (
    items.groupby(["order_id", "category"])["line"].sum().reset_index()
    .sort_values(["order_id", "line"], ascending=[True, False]).drop_duplicates("order_id")
    .set_index("order_id")["category"]
)
order_value = items.groupby("order_id")["line"].sum()

orders["day"] = orders["order_date"].dt.strftime("%Y-%m-%d")
orders["cat"] = orders["order_id"].map(primary).map(cat_idx)
orders = orders.merge(customers[["customer_id", "segment"]], on="customer_id")
orders["seg"] = orders["segment"].map(seg_idx)
orders["value"] = orders["order_id"].map(order_value).fillna(0.0)
orders = orders.dropna(subset=["cat"]).astype({"cat": int})

tx = tx.merge(orders[["order_id", "cat", "seg"]], on="order_id")
tx["day"] = tx["transaction_date"].dt.strftime("%Y-%m-%d")
tx = tx[tx["day"] <= orders["day"].max()]  # same window as the assistant (to 2024-12-31)

days = sorted(set(orders["day"]) | set(tx["day"]))
day_idx = {d: i for i, d in enumerate(days)}

def aggregate(dim: str):
    """[day, key, orders, recOrders, revenueCents, tx, failed, declined, refunded, refundedCents]"""
    cells: dict[tuple, list] = {}
    for r in orders.itertuples():
        k = cells.setdefault((day_idx[r.day], int(getattr(r, dim))), [0] * 8)
        k[0] += 1
        if r.status in RECOGNIZED:
            k[1] += 1
            k[2] += round(r.value * 100)
        if r.status == "refunded":
            k[6] += 1
            k[7] += round(r.value * 100)
    for r in tx.itertuples():
        k = cells.setdefault((day_idx[r.day], int(getattr(r, dim))), [0] * 8)
        k[3] += 1
        if r.status == "failed":
            k[4] += 1
        elif r.status == "declined":
            k[5] += 1
    return [[*key, *vals] for key, vals in sorted(cells.items())]


rows = aggregate("cat")
seg_rows = aggregate("seg")

# Product x month (recognized revenue), for the top-products table.
rec = orders[orders["status"].isin(RECOGNIZED)][["order_id", "order_date"]]
pi = items.merge(rec, on="order_id")
pi["m"] = pi["order_date"].dt.strftime("%Y-%m")
months = sorted(pi["m"].unique())
m_idx = {m: i for i, m in enumerate(months)}
pm = pi.groupby(["m", "product_id"]).agg(u=("quantity", "sum"), v=("line", "sum")).reset_index()
prod_rows = [[m_idx[r.m], int(r.product_id), int(r.u), round(r.v * 100)] for r in pm.itertuples()]
prod_list = [[int(r.product_id), r.sku, r.name, cat_idx[r.category]] for r in products.itertuples()]

# Repeat-customer view + cohort retention (recognized orders only).
ro = orders[orders["status"].isin(RECOGNIZED)].copy()
ro["m"] = ro["order_date"].dt.strftime("%Y-%m")
first = ro.groupby("customer_id")["m"].min().rename("first_m")
ro = ro.join(first, on="customer_id")
ro["is_new"] = ro["m"] == ro["first_m"]
repeat = []
for m in months:
    g = ro[ro["m"] == m]
    repeat.append([int(g[g.is_new]["customer_id"].nunique()), int(g[~g.is_new]["customer_id"].nunique()),
                   int(g["is_new"].sum()), int((~g["is_new"]).sum())])  # new cust, repeat cust, new orders, repeat orders
active = ro.groupby(["first_m", "m"])["customer_id"].nunique().unstack(fill_value=0)
cohorts = []
for ci, cm in enumerate(months):
    size = int(active.loc[cm, cm]) if cm in active.index else 0
    ret = []
    for k in range(0, min(12, len(months) - ci)):
        mm = months[ci + k]
        ret.append(int(active.loc[cm, mm]) if cm in active.index and mm in active.columns else 0)
    cohorts.append([size, ret])

# Gateway outage annotation: critical/high payment_gateway_outage events per day.
ev = events[(events["event_type"] == "payment_gateway_outage") & events["severity"].isin(["critical", "high"])]
ev_days = ev.groupby(ev["event_date"].dt.strftime("%Y-%m-%d")).size()
outage = [[day_idx[d], int(n)] for d, n in ev_days.items() if d in day_idx]

snapshot = {
    "meta": {"generated_from": "Northstar Goods synthetic dataset (ai-business-data-assistant)",
             "synthetic": True, "first_day": days[0], "last_day": days[-1]},
    "days": days, "categories": cats, "segments": segs, "months": months,
    "cols": ["day", "key", "orders", "recOrders", "revenueCents", "tx", "failed", "declined", "refunded", "refundedCents"],
    "rows": rows, "segRows": seg_rows, "products": prod_list, "productMonths": prod_rows,
    "repeat": repeat, "cohorts": cohorts, "outage": outage,
}
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(snapshot, separators=(",", ":")))
print(f"{out}: {out.stat().st_size/1024:.0f} KB, rows={len(rows)}+{len(seg_rows)}, productMonths={len(prod_rows)}")
