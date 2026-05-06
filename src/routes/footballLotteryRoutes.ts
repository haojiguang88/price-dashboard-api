import express from "express";
import getDb from "../config/database";

const router = express.Router();

type CsvRow = Record<string, string>;

const nowIso = () => new Date().toISOString();

const parseNumber = (value: any): number | null => {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).trim().replace("%", "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const pick = (row: CsvRow, keys: string[]): string => {
  for (const key of keys) {
    const value = row[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return String(value).trim();
    }
  }
  return "";
};

const parseCsv = (text: string): CsvRow[] => {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"' && quoted && next === '"') {
      field += '"';
      i++;
      continue;
    }

    if (char === '"') {
      quoted = !quoted;
      continue;
    }

    if (char === "," && !quoted) {
      row.push(field);
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((cell) => cell.trim() !== "")) rows.push(row);
      row = [];
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((cell) => cell.trim() !== "")) rows.push(row);

  const headers = rows.shift()?.map((header) => header.trim()) || [];
  return rows.map((cells) =>
    headers.reduce<CsvRow>((acc, header, index) => {
      acc[header] = cells[index]?.trim() || "";
      return acc;
    }, {})
  );
};

const normalizeDate = (raw: string) => {
  const value = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;

  const slashMatch = value.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (slashMatch) {
    const day = slashMatch[1].padStart(2, "0");
    const month = slashMatch[2].padStart(2, "0");
    const rawYear = slashMatch[3];
    const year = rawYear.length === 2
      ? `${Number(rawYear) >= 70 ? "19" : "20"}${rawYear}`
      : rawYear;
    return `${year}-${month}-${day}`;
  }

  return value;
};

const splitAsianLine = (line: number) => {
  const base = Math.floor(line);
  const fraction = Number((line - base).toFixed(2));

  if (fraction === 0.25) return [base, base + 0.5];
  if (fraction === 0.75) return [base + 0.5, base + 1];
  return [line];
};

const settleOverUnit = (totalGoals: number, line: number) => {
  const legs = splitAsianLine(line);
  return legs.reduce((sum, leg) => {
    if (totalGoals > leg) return sum + 1 / legs.length;
    if (totalGoals === leg) return sum;
    return sum - 1 / legs.length;
  }, 0);
};

const profitFromUnit = (unit: number, odds: number | null) => {
  if (!odds || !Number.isFinite(odds)) return null;
  if (unit > 0) return unit * (odds - 1);
  if (unit < 0) return unit;
  return 0;
};

