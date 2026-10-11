import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseManager, initializeBusinessBaseSchema } from "../src/config/database";
import { runMigrations } from "../src/migrations";

test("seeds 宝可梦 30周年庆典统计 and 泡泡玛特 手办 复古可口可乐火箭摆件", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pokemon-coke-rocket-"));
  const filename = path.join(directory, "business.db");
  const manager = new DatabaseManager({
    filename,
    allowCreate: true,
    initialize: initializeBusinessBaseSchema
  });

  try {
    await manager.getDb();
    await runMigrations(filename);
    const db = await manager.getDb();

    const applied = await db.get(
      `SELECT id FROM migrations WHERE id = '20261011_001_seed_pokemon_30th_and_popmart_coke_rocket'`
    );
    assert.ok(applied);

    const pokemon = await db.get(
      `SELECT id FROM categories WHERE name = '宝可梦' AND COALESCE(is_archived, 0) = 0`
    );
    assert.ok(pokemon);

    const anniversary = await db.get(
      `SELECT o.id FROM objects o
       WHERE o.category_id = ? AND o.name = '30周年庆典统计' AND COALESCE(o.is_archived, 0) = 0`,
      [pokemon.id]
    );
    assert.ok(anniversary);

    const anniversaryVariant = await db.get(
      `SELECT id FROM variants
       WHERE object_id = ? AND name = '30周年庆典统计' AND COALESCE(is_archived, 0) = 0`,
      [anniversary.id]
    );
    assert.ok(anniversaryVariant);

    const pokemonMapping = await db.get(
      `SELECT category_name, object_name, variant_name, external_key, external_name, status, note
       FROM source_mappings
       WHERE source_key = 'qiandao_popmart' AND external_key = '1042229597409662992'`
    );
    assert.ok(pokemonMapping);
    assert.equal(pokemonMapping.category_name, "宝可梦");
    assert.equal(pokemonMapping.object_name, "30周年庆典统计");
    assert.equal(pokemonMapping.external_name, "30thC 30周年庆典");
    assert.equal(pokemonMapping.status, "enabled");
    assert.match(String(pokemonMapping.note), /不要误接冰箱贴/);

    const pokemonPrice = await db.get(
      `SELECT price, source, note FROM price_records
       WHERE category = '宝可梦' AND object_name = '30周年庆典统计' AND date = '2026-10-11'`
    );
    assert.ok(pokemonPrice);
    assert.equal(pokemonPrice.price, 390);
    assert.equal(pokemonPrice.source, "用户口述");

    const figure = await db.get(
      `SELECT o.id FROM objects o
       JOIN categories c ON c.id = o.category_id
       WHERE c.name = '泡泡玛特' AND o.name = '手办' AND COALESCE(o.is_archived, 0) = 0`
    );
    assert.ok(figure);

    const rocket = await db.get(
      `SELECT id FROM variants
       WHERE object_id = ? AND name = '复古可口可乐火箭摆件' AND COALESCE(is_archived, 0) = 0`,
      [figure.id]
    );
    assert.ok(rocket);

    const rocketMapping = await db.get(
      `SELECT object_name, variant_name, external_key, status, note
       FROM source_mappings
       WHERE source_key = 'qiandao_popmart' AND external_key = '1046009656108966651'`
    );
    assert.ok(rocketMapping);
    assert.equal(rocketMapping.object_name, "手办");
    assert.equal(rocketMapping.variant_name, "复古可口可乐火箭摆件");
    assert.equal(rocketMapping.status, "enabled");
    assert.match(String(rocketMapping.note), /不要误接 400%/);

    const rocketPrice = await db.get(
      `SELECT price, source FROM price_records
       WHERE category = '泡泡玛特'
         AND object_name = '手办'
         AND variant = '复古可口可乐火箭摆件'
         AND date = '2026-10-11'`
    );
    assert.ok(rocketPrice);
    assert.equal(rocketPrice.price, 3655);
    assert.equal(rocketPrice.source, "用户口述");

    const leaked = await db.get(
      `SELECT o.id FROM objects o
       JOIN categories c ON c.id = o.category_id
       WHERE c.name = '潮玩' AND o.name LIKE '%宝可梦%'`
    );
    assert.equal(leaked, undefined);
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
