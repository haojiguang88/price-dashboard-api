import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseManager, initializeBusinessBaseSchema } from '../src/config/database';
import { runMigrations } from '../src/migrations';
import {
  EventTransmissionValidationError,
  normalizeEventTransmissionInput,
  parseStoredEventTransmission
} from '../src/utils/eventTransmission';

test('event transmission observation card is normalized and target snapshots are deduplicated', () => {
  const result = normalizeEventTransmissionInput({
    status: 'observation',
    directImpact: '  HBM需求上升  ',
    secondOrderImpact: '存储产能重新配置',
    pendingRepricingLink: '消费级SSD',
    reviewDate: '2026-09-30',
    targets: [
      {
        categoryId: '1',
        categoryName: '电子产品',
        objectId: '8',
        objectName: '固态硬盘',
        variantId: '0',
        variantName: ''
      },
      {
        categoryId: '1',
        categoryName: '电子产品',
        objectId: '8',
        objectName: '固态硬盘',
        variantId: '0',
        variantName: '重复项'
      }
    ],
    evidenceReferences: [
      {
        sourceType: 'missed_project',
        sourceId: '14',
        title: '安卓机器复盘',
        path: '/review/missed?recordId=14',
        relation: '原始复盘'
      },
      {
        sourceType: 'missed_project',
        sourceId: '14',
        title: '重复证据',
        path: '/review/missed?recordId=14',
        relation: '原始复盘'
      }
    ]
  });

  assert.ok(result);
  assert.equal(result.directImpact, 'HBM需求上升');
  assert.equal(result.targets.length, 1);
  assert.equal(result.targets[0].variantName, '重复项');
  assert.equal(result.evidenceReferences.length, 1);
  assert.equal(result.evidenceReferences[0].title, '重复证据');
});

test('empty event transmission observation card is not persisted', () => {
  assert.equal(normalizeEventTransmissionInput({ status: 'observation', targets: [] }), null);
});

test('invalid event transmission status and review date are rejected', () => {
  assert.throws(
    () => normalizeEventTransmissionInput({ status: 'buy_now', directImpact: '测试' }),
    EventTransmissionValidationError
  );
  assert.throws(
    () => normalizeEventTransmissionInput({ status: 'observation', reviewDate: '2026-99-99' }),
    EventTransmissionValidationError
  );
  assert.throws(
    () => normalizeEventTransmissionInput({
      directImpact: '测试',
      evidenceReferences: [{
        sourceType: 'external',
        sourceId: '1',
        title: '外部地址',
        path: 'https://example.com',
        relation: '来源'
      }]
    }),
    EventTransmissionValidationError
  );
});

test('malformed stored event transmission data does not break old event reads', () => {
  assert.equal(parseStoredEventTransmission('{not-json'), null);
});

test('event transmission migration adds the optional JSON snapshot column', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'price-dashboard-event-transmission-'));
  const filename = path.join(directory, 'event-transmission.db');
  const manager = new DatabaseManager({
    filename,
    allowCreate: true,
    initialize: initializeBusinessBaseSchema
  });

  try {
    await manager.getDb();
    await runMigrations(filename);
    const db = await manager.getDb();
    const columns = await db.all('PRAGMA table_info(event_records)');
    assert.equal(columns.some((column: any) => column.name === 'transmission_analysis_json'), true);

    const androidEvent = await db.get(
      `SELECT transmission_analysis_json
       FROM event_records
       WHERE title = 'AI需求推动存储价格上涨并向整机传导'
         AND COALESCE(is_deleted, 0) = 0`
    );
    assert.ok(androidEvent?.transmission_analysis_json);
    const analysis = JSON.parse(androidEvent.transmission_analysis_json);
    assert.equal(analysis.status, 'partially_verified');
    assert.match(analysis.secondOrderImpact, /消费级DRAM/);
    assert.deepEqual(
      analysis.evidenceReferences.map((reference: any) => reference.relation),
      ['原始复盘', '提炼案例', '沉淀规则']
    );
  } finally {
    await manager.close();
    await rm(directory, { recursive: true, force: true });
  }
});