const ensureFootballTables = async (db: any) => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS football_import_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_name TEXT NOT NULL,
      source_file TEXT,
      row_count INTEGER NOT NULL DEFAULT 0,
      imported_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      duplicated_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS football_matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      import_batch_id INTEGER,
      source_name TEXT NOT NULL,
      source_match_key TEXT NOT NULL UNIQUE,
      country TEXT,
      league TEXT NOT NULL,
      season TEXT,
      kickoff_at TEXT,
      match_date TEXT NOT NULL,
      home_team TEXT NOT NULL,
      away_team TEXT NOT NULL,
      home_goals INTEGER,
      away_goals INTEGER,
      total_goals INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (import_batch_id) REFERENCES football_import_batches(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS football_odds_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL,
      bookmaker TEXT,
      market_type TEXT NOT NULL DEFAULT 'over_under',
      snapshot_type TEXT NOT NULL DEFAULT 'close',
      captured_at TEXT,
      ou_line REAL NOT NULL,
      over_odds REAL,
      under_odds REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (match_id) REFERENCES football_matches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS football_over_under_features (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL UNIQUE,
      ou_open_line REAL,
      ou_close_line REAL NOT NULL,
      over_open_odds REAL,
      under_open_odds REAL,
      over_close_odds REAL,
      under_close_odds REAL,
      line_move REAL,
      over_odds_move REAL,
      under_odds_move REAL,
      league_avg_goals REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (match_id) REFERENCES football_matches(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS football_over_under_labels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id INTEGER NOT NULL UNIQUE,
      total_goals INTEGER NOT NULL,
      ou_line REAL NOT NULL,
      over_result_unit REAL NOT NULL,
      under_result_unit REAL NOT NULL,
      over_profit REAL,
      under_profit REAL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (match_id) REFERENCES football_matches(id) ON DELETE CASCADE
    );
  `);

  const batchColumns = await db.all(`PRAGMA table_info(football_import_batches)`);
  const hasDuplicatedCount = batchColumns.some((column: any) => column.name === "duplicated_count");
  if (!hasDuplicatedCount) {
    await db.exec(`ALTER TABLE football_import_batches ADD COLUMN duplicated_count INTEGER NOT NULL DEFAULT 0`);
  }
};

router.use(async (_req, _res, next) => {
  try {
    const db = await getDb();
    await ensureFootballTables(db);
    next();
  } catch (error) {
    next(error);
  }
});

router.get("/overview", async (_req, res) => {
  try {
    const db = await getDb();
    const overview = await db.get(`
      SELECT
        COUNT(*) as total_matches,
        COALESCE(SUM(CASE WHEN l.id IS NOT NULL THEN 1 ELSE 0 END), 0) as labeled_matches,
        COUNT(DISTINCT m.league) as league_count,
        COUNT(DISTINCT f.ou_close_line) as line_count
      FROM football_matches m
      LEFT JOIN football_over_under_features f ON f.match_id = m.id
      LEFT JOIN football_over_under_labels l ON l.match_id = m.id
    `);
    const latestImport = await db.get(`SELECT * FROM football_import_batches ORDER BY id DESC LIMIT 1`);
    res.json({ success: true, data: { ...overview, latest_import: latestImport || null } });
  } catch (error) {
    res.status(500).json({ success: false, message: "获取足彩概览失败" });
  }
});

router.get("/matches", async (req, res) => {
  try {
    const db = await getDb();
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const league = req.query.league ? String(req.query.league) : "";
    const line = parseNumber(req.query.line);
    const params: any[] = [];
    const conditions: string[] = [];

    if (league) {
      conditions.push("m.league = ?");
      params.push(league);
    }

    if (line !== null) {
      conditions.push("f.ou_close_line = ?");
      params.push(line);
    }

    params.push(limit);

    const items = await db.all(
      `
      SELECT
        m.*,
        f.ou_open_line,
        f.ou_close_line,
        f.over_open_odds,
        f.under_open_odds,
        f.over_close_odds,
        f.under_close_odds,
        f.line_move,
        l.over_result_unit,
        l.under_result_unit,
        l.over_profit,
        l.under_profit,
        l.label
      FROM football_matches m
      LEFT JOIN football_over_under_features f ON f.match_id = m.id
      LEFT JOIN football_over_under_labels l ON l.match_id = m.id
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      ORDER BY m.match_date DESC, m.id DESC
      LIMIT ?
      `,
      params
    );

    res.json({ success: true, data: { items } });
  } catch (error) {
    res.status(500).json({ success: false, message: "获取足彩赛事失败" });
  }
});

router.post("/imports/csv", async (req, res) => {
  try {
    const { csv_text, source_name = "manual_csv", source_file = "" } = req.body || {};
    if (!csv_text || typeof csv_text !== "string") {
      return res.status(400).json({ success: false, message: "csv_text 不能为空" });
    }

    const rows = parseCsv(csv_text);
    const db = await getDb();
    const batch = await db.run(
      `INSERT INTO football_import_batches (source_name, source_file, row_count, created_at) VALUES (?, ?, ?, ?)`,
      [source_name, source_file, rows.length, nowIso()]
    );

    let imported = 0;
    let skipped = 0;
    let duplicated = 0;

    for (const row of rows) {
      const league = pick(row, ["league", "League", "Div"]);
      const season = pick(row, ["season", "Season"]);
      const matchDate = normalizeDate(pick(row, ["match_date", "Date", "date"]));
      const homeTeam = pick(row, ["home_team", "HomeTeam", "Home"]);
      const awayTeam = pick(row, ["away_team", "AwayTeam", "Away"]);
      const homeGoals = parseNumber(pick(row, ["home_goals", "FTHG", "HG"]));
      const awayGoals = parseNumber(pick(row, ["away_goals", "FTAG", "AG"]));
      const closeLine = parseNumber(pick(row, ["ou_close_line", "close_line", "OUCloseLine", "TotalLine"])) ?? 2.5;
      const openLine = parseNumber(pick(row, ["ou_open_line", "open_line", "OUOpenLine"])) ?? closeLine;
      const overOpenOdds = parseNumber(pick(row, ["over_open_odds", "B365>2.5", "Avg>2.5", "BbAv>2.5", "OverOpenOdds"]));
      const underOpenOdds = parseNumber(pick(row, ["under_open_odds", "B365<2.5", "Avg<2.5", "BbAv<2.5", "UnderOpenOdds"]));
      const overCloseOdds = parseNumber(pick(row, ["over_close_odds", "B365C>2.5", "AvgC>2.5", "BbAvC>2.5", "B365>2.5", "Avg>2.5", "OverCloseOdds"])) ?? overOpenOdds;
      const underCloseOdds = parseNumber(pick(row, ["under_close_odds", "B365C<2.5", "AvgC<2.5", "BbAvC<2.5", "B365<2.5", "Avg<2.5", "UnderCloseOdds"])) ?? underOpenOdds;

      if (!league || !matchDate || !homeTeam || !awayTeam || homeGoals === null || awayGoals === null || closeLine === null) {
        skipped++;
        continue;
      }

      const totalGoals = homeGoals + awayGoals;
      const matchKey = `${source_name}|${league}|${season}|${matchDate}|${homeTeam}|${awayTeam}`;
      const timestamp = nowIso();
      const overUnit = settleOverUnit(totalGoals, closeLine);
      const underUnit = -overUnit;
      const label = overUnit > 0 ? "over" : overUnit < 0 ? "under" : "push";
      const existingMatch = await db.get(`SELECT id FROM football_matches WHERE source_match_key = ?`, [matchKey]);

      if (existingMatch) {
        duplicated++;
        continue;
      }

      await db.run(
        `
        INSERT INTO football_matches (
          import_batch_id, source_name, source_match_key, league, season, match_date,
          home_team, away_team, home_goals, away_goals, total_goals, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [batch.lastID, source_name, matchKey, league, season, matchDate, homeTeam, awayTeam, homeGoals, awayGoals, totalGoals, timestamp, timestamp]
      );

      const match = await db.get(`SELECT id FROM football_matches WHERE source_match_key = ?`, [matchKey]);

      await db.run(`DELETE FROM football_odds_snapshots WHERE match_id = ?`, [match.id]);
      await db.run(
        `
        INSERT INTO football_odds_snapshots (match_id, bookmaker, snapshot_type, ou_line, over_odds, under_odds, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)
        `,
        [
          match.id, "csv", "open", openLine, overOpenOdds, underOpenOdds, timestamp,
          match.id, "csv", "close", closeLine, overCloseOdds, underCloseOdds, timestamp
        ]
      );

      await db.run(
        `
        INSERT INTO football_over_under_features (
          match_id, ou_open_line, ou_close_line, over_open_odds, under_open_odds,
          over_close_odds, under_close_odds, line_move, over_odds_move, under_odds_move,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(match_id) DO UPDATE SET
          ou_open_line = excluded.ou_open_line,
          ou_close_line = excluded.ou_close_line,
          over_open_odds = excluded.over_open_odds,
          under_open_odds = excluded.under_open_odds,
          over_close_odds = excluded.over_close_odds,
          under_close_odds = excluded.under_close_odds,
          line_move = excluded.line_move,
          over_odds_move = excluded.over_odds_move,
          under_odds_move = excluded.under_odds_move,
          updated_at = excluded.updated_at
        `,
        [
          match.id,
          openLine,
          closeLine,
          overOpenOdds,
          underOpenOdds,
          overCloseOdds,
          underCloseOdds,
          closeLine - openLine,
          overCloseOdds !== null && overOpenOdds !== null ? overCloseOdds - overOpenOdds : null,
          underCloseOdds !== null && underOpenOdds !== null ? underCloseOdds - underOpenOdds : null,
          timestamp,
          timestamp
        ]
      );

      await db.run(
        `
        INSERT INTO football_over_under_labels (
          match_id, total_goals, ou_line, over_result_unit, under_result_unit,
          over_profit, under_profit, label, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(match_id) DO UPDATE SET
          total_goals = excluded.total_goals,
          ou_line = excluded.ou_line,
          over_result_unit = excluded.over_result_unit,
          under_result_unit = excluded.under_result_unit,
          over_profit = excluded.over_profit,
          under_profit = excluded.under_profit,
          label = excluded.label,
          updated_at = excluded.updated_at
        `,
        [
          match.id,
          totalGoals,
          closeLine,
          overUnit,
          underUnit,
          profitFromUnit(overUnit, overCloseOdds),
          profitFromUnit(underUnit, underCloseOdds),
          label,
          timestamp,
          timestamp
        ]
      );

      imported++;
    }

    await db.run(
      `UPDATE football_import_batches SET imported_count = ?, skipped_count = ?, duplicated_count = ? WHERE id = ?`,
      [imported, skipped, duplicated, batch.lastID]
    );

    res.json({ success: true, data: { batch_id: batch.lastID, row_count: rows.length, imported, skipped, duplicated } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: "导入足彩 CSV 失败", error: message });
  }
});

