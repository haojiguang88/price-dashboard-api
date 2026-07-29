import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("龙银币自动补价不写价差备注并保留手工备注", () => {
  const script = String.raw`
import json
import os
import sqlite3
import sys
import tempfile

sys.path.insert(0, os.path.join(os.getcwd(), "scripts", "business"))
import longyinbi

records = [
    {
        "price_date": "2026-07-27",
        "price": 690,
        "category": "纪念币",
        "object": "龙银币",
        "variant": "2026年信泰评级",
        "external_key": "test",
    },
    {
        "price_date": "2026-07-28",
        "price": 700,
        "category": "纪念币",
        "object": "龙银币",
        "variant": "2026年信泰评级",
        "external_key": "test",
    },
]
adjusted = longyinbi.apply_price_offset(
    records,
    {"price_offset": -70, "source_name": "测试源"},
)

handle, db_path = tempfile.mkstemp(suffix=".db")
os.close(handle)
try:
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE price_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          date TEXT NOT NULL,
          category TEXT NOT NULL,
          object_name TEXT NOT NULL,
          variant TEXT,
          price REAL NOT NULL,
          source TEXT,
          note TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
    """)
    conn.execute(
        "INSERT INTO price_records "
        "(date, category, object_name, variant, price, source, note, created_at, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            "2026-07-27",
            "纪念币",
            "龙银币",
            "2026年信泰评级",
            620,
            "旧源",
            "手工备注要保留",
            "now",
            "now",
        ),
    )
    conn.commit()
    conn.close()

    longyinbi.airmb.ensure_master_data = lambda conn, record: None
    longyinbi.upsert_price_records(db_path, [adjusted[0]])
    conn = sqlite3.connect(db_path)
    stored = conn.execute(
        "SELECT price, source, note FROM price_records"
    ).fetchone()
    conn.close()
finally:
    os.unlink(db_path)

print(json.dumps({
    "generated_notes": [item["note"] for item in adjusted],
    "stored": stored,
}, ensure_ascii=False))
`;

  const result = spawnSync("python3", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(output.generated_notes, ["", ""]);
  assert.deepEqual(output.stored, [620, "测试源", "手工备注要保留"]);
});
