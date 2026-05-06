#!/usr/bin/env python3
import argparse
import json
import math
import os
import sqlite3
from collections import defaultdict
from datetime import datetime


def sigmoid(value):
    if value >= 0:
        z = math.exp(-value)
        return 1 / (1 + z)
    z = math.exp(value)
    return z / (1 + z)


def implied_prob(over_odds, under_odds):
    if not over_odds or not under_odds or over_odds <= 1 or under_odds <= 1:
        return None
    over_raw = 1 / over_odds
    under_raw = 1 / under_odds
    total = over_raw + under_raw
    if total <= 0:
        return None
    return over_raw / total


def season_from_date(match_date):
    year = int(match_date[:4])
    month = int(match_date[5:7])
    return f"{year}/{str((year + 1) % 100).zfill(2)}" if month >= 7 else f"{year - 1}/{str(year % 100).zfill(2)}"


def load_rows(db_path, league):
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        """
        SELECT
          m.match_date,
          m.home_team,
          m.away_team,
          m.home_goals,
          m.away_goals,
          m.total_goals,
          f.ou_close_line,
          f.over_open_odds,
          f.under_open_odds,
          f.over_close_odds,
          f.under_close_odds,
          f.over_odds_move,
          f.under_odds_move,
          l.over_result_unit,
          l.under_result_unit,
          l.over_profit,
          l.under_profit,
          l.label
        FROM football_matches m
        JOIN football_over_under_features f ON f.match_id = m.id
        JOIN football_over_under_labels l ON l.match_id = m.id
        WHERE m.league = ?
          AND f.over_close_odds IS NOT NULL
          AND f.under_close_odds IS NOT NULL
          AND l.label IN ('over', 'under')
        ORDER BY m.match_date, m.id
        """,
        [league],
    ).fetchall()
    conn.close()
    return [dict(row) for row in rows]


def build_league_history(rows):
    history = {}
    rolling = []
    for row in rows:
        current_avg = sum(rolling[-380:]) / len(rolling[-380:]) if rolling else 2.7
        history[(row["match_date"], row["home_team"], row["away_team"])] = current_avg
        rolling.append(row["total_goals"])
    return history


def make_features(rows):
    history = build_league_history(rows)
    samples = []

    for row in rows:
        imp = implied_prob(row["over_close_odds"], row["under_close_odds"])
        if imp is None:
            continue

        month = int(row["match_date"][5:7])
        league_avg_before = history[(row["match_date"], row["home_team"], row["away_team"])]
        over_odds_move = row["over_odds_move"] if row["over_odds_move"] is not None else 0
        under_odds_move = row["under_odds_move"] if row["under_odds_move"] is not None else 0

        features = [
            1.0,
            row["ou_close_line"],
            row["over_close_odds"],
            row["under_close_odds"],
            imp,
            over_odds_move,
            under_odds_move,
            league_avg_before,
            math.sin(2 * math.pi * month / 12),
            math.cos(2 * math.pi * month / 12),
        ]

        samples.append(
            {
                "date": row["match_date"],
                "season": season_from_date(row["match_date"]),
                "features": features,
                "label": 1 if row["label"] == "over" else 0,
                "over_profit": row["over_profit"],
                "under_profit": row["under_profit"],
                "over_odds": row["over_close_odds"],
                "under_odds": row["under_close_odds"],
                "market_prob": imp,
            }
        )

    return samples


def standardize(train, test):
    cols = len(train[0]["features"])
    means = [0.0] * cols
    stds = [1.0] * cols

    for col in range(1, cols):
        values = [sample["features"][col] for sample in train]
        mean = sum(values) / len(values)
        variance = sum((value - mean) ** 2 for value in values) / max(len(values) - 1, 1)
        std = math.sqrt(variance) or 1.0
        means[col] = mean
        stds[col] = std

    for sample in train + test:
        sample["x"] = [
            sample["features"][0],
            *[(sample["features"][col] - means[col]) / stds[col] for col in range(1, cols)],
        ]

    return means, stds


