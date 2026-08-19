import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assessPreciousMetalTaskFreshness,
  formatPreciousMetalFreshness
} from '../src/services/preciousMetalTaskFreshness';

test('marks silver stale when the source is one trading day behind', () => {
  const result = assessPreciousMetalTaskFreshness({
    expectedDate: '2026-08-19',
    requiredSymbols: ['SGE_AGTD'],
    latestDates: {
      XAUUSD: '2026-08-19',
      SGE_AGTD: '2026-08-18'
    }
  });

  assert.equal(result.is_fresh, false);
  assert.deepEqual(result.fresh_symbols, []);
  assert.deepEqual(result.stale_symbols, [
    { symbol: 'SGE_AGTD', latest_date: '2026-08-18' }
  ]);
  assert.equal(formatPreciousMetalFreshness(result), 'SGE_AGTD 2026-08-18');
});

test('marks the required silver symbol fresh after the current trade date arrives', () => {
  const result = assessPreciousMetalTaskFreshness({
    expectedDate: '2026-08-19',
    requiredSymbols: ['sge_agtd'],
    latestDates: {
      XAUUSD: '2026-08-18',
      SGE_AGTD: '2026-08-19'
    }
  });

  assert.equal(result.is_fresh, true);
  assert.deepEqual(result.fresh_symbols, ['SGE_AGTD']);
  assert.deepEqual(result.stale_symbols, []);
});

test('treats a missing required symbol date as stale', () => {
  const result = assessPreciousMetalTaskFreshness({
    expectedDate: '2026-08-19',
    requiredSymbols: ['SGE_AGTD'],
    latestDates: { XAUUSD: '2026-08-19' }
  });

  assert.equal(result.is_fresh, false);
  assert.deepEqual(result.stale_symbols, [
    { symbol: 'SGE_AGTD', latest_date: null }
  ]);
});

test('only evaluates the configured freshness symbol subset', () => {
  const result = assessPreciousMetalTaskFreshness({
    expectedDate: '2026-08-19',
    requiredSymbols: ['SGE_AGTD', 'SGE_AGTD'],
    latestDates: {
      XAUUSD: '2026-08-18',
      SGE_AGTD: '2026-08-19'
    }
  });

  assert.equal(result.is_fresh, true);
  assert.deepEqual(result.required_symbols, ['SGE_AGTD']);
});