router.get("/league-stats", async (_req, res) => {
  try {
    const db = await getDb();
    const items = await db.all(`
      SELECT
        m.league,
        f.ou_close_line,
        COUNT(*) as sample_count,
        ROUND(AVG(m.total_goals), 3) as avg_goals,
        ROUND(AVG(CASE WHEN l.over_result_unit > 0 THEN 1.0 ELSE 0 END), 4) as over_win_rate,
        ROUND(AVG(CASE WHEN l.under_result_unit > 0 THEN 1.0 ELSE 0 END), 4) as under_win_rate,
        ROUND(AVG(COALESCE(l.over_profit, 0)), 4) as over_roi,
        ROUND(AVG(COALESCE(l.under_profit, 0)), 4) as under_roi
      FROM football_matches m
      JOIN football_over_under_features f ON f.match_id = m.id
      JOIN football_over_under_labels l ON l.match_id = m.id
      GROUP BY m.league, f.ou_close_line
      ORDER BY m.league, f.ou_close_line
    `);
    res.json({ success: true, data: { items } });
  } catch (error) {
    res.status(500).json({ success: false, message: "获取联赛大小球统计失败" });
  }
});

router.get("/line-stats", async (_req, res) => {
  try {
    const db = await getDb();
    const items = await db.all(`
      SELECT
        f.ou_close_line,
        COUNT(*) as sample_count,
        ROUND(AVG(m.total_goals), 3) as avg_goals,
        ROUND(AVG(CASE WHEN l.over_result_unit > 0 THEN 1.0 ELSE 0 END), 4) as over_win_rate,
        ROUND(AVG(CASE WHEN l.under_result_unit > 0 THEN 1.0 ELSE 0 END), 4) as under_win_rate,
        ROUND(AVG(COALESCE(l.over_profit, 0)), 4) as over_roi,
        ROUND(AVG(COALESCE(l.under_profit, 0)), 4) as under_roi
      FROM football_matches m
      JOIN football_over_under_features f ON f.match_id = m.id
      JOIN football_over_under_labels l ON l.match_id = m.id
      GROUP BY f.ou_close_line
      ORDER BY f.ou_close_line
    `);
    res.json({ success: true, data: { items } });
  } catch (error) {
    res.status(500).json({ success: false, message: "获取盘口线统计失败" });
  }
});