def train_logistic(train, epochs=1200, lr=0.035, l2=0.001):
    weights = [0.0] * len(train[0]["x"])
    n = len(train)

    for _ in range(epochs):
        grads = [0.0] * len(weights)
        for sample in train:
            pred = sigmoid(sum(w * x for w, x in zip(weights, sample["x"])))
            err = pred - sample["label"]
            for index, value in enumerate(sample["x"]):
                grads[index] += err * value

        for index in range(len(weights)):
            reg = 0 if index == 0 else l2 * weights[index]
            weights[index] -= lr * ((grads[index] / n) + reg)

    return weights


def evaluate(samples, weights, edge_threshold):
    eps = 1e-12
    correct = 0
    logloss = 0.0
    brier = 0.0
    over_bets = []
    under_bets = []

    for sample in samples:
        pred = sigmoid(sum(w * x for w, x in zip(weights, sample["x"])))
        sample["pred"] = pred
        label = sample["label"]
        correct += int((pred >= 0.5) == bool(label))
        logloss += -(label * math.log(max(pred, eps)) + (1 - label) * math.log(max(1 - pred, eps)))
        brier += (pred - label) ** 2

        market_prob = sample["market_prob"]
        over_edge = pred - market_prob
        under_edge = (1 - pred) - (1 - market_prob)

        if over_edge >= edge_threshold:
            over_bets.append(sample["over_profit"])
        if under_edge >= edge_threshold:
            under_bets.append(sample["under_profit"])

    def roi(values):
        if not values:
            return None
        return sum(values) / len(values)

    return {
        "sample_count": len(samples),
        "accuracy": correct / len(samples),
        "logloss": logloss / len(samples),
        "brier": brier / len(samples),
        "over_bets": len(over_bets),
        "under_bets": len(under_bets),
        "over_roi": roi(over_bets),
        "under_roi": roi(under_bets),
        "combined_bets": len(over_bets) + len(under_bets),
        "combined_roi": roi(over_bets + under_bets),
    }


def baseline(samples):
    market_correct = sum(int((sample["market_prob"] >= 0.5) == bool(sample["label"])) for sample in samples)
    over_profits = [sample["over_profit"] for sample in samples]
    under_profits = [sample["under_profit"] for sample in samples]
    return {
        "market_accuracy": market_correct / len(samples),
        "always_over_roi": sum(over_profits) / len(over_profits),
        "always_under_roi": sum(under_profits) / len(under_profits),
    }


def group_by_season(samples):
    buckets = defaultdict(list)
    for sample in samples:
        buckets[sample["season"]].append(sample)
    result = []
    for season, rows in sorted(buckets.items()):
        over_rate = sum(row["label"] for row in rows) / len(rows)
        avg_pred = sum(row["pred"] for row in rows) / len(rows)
        result.append({"season": season, "sample_count": len(rows), "over_rate": over_rate, "avg_pred": avg_pred})
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=os.path.join(os.getcwd(), "db", "price_dashboard_dev.db"))
    parser.add_argument("--league", default="E0")
    parser.add_argument("--test-seasons", type=int, default=4)
    parser.add_argument("--edge", type=float, default=0.03)
    args = parser.parse_args()

    rows = load_rows(args.db, args.league)
    samples = make_features(rows)
    seasons = sorted(set(sample["season"] for sample in samples))
    test_seasons = set(seasons[-args.test_seasons :])
    train = [sample for sample in samples if sample["season"] not in test_seasons]
    test = [sample for sample in samples if sample["season"] in test_seasons]

    if len(train) < 100 or len(test) < 50:
        raise SystemExit("Not enough samples to train/test")

    standardize(train, test)
    weights = train_logistic(train)
    train_eval = evaluate(train, weights, args.edge)
    test_eval = evaluate(test, weights, args.edge)

    output = {
        "league": args.league,
        "total_samples": len(samples),
        "train_samples": len(train),
        "test_samples": len(test),
        "train_seasons": [season for season in seasons if season not in test_seasons],
        "test_seasons": sorted(test_seasons),
        "edge_threshold": args.edge,
        "features": [
            "bias",
            "ou_close_line",
            "over_close_odds",
            "under_close_odds",
            "market_implied_over_probability",
            "over_odds_move",
            "under_odds_move",
            "rolling_league_avg_goals",
            "month_sin",
            "month_cos",
        ],
        "baseline_test": baseline(test),
        "train_eval": train_eval,
        "test_eval": test_eval,
        "test_by_season": group_by_season(test),
        "weights": weights,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