router.get("/movement-stats", async (_req, res) => {
  try {
    const db = await getDb();
    const items = await db.all(`
      SELECT
        CASE
          WHEN f.line_move > 0 THEN '升盘'
          WHEN f.line_move < 0 THEN '降盘'
          ELSE '不动盘'
        END as movement_type,
        f.ou_open_line,
        f.ou_close_line,
        COUNT(*) as sample_count,
        ROUND(AVG(CASE WHEN l.over_result_unit > 0 THEN 1.0 ELSE 0 END), 4) as over_win_rate,
        ROUND(AVG(CASE WHEN l.under_result_unit > 0 THEN 1.0 ELSE 0 END), 4) as under_win_rate,
        ROUND(AVG(COALESCE(l.over_profit, 0)), 4) as over_roi,
        ROUND(AVG(COALESCE(l.under_profit, 0)), 4) as under_roi
      FROM football_over_under_features f
      JOIN football_over_under_labels l ON l.match_id = f.match_id
      GROUP BY movement_type, f.ou_open_line, f.ou_close_line
      ORDER BY movement_type, f.ou_open_line, f.ou_close_line
    `);
    res.json({ success: true, data: { items } });
  } catch (error) {
    res.status(500).json({ success: false, message: "获取盘路变化统计失败" });
  }
});

router.get("/backtests/over-under", async (req, res) => {
  try {
    const db = await getDb();
    const league = req.query.league ? String(req.query.league) : "";
    const groupBy = req.query.group_by ? String(req.query.group_by) : "season";
    const allowedGroups = new Set(["season", "month", "over_odds_bucket"]);
    const selectedGroup = allowedGroups.has(groupBy) ? groupBy : "season";
    const conditions: string[] = [];
    const params: any[] = [];

    if (league) {
      conditions.push("m.league = ?");
      params.push(league);
    }

    const groupExpression = (() => {
      if (selectedGroup === "month") {
        return `substr(m.match_date, 6, 2)`;
      }

      if (selectedGroup === "over_odds_bucket") {
        return `
          CASE
            WHEN f.over_close_odds IS NULL THEN '无赔率'
            WHEN f.over_close_odds < 1.60 THEN '<1.60'
            WHEN f.over_close_odds < 1.75 THEN '1.60-1.74'
            WHEN f.over_close_odds < 1.90 THEN '1.75-1.89'
            WHEN f.over_close_odds < 2.10 THEN '1.90-2.09'
            ELSE '>=2.10'
          END
        `;
      }

      return `
        CASE WHEN CAST(substr(m.match_date, 6, 2) AS INTEGER) >= 7
          THEN substr(m.match_date, 1, 4) || '/' || printf('%02d', (CAST(substr(m.match_date, 1, 4) AS INTEGER) + 1) % 100)
          ELSE printf('%04d', CAST(substr(m.match_date, 1, 4) AS INTEGER) - 1) || '/' || substr(m.match_date, 3, 2)
        END
      `;
    })();

    const items = await db.all(
      `
      SELECT
        ${groupExpression} as bucket,
        COUNT(*) as sample_count,
        SUM(CASE WHEN f.over_close_odds IS NOT NULL AND f.under_close_odds IS NOT NULL THEN 1 ELSE 0 END) as odds_sample_count,
        ROUND(AVG(m.total_goals), 3) as avg_goals,
        ROUND(AVG(CASE WHEN l.over_result_unit > 0 THEN 1.0 ELSE 0 END), 4) as over_win_rate,
        ROUND(AVG(CASE WHEN l.under_result_unit > 0 THEN 1.0 ELSE 0 END), 4) as under_win_rate,
        ROUND(AVG(CASE WHEN f.over_close_odds IS NOT NULL THEN l.over_profit END), 4) as over_roi,
        ROUND(AVG(CASE WHEN f.under_close_odds IS NOT NULL THEN l.under_profit END), 4) as under_roi
      FROM football_matches m
      JOIN football_over_under_features f ON f.match_id = m.id
      JOIN football_over_under_labels l ON l.match_id = m.id
      ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
      GROUP BY bucket
      ORDER BY bucket
      `,
      params
    );

    res.json({ success: true, data: { group_by: selectedGroup, league: league || null, items } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    res.status(500).json({ success: false, message: "大小球回测失败", error: message });
  }
});

router.get("/training-dataset", async (req, res) => {
  try {
    const db = await getDb();
    const limit = Math.min(Number(req.query.limit) || 1000, 5000);
    const items = await db.all(
      `
      SELECT
        m.id as match_id,
        m.league,
        m.season,
        m.match_date,
        m.home_team,
        m.away_team,
        m.home_goals,
        m.away_goals,
        m.total_goals,
        f.ou_open_line,
        f.ou_close_line,
        f.over_open_odds,
        f.under_open_odds,
        f.over_close_odds,
        f.under_close_odds,
        f.line_move,
        f.over_odds_move,
        f.under_odds_move,
        l.over_result_unit,
        l.under_result_unit,
        l.label
      FROM football_matches m
      JOIN football_over_under_features f ON f.match_id = m.id
      JOIN football_over_under_labels l ON l.match_id = m.id
      ORDER BY m.match_date DESC, m.id DESC
      LIMIT ?
      `,
      [limit]
    );
    res.json({ success: true, data: { dataset_version: "football_ou_v1", items } });
  } catch (error) {
    res.status(500).json({ success: false, message: "获取训练数据集失败" });
  }
});

export default router;
