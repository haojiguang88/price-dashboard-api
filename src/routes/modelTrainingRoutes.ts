import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import getDb, { getDatabasePath } from '../config/database';
import { getLatestCoveredTradeDate } from '../utils/financeTradeDate';

const router = express.Router();

const planItems = [
  {
    stage: '数据与样本',
    items: [
      ['data_audit', '数据体检与清洗', '检查日线缺失、无效价格、重复记录、时间跨度和标的覆盖。'],
      ['feature_table', '生成训练样本表', '从 financial_daily_prices 生成每个标的每个交易日的特征样本。'],
      ['label_table', '生成训练标签', '生成结构成立+安全区主标签，并保留未来收益、最大回撤、跌破安全区和假突破辅助标签。'],
      ['split_dataset', '时间切分训练集/验证集', '按时间切分，避免未来数据泄漏。']
    ]
  },
  {
    stage: '结构成立 + 安全区模型',
    items: [
      ['baseline_stats', '规则基线统计', '先统计结构评分、安全区位置和未来收益/回撤的基础关系。'],
      ['logistic_regression', '逻辑回归基准模型', '训练可解释的概率基准，输出结构成立与安全区有效性的概率。'],
      ['random_forest', '随机森林规则挖掘', '挖出非线性组合规则和特征重要性。'],
      ['lightgbm_model', 'LightGBM梯度提升模型', '训练更强的非线性概率模型，作为规则候选和预测接口的主力候选。'],
      ['backtest_report', '分层回测报告', '按年份、标的类型、结构评分、安全区位置分层回测。']
    ]
  },
  {
    stage: '系统接入',
    items: [
      ['persist_models', '模型与结果落库', '保存模型文件、训练指标、特征重要性和规则候选。'],
      ['prediction_api', '预测接口', '给单标的判断和入场触发提供概率、回撤风险和相似样本。'],
      ['frontend_result', '前端结果展示', '在训练中心展示训练结果、完成状态、回测和规则候选。'],
      ['strategy_feedback', '反哺结构/安全区页面', '把模型概率接入结构判断、安全区和入场触发。']
    ]
  },
  {
    stage: '大模型增强',
    items: [
      ['llm_rule_summary', '大模型总结规则候选', '把训练出的组合规则转成可读策略说明和执行提醒。'],
      ['llm_failure_review', '大模型分析失败样本', '总结结构成立但失败的共性，例如假突破、追高、风格切换。'],
      ['llm_strategy_docs', '生成策略文档', '把模型结果整理成版本化策略说明、适用边界和风险提示。'],
      ['llm_assisted_iteration', '辅助下一套打法迭代', '在结构+安全区稳定后，再扩展突破、回踩、止损、仓位等打法。']
    ]
  }
];

const domainLabels: Record<string, string> = {
  stock: '个股',
  etf: 'ETF',
  football: '足彩'
};

const COMPARE_MODEL_SPECS = [
  ['logistic_regression', 'logistic_regression_model.json', 'logistic_regression_metrics.json'],
  ['random_forest', 'random_forest_model.json', 'random_forest_metrics.json'],
  ['lightgbm_model', 'lightgbm_model.json', 'lightgbm_metrics.json']
];

const TARGET_TEXT: Record<string, string> = {
  label_structure_safe_20d: '结构成立+安全区有效样本',
  label_ret_20d_gt_5: '未来20日收益>5%'
};

const trainingRoot = process.env.MODEL_TRAINING_ROOT || '/Volumes/7100/model-training';
const trainingPython = process.env.MODEL_TRAINING_PYTHON || path.join(trainingRoot, 'venv', 'bin', 'python');
let modelTrainingBootstrapPromise: Promise<void> | null = null;

const preferredModelOrder = `
  CASE model_key
    WHEN 'lightgbm_model' THEN 1
    WHEN 'random_forest' THEN 2
    WHEN 'logistic_regression' THEN 3
    ELSE 9
  END
`;

const parseJson = (value: unknown, fallback: any = null) => {
  if (typeof value !== 'string' || !value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const numberOrNull = (value: any) => {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const readJsonFile = async (filePath: string) => {
  try {
    const text = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const buildCompareRunPayload = async (run: any) => {
  const outputDir = String(run.output_dir || '');
  const [labelPayload, splitPayload] = await Promise.all([
    readJsonFile(path.join(outputDir, 'label_table.json')),
    readJsonFile(path.join(outputDir, 'split_dataset.json'))
  ]);

  const models = [];
  let defaultTestAuc = null;
  let target = null;
  for (const [modelKey, modelJsonName, metricsName] of COMPARE_MODEL_SPECS) {
    const [modelJson, metrics] = await Promise.all([
      readJsonFile(path.join(outputDir, modelJsonName)),
      readJsonFile(path.join(outputDir, metricsName))
    ]);
    if (!metrics) continue;
    target = target || modelJson?.target || null;
    const validationAuc = metrics?.validation?.auc;
    const testAuc = metrics?.test?.auc;
    if (modelKey === 'lightgbm_model') {
      defaultTestAuc = numberOrNull(testAuc);
    }
    models.push({
      modelKey,
      modelType: modelJson?.model_type || null,
      target: modelJson?.target || null,
      validationAuc: numberOrNull(validationAuc),
      testAuc: numberOrNull(testAuc),
      sampleLimits: metrics?.sample_limits || null,
      positiveRate: {
        train: numberOrNull(metrics?.train?.positive_rate),
        validation: numberOrNull(metrics?.validation?.positive_rate),
        test: numberOrNull(metrics?.test?.positive_rate)
      }
    });
  }

  const positiveCounts = labelPayload?.positive_counts || {};
  const labelRows = labelPayload?.label_rows;
  const structurePositive = positiveCounts.structure_safe_20d;
  const oldPositive = positiveCounts.ret_20_gt_5;

  return {
    runId: run.id,
    status: run.status,
    target,
    targetText: TARGET_TEXT[target || ''] || target || '-',
    outputDir,
    sourceRowCount: run.source_row_count,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    labelRows,
    structurePositiveRate: labelRows && structurePositive !== undefined ? structurePositive / labelRows : null,
    oldRet20PositiveRate: labelRows && oldPositive !== undefined ? oldPositive / labelRows : null,
    rowsBySplit: splitPayload?.rows_by_split || {},
    models,
    defaultTestAuc
  };
};

const addCompareDeltas = (runs: any[]) => {
  const ordered = [...runs].reverse();
  const previousByTarget = new Map<string, any>();
  for (const run of ordered) {
    const target = run.target || 'unknown';
    const previous = previousByTarget.get(target);
    run.deltaVsPreviousSameTarget = {
      defaultTestAuc: previous && run.defaultTestAuc !== null && previous.defaultTestAuc !== null
        ? run.defaultTestAuc - previous.defaultTestAuc
        : null,
      sourceRowCount: previous && run.sourceRowCount !== null && previous.sourceRowCount !== null
        ? run.sourceRowCount - previous.sourceRowCount
        : null
    };
    previousByTarget.set(target, run);
  }
  return ordered.reverse();
};

const getRegisteredModelBundle = async (db: any, domain: string) => {
  const rows = await db.all(
    `SELECT model_key, target, model_type, run_id, validation_auc, test_auc,
            model_file, metrics_file, updated_at
     FROM model_training_artifacts
     WHERE domain = ?
     ORDER BY ${preferredModelOrder}`,
    [domain]
  );
  if (!rows.length) return null;
  const target = rows[0].target;
  return {
    target,
    targetText: TARGET_TEXT[target || ''] || target || '-',
    models: rows.map((row: any) => ({
      modelKey: row.model_key,
      modelType: row.model_type,
      target: row.target,
      runId: row.run_id,
      validationAuc: numberOrNull(row.validation_auc),
      testAuc: numberOrNull(row.test_auc),
      modelFile: row.model_file,
      metricsFile: row.metrics_file,
      updatedAt: row.updated_at
    }))
  };
};

const buildCompareRunsFromLocalFiles = async (db: any, domain: string, limit = 8) => {
  const rows = await db.all(
    `SELECT id, domain, status, output_dir, source_row_count, started_at, finished_at
     FROM model_training_runs
     WHERE domain = ?
       AND status = 'completed'
       AND output_dir IS NOT NULL
       AND output_dir != ''
     ORDER BY id DESC
     LIMIT ?`,
    [domain, Math.max(Math.min(Number(limit) || 8, 50), 1)]
  );

  const runs = [];
  const skippedRuns = [];
  for (const row of rows) {
    try {
      await fs.access(row.output_dir);
      const payload = await buildCompareRunPayload(row);
      if (payload.models.length) {
        runs.push(payload);
      } else {
        skippedRuns.push({
          runId: row.id,
          status: row.status,
          outputDir: row.output_dir,
          sourceRowCount: row.source_row_count,
          finishedAt: row.finished_at,
          reason: '该 run 目录缺少模型指标文件，可能只执行了后续文档/LLM阶段，不能参与模型版本对比。'
        });
      }
    } catch {
      skippedRuns.push({
        runId: row.id,
        status: row.status,
        outputDir: row.output_dir,
        sourceRowCount: row.source_row_count,
        finishedAt: row.finished_at,
        reason: '训练目录不存在，不能读取模型指标。'
      });
    }
  }

  return {
    domain,
    runs: addCompareDeltas(runs),
    skippedRuns,
    registeredModels: await getRegisteredModelBundle(db, domain)
  };
};

const getDefaultModel = async (db: any, domain: string, modelKey?: string) => {
  if (modelKey) {
    return db.get(
      `SELECT model_key, target, model_type, model_file, model_json_file, metrics_file,
              source_feature_db, run_id, validation_auc, test_auc, sample_limits_json, updated_at
       FROM model_training_artifacts
       WHERE domain = ? AND model_key = ?
       ORDER BY updated_at DESC, run_id DESC
       LIMIT 1`,
      [domain, modelKey]
    );
  }

  return db.get(
    `SELECT model_key, target, model_type, model_file, model_json_file, metrics_file,
            source_feature_db, run_id, validation_auc, test_auc, sample_limits_json, updated_at
     FROM model_training_artifacts
     WHERE domain = ?
     ORDER BY ${preferredModelOrder}, updated_at DESC
     LIMIT 1`,
    [domain]
  );
};

const getModelSignal = (probability: number | null | undefined) => {
  if (typeof probability !== 'number') return { key: 'unscored', label: '未评分' };
  if (probability >= 0.6) return { key: 'accepted', label: '模型认可' };
  if (probability >= 0.5) return { key: 'neutral', label: '模型中性' };
  return { key: 'rejected', label: '模型不认可' };
};

const getRuleSignal = (score: number | null | undefined) => {
  if (typeof score !== 'number') return { key: 'unknown', label: '规则未评分' };
  if (score >= 85) return { key: 'strong', label: '强结构' };
  if (score >= 75) return { key: 'watch', label: '可观察' };
  return { key: 'weak', label: '规则偏弱' };
};

const getConflictType = (probability: number | null | undefined, ruleScore: number | null | undefined) => {
  const model = getModelSignal(probability).key;
  const rule = getRuleSignal(ruleScore).key;

  if ((rule === 'strong' || rule === 'watch') && model === 'accepted') {
    return { key: 'rule_model_aligned', label: '规则模型一致' };
  }
  if ((rule === 'strong' || rule === 'watch') && model === 'rejected') {
    return { key: 'rule_high_model_low', label: '规则强但模型不认' };
  }
  if (rule === 'weak' && model === 'accepted') {
    return { key: 'rule_low_model_high', label: '模型认可但规则弱' };
  }
  if (model === 'neutral') {
    return { key: 'neutral', label: '模型中性待观察' };
  }
  return { key: 'unscored_or_pending', label: '待补充评分' };
};

const runCandidatePoolScoreWorker = (
  domain: string,
  modelKey: string | undefined,
  limit: number,
  tradeDate?: string | null
): Promise<{ scores: Record<string, any>; candidateFeatureRefreshes?: Record<string, any> }> => new Promise((resolve, reject) => {
  const dbPath = getDatabasePath();
  const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'score_candidate_pool.py');
  const args = [
    scriptPath,
    '--db', dbPath,
    '--domain', domain,
    '--limit', String(limit)
  ];

  if (modelKey) {
    args.push('--model-key', modelKey);
  }
  if (tradeDate) {
    args.push('--trade-date', tradeDate);
  }

  const child = spawn(trainingPython, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  child.on('error', reject);
  child.on('close', code => {
    const lines = stdout.trim().split('\n').filter(Boolean);
    const text = lines[lines.length - 1] || '';
    try {
      const payload = JSON.parse(text || '{}');
      if (code === 0 && payload.success) {
        resolve({
          scores: payload.data?.scores || {},
          candidateFeatureRefreshes: payload.data?.candidateFeatureRefreshes || {}
        });
        return;
      }
      reject(new Error(payload.message || stderr || `备选池模型评分脚本退出：${code}`));
    } catch (error) {
      reject(new Error(stderr || text || `备选池模型评分输出无法解析：${error instanceof Error ? error.message : String(error)}`));
    }
  });
});

const runModelFeatureRefreshWorker = (
  domain: string,
  checkOnly = false,
  modelKey?: string
): Promise<any> => new Promise((resolve, reject) => {
  const dbPath = getDatabasePath();
  const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'refresh_model_features.py');
  const args = [
    scriptPath,
    '--db', dbPath,
    '--domain', domain
  ];
  if (checkOnly) {
    args.push('--check-only');
  }
  if (modelKey) {
    args.push('--model-key', modelKey);
  }

  const child = spawn(trainingPython, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  child.on('error', reject);
  child.on('close', code => {
    const lines = stdout.trim().split('\n').filter(Boolean);
    const text = lines[lines.length - 1] || '';
    try {
      const payload = JSON.parse(text || '{}');
      if (code === 0 && payload.success) {
        resolve(payload.data);
        return;
      }
      reject(new Error(payload.message || stderr || `模型特征刷新脚本退出：${code}`));
    } catch (error) {
      reject(new Error(stderr || text || `模型特征刷新输出无法解析：${error instanceof Error ? error.message : String(error)}`));
    }
  });
});

const startPipelineWorker = (runId: number, domain: string, outputDir: string) => {
  const dbPath = getDatabasePath();
  const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'run_pipeline.py');
  const child = spawn(trainingPython, [
    scriptPath,
    '--db', dbPath,
    '--domain', domain,
    '--run-id', String(runId),
    '--output-dir', outputDir
  ], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
};

const runPredictionWorker = (
  domain: string,
  symbol: string,
  modelKey?: string,
  tradeDate?: string
): Promise<any> => new Promise((resolve, reject) => {
  const dbPath = getDatabasePath();
  const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'predict.py');
  const args = [
    scriptPath,
    '--db', dbPath,
    '--domain', domain,
    '--symbol', symbol
  ];

  if (modelKey) {
    args.push('--model-key', modelKey);
  }
  if (tradeDate) {
    args.push('--trade-date', tradeDate);
  }

  const child = spawn(trainingPython, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  child.on('error', reject);
  child.on('close', code => {
    const text = stdout.trim();
    try {
      const payload = JSON.parse(text || '{}');
      if (code === 0 && payload.success) {
        resolve(payload.data);
        return;
      }
      reject(new Error(payload.message || stderr || `预测脚本退出：${code}`));
    } catch (error) {
      reject(new Error(stderr || text || `预测脚本输出无法解析：${error instanceof Error ? error.message : String(error)}`));
    }
  });
});

const runCandidateScanWorker = (
  domain: string,
  modelKey?: string,
  limit?: number,
  top?: number,
  tradeDate?: string | null
): Promise<any> => new Promise((resolve, reject) => {
  const dbPath = getDatabasePath();
  const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'scan_candidates.py');
  const args = [
    scriptPath,
    '--db', dbPath,
    '--domain', domain,
    '--limit', String(limit || 6000),
    '--top', String(top || 30)
  ];

  if (modelKey) {
    args.push('--model-key', modelKey);
  }
  if (tradeDate) {
    args.push('--trade-date', tradeDate);
  }

  const child = spawn(trainingPython, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  child.on('error', reject);
  child.on('close', code => {
    const lines = stdout.trim().split('\n').filter(Boolean);
    const text = lines[lines.length - 1] || '';
    try {
      const payload = JSON.parse(text || '{}');
      if (code === 0 && payload.success) {
        resolve(payload.data);
        return;
      }
      reject(new Error(payload.message || stderr || `候选扫描脚本退出：${code}`));
    } catch (error) {
      reject(new Error(stderr || text || `候选扫描输出无法解析：${error instanceof Error ? error.message : String(error)}`));
    }
  });
});

const runReviewDashboardWorker = (
  domain: string,
  modelKey?: string,
  sampleLimit?: number,
  top?: number
): Promise<any> => new Promise((resolve, reject) => {
  const dbPath = getDatabasePath();
  const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'review_dashboard.py');
  const args = [
    scriptPath,
    '--db', dbPath,
    '--domain', domain,
    '--sample-limit', String(sampleLimit || 120000),
    '--top', String(top || 30)
  ];

  if (modelKey) {
    args.push('--model-key', modelKey);
  }

  const child = spawn(trainingPython, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  child.on('error', reject);
  child.on('close', code => {
    const lines = stdout.trim().split('\n').filter(Boolean);
    const text = lines[lines.length - 1] || '';
    try {
      const payload = JSON.parse(text || '{}');
      if (code === 0 && payload.success) {
        resolve(payload.data);
        return;
      }
      reject(new Error(payload.message || stderr || `复盘脚本退出：${code}`));
    } catch (error) {
      reject(new Error(stderr || text || `复盘脚本输出无法解析：${error instanceof Error ? error.message : String(error)}`));
    }
  });
});

const runCompareRunsWorker = (
  domain: string,
  limit?: number
): Promise<any> => new Promise((resolve, reject) => {
  const dbPath = getDatabasePath();
  const scriptPath = path.join(process.cwd(), 'scripts', 'model_training', 'compare_runs.py');
  const args = [
    scriptPath,
    '--db', dbPath,
    '--domain', domain,
    '--limit', String(limit || 8)
  ];

  const child = spawn(trainingPython, args, {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  const timeout = setTimeout(() => {
    child.kill();
    reject(new Error('版本对比超过 45 秒未返回，已中断本次请求。'));
  }, 45000);
  child.on('error', error => {
    clearTimeout(timeout);
    reject(error);
  });
  child.on('close', code => {
    clearTimeout(timeout);
    const lines = stdout.trim().split('\n').filter(Boolean);
    const text = lines[lines.length - 1] || '';
    try {
      const payload = JSON.parse(text || '{}');
      if (code === 0 && payload.success) {
        resolve(payload.data);
        return;
      }
      reject(new Error(payload.message || stderr || `版本对比脚本退出：${code}`));
    } catch (error) {
      reject(new Error(stderr || text || `版本对比脚本输出无法解析：${error instanceof Error ? error.message : String(error)}`));
    }
  });
});

const ensureModelTrainingTables = async (db: any) => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS model_training_plan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      item_key TEXT NOT NULL,
      stage TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      sort_order INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(domain, item_key)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS model_training_run_plan_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      domain TEXT NOT NULL,
      item_key TEXT NOT NULL,
      stage TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      sort_order INTEGER NOT NULL DEFAULT 0,
      completed_at TEXT,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(run_id, item_key)
    )
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_model_training_run_plan_items_run
    ON model_training_run_plan_items(run_id, domain, sort_order);
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS model_training_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      output_dir TEXT NOT NULL,
      current_item_key TEXT,
      message TEXT,
      source_row_count INTEGER DEFAULT 0,
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finished_at TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS model_training_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      model_key TEXT NOT NULL,
      target TEXT,
      model_type TEXT,
      model_file TEXT,
      model_json_file TEXT,
      metrics_file TEXT,
      source_feature_db TEXT,
      run_id INTEGER,
      validation_auc REAL,
      test_auc REAL,
      sample_limits_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(domain, model_key)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS model_training_feature_importance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      model_key TEXT NOT NULL,
      feature TEXT NOT NULL,
      importance REAL,
      raw_importance REAL,
      rank_order INTEGER NOT NULL,
      run_id INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(domain, model_key, feature)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS model_training_rule_candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      source_key TEXT NOT NULL,
      rank_order INTEGER NOT NULL,
      title TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      run_id INTEGER,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(domain, source_key, rank_order)
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS model_training_active_models (
      domain TEXT PRIMARY KEY,
      model_key TEXT NOT NULL,
      run_id INTEGER,
      target TEXT,
      model_type TEXT,
      validation_auc REAL,
      test_auc REAL,
      activated_at TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS model_training_candidate_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL,
      candidate_id INTEGER,
      symbol TEXT NOT NULL,
      name TEXT,
      asset_type TEXT NOT NULL,
      source TEXT NOT NULL,
      trade_date TEXT,
      as_of_trade_date TEXT,
      model_key TEXT NOT NULL,
      model_run_id INTEGER,
      model_target TEXT,
      probability REAL,
      model_level_key TEXT,
      model_level_label TEXT,
      rule_score REAL,
      rule_level_key TEXT,
      rule_level_label TEXT,
      conflict_key TEXT,
      conflict_label TEXT,
      review_status TEXT,
      candidate_reason TEXT,
      source_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(domain, symbol, asset_type, source, model_key)
    )
  `);

  const candidateScoreColumns = await db.all(`PRAGMA table_info(model_training_candidate_scores)`);
  const candidateScoreColumnNames = new Set(candidateScoreColumns.map((column: any) => column.name));
  if (!candidateScoreColumnNames.has('as_of_trade_date')) {
    await db.exec(`ALTER TABLE model_training_candidate_scores ADD COLUMN as_of_trade_date TEXT`);
  }

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_model_training_candidate_scores_domain
    ON model_training_candidate_scores(domain, updated_at);
  `);

  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_model_training_candidate_scores_active
    ON model_training_candidate_scores(domain, model_key, model_run_id, updated_at);
  `);
};

const seedDomainPlan = async (db: any, domain: string) => {
  const now = new Date().toISOString();
  let sortOrder = 1;

  for (const stage of planItems) {
    for (const [itemKey, title, description] of stage.items) {
      await db.run(
        `INSERT INTO model_training_plan_items (
          domain, item_key, stage, title, description, status, sort_order, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
        ON CONFLICT(domain, item_key) DO UPDATE SET
          stage = excluded.stage,
          title = excluded.title,
          description = excluded.description,
          sort_order = excluded.sort_order,
          updated_at = excluded.updated_at`,
        [domain, itemKey, stage.stage, title, description, sortOrder, now, now]
      );
      sortOrder += 1;
    }
  }
};

const seedRunPlan = async (db: any, runId: number, domain: string, activeItemKey?: string, activeNote?: string) => {
  const now = new Date().toISOString();
  let sortOrder = 1;

  for (const stage of planItems) {
    for (const [itemKey, title, description] of stage.items) {
      const status = itemKey === activeItemKey ? 'running' : 'pending';
      const note = itemKey === activeItemKey ? activeNote || null : null;
      await db.run(
        `INSERT INTO model_training_run_plan_items (
          run_id, domain, item_key, stage, title, description, status, sort_order, note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, item_key) DO UPDATE SET
          stage = excluded.stage,
          title = excluded.title,
          description = excluded.description,
          status = excluded.status,
          sort_order = excluded.sort_order,
          note = COALESCE(excluded.note, model_training_run_plan_items.note),
          updated_at = excluded.updated_at`,
        [runId, domain, itemKey, stage.stage, title, description, status, sortOrder, note, now, now]
      );
      sortOrder += 1;
    }
  }
};

const getFirstPlanItem = () => {
  const firstStage = planItems[0];
  const firstItem = firstStage?.items?.[0];
  if (!firstItem) return null;
  return {
    item_key: firstItem[0],
    title: firstItem[1]
  };
};

const bootstrapModelTraining = async () => {
  if (!modelTrainingBootstrapPromise) {
    modelTrainingBootstrapPromise = (async () => {
      const db = await getDb();
      await ensureModelTrainingTables(db);
      for (const domain of Object.keys(domainLabels)) {
        await seedDomainPlan(db, domain);
      }
    })().catch(error => {
      modelTrainingBootstrapPromise = null;
      throw error;
    });
  }

  return modelTrainingBootstrapPromise;
};

router.use(async (_req, _res, next) => {
  try {
    await bootstrapModelTraining();
    next();
  } catch (error) {
    next(error);
  }
});

router.post('/admin/bootstrap', async (_req, res) => {
  try {
    modelTrainingBootstrapPromise = null;
    const db = await getDb();
    await ensureModelTrainingTables(db);
    for (const domain of Object.keys(domainLabels)) {
      await seedDomainPlan(db, domain);
    }
    res.json({ success: true, message: '模型训练基础表和计划已重新同步' });
  } catch (error) {
    console.error('Error bootstrapping model training:', error);
    res.status(500).json({ success: false, message: '同步模型训练基础表失败' });
  }
});

router.get('/plan/:domain', async (req, res) => {
  try {
    const db = await getDb();
    const { domain } = req.params;

    if (!domainLabels[domain]) {
      return res.status(400).json({ success: false, message: '不支持的训练域' });
    }

    const latestRun = await db.get(
      `SELECT id, status, started_at
       FROM model_training_runs
       WHERE domain = ?
       ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
       LIMIT 1`,
      [domain]
    );
    let planScope = 'domain_template';
    let planRunId: number | null = null;
    let items = latestRun
      ? await db.all(
        `SELECT id, run_id, domain, item_key, stage, title, description, status, sort_order, completed_at, note, updated_at
         FROM model_training_run_plan_items
         WHERE run_id = ? AND domain = ?
         ORDER BY sort_order ASC`,
        [latestRun.id, domain]
      )
      : [];

    if (items.length > 0) {
      planScope = 'latest_run';
      planRunId = latestRun.id;
    } else {
      items = await db.all(
        `SELECT id, NULL AS run_id, domain, item_key, stage, title, description, status, sort_order, completed_at, note, updated_at
         FROM model_training_plan_items
         WHERE domain = ?
         ORDER BY sort_order ASC`,
        [domain]
      );
    }

    res.json({ success: true, data: { domain, domainLabel: domainLabels[domain], runId: planRunId, planScope, items } });
  } catch (error) {
    console.error('Error getting model training plan:', error);
    res.status(500).json({ success: false, message: '获取模型训练计划失败' });
  }
});

router.get('/runs/:domain/latest', async (req, res) => {
  try {
    const db = await getDb();
    const { domain } = req.params;

    if (!domainLabels[domain]) {
      return res.status(400).json({ success: false, message: '不支持的训练域' });
    }

    const run = await db.get(
      `SELECT * FROM model_training_runs
       WHERE domain = ?
       ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
       LIMIT 1`,
      [domain]
    );
    res.json({ success: true, data: run || null });
  } catch (error) {
    console.error('Error getting latest model training run:', error);
    res.status(500).json({ success: false, message: '获取训练运行记录失败' });
  }
});

router.get('/results/:domain', async (req, res) => {
  try {
    const db = await getDb();
    const { domain } = req.params;

    if (!domainLabels[domain]) {
      return res.status(400).json({ success: false, message: '不支持的训练域' });
    }

    const models = await db.all(
      `SELECT model_key, target, model_type, model_file, model_json_file, metrics_file,
              source_feature_db, run_id, validation_auc, test_auc, sample_limits_json, updated_at
       FROM model_training_artifacts
       WHERE domain = ?
       ORDER BY
         CASE model_key
           WHEN 'lightgbm_model' THEN 1
           WHEN 'random_forest' THEN 2
           WHEN 'logistic_regression' THEN 3
           ELSE 9
         END`,
      [domain]
    );

    const featureImportance = await db.all(
      `SELECT model_key, feature, importance, raw_importance, rank_order
       FROM model_training_feature_importance
       WHERE domain = ?
       ORDER BY model_key, rank_order ASC`,
      [domain]
    );

    const ruleRows = await db.all(
      `SELECT source_key, rank_order, title, payload_json
       FROM model_training_rule_candidates
       WHERE domain = ?
       ORDER BY source_key, rank_order ASC`,
      [domain]
    );

    const rules = ruleRows.map((row: any) => ({
      sourceKey: row.source_key,
      rankOrder: row.rank_order,
      title: row.title,
      payload: (() => {
        try {
          return JSON.parse(row.payload_json);
        } catch {
          return row.payload_json;
        }
      })()
    }));

    const latestRun = await db.get(
      `SELECT * FROM model_training_runs
       WHERE domain = ?
       ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
       LIMIT 1`,
      [domain]
    );
    const recentRuns = await db.all(
      `SELECT id, domain, status, output_dir, current_item_key, message, source_row_count, started_at, finished_at
       FROM model_training_runs
       WHERE domain = ?
       ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
       LIMIT 6`,
      [domain]
    );

    res.json({
      success: true,
      data: {
        domain,
        domainLabel: domainLabels[domain],
        latestRun,
        recentRuns,
        models: models.map((model: any) => ({
          ...model,
          sample_limits: (() => {
            try {
              return model.sample_limits_json ? JSON.parse(model.sample_limits_json) : null;
            } catch {
              return null;
            }
          })()
        })),
        featureImportance,
        rules
      }
    });
  } catch (error) {
    console.error('Error getting model training results:', error);
    res.status(500).json({ success: false, message: '获取模型训练结果失败' });
  }
});

router.get('/explain/:domain', async (req, res) => {
  try {
    const db = await getDb();
    const { domain } = req.params;

    if (!domainLabels[domain]) {
      return res.status(400).json({ success: false, message: '不支持的训练域' });
    }

    const defaultModel = await getDefaultModel(db, domain);
    const activeModel = await db.get(
      `SELECT domain, model_key, run_id, target, model_type, validation_auc, test_auc, activated_at, note, updated_at
       FROM model_training_active_models
       WHERE domain = ?`,
      [domain]
    );
    const latestRun = await db.get(
      `SELECT id, domain, status, output_dir, current_item_key, message, source_row_count, started_at, finished_at
       FROM model_training_runs
       WHERE domain = ?
       ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
       LIMIT 1`,
      [domain]
    );
    const topFeatures = defaultModel
      ? await db.all(
        `SELECT feature, importance, raw_importance, rank_order
         FROM model_training_feature_importance
         WHERE domain = ? AND model_key = ?
         ORDER BY rank_order ASC
         LIMIT 8`,
        [domain, defaultModel.model_key]
      )
      : [];
    const ruleRows = await db.all(
      `SELECT source_key, rank_order, title, payload_json
       FROM model_training_rule_candidates
       WHERE domain = ?
       ORDER BY
         CASE source_key
           WHEN 'backtest_test' THEN 1
           WHEN 'backtest_validation' THEN 2
           ELSE 3
         END,
         rank_order ASC
       LIMIT 10`,
      [domain]
    );
    const candidateScoreCount = activeModel
      ? await db.get(
        `SELECT COUNT(*) AS count
         FROM model_training_candidate_scores
         WHERE domain = ?
           AND model_key = ?
           AND COALESCE(model_run_id, -1) = COALESCE(?, -1)`,
        [domain, activeModel.model_key, activeModel.run_id ?? null]
      )
      : await db.get(
        `SELECT COUNT(*) AS count
         FROM model_training_candidate_scores
         WHERE domain = ?`,
        [domain]
      );
    const runCount = await db.get(
      `SELECT COUNT(*) AS count
       FROM model_training_runs
       WHERE domain = ? AND status = 'completed'`,
      [domain]
    );

    const sampleLimits = parseJson(defaultModel?.sample_limits_json, {});
    const featureNames = topFeatures.map((item: any) => item.feature).filter(Boolean);
    const ruleTitles = ruleRows.map((row: any) => row.title).filter(Boolean);

    res.json({
      success: true,
      data: {
        domain,
        domainLabel: domainLabels[domain],
        latestRun,
        defaultModel: defaultModel ? {
          ...defaultModel,
          sample_limits: sampleLimits
        } : null,
        activeModel: activeModel || null,
        topFeatures,
        rules: ruleRows.map((row: any) => ({
          sourceKey: row.source_key,
          rankOrder: row.rank_order,
          title: row.title,
          payload: parseJson(row.payload_json, row.payload_json)
        })),
        candidateScoreCount: Number(candidateScoreCount?.count || 0),
        completedRunCount: Number(runCount?.count || 0),
        narrative: {
          target: defaultModel?.target || '结构成立 + 安全区有效概率',
          modelChoice: defaultModel
            ? `最新登记模型是 ${defaultModel.model_key}，因为它是当前排序最高的本地模型；启用到线上预测前仍需要手动确认。`
            : '还没有可解释的本地模型，需要先完成模型落库。',
          sample: latestRun?.source_row_count
            ? `最近训练源数据约 ${Number(latestRun.source_row_count).toLocaleString()} 行，训练产物在 7100 盘。`
            : '暂无最近训练源数据记录。',
          featureSummary: featureNames.length > 0
            ? `当前权重靠前的特征包括：${featureNames.slice(0, 5).join('、')}。`
            : '还没有特征重要性结果。',
          ruleSummary: ruleTitles.length > 0
            ? `可复盘的规则/回测切片包括：${ruleTitles.slice(0, 4).join('、')}。`
            : '还没有规则候选和分层回测切片。'
        }
      }
    });
  } catch (error) {
    console.error('Error explaining model training result:', error);
    res.status(500).json({ success: false, message: '获取模型解释失败' });
  }
});

router.get('/active/:domain', async (req, res) => {
  try {
    const db = await getDb();
    const { domain } = req.params;

    if (!domainLabels[domain]) {
      return res.status(400).json({ success: false, message: '不支持的训练域' });
    }

    const activeModel = await db.get(
      `SELECT domain, model_key, run_id, target, model_type, validation_auc, test_auc, activated_at, note, updated_at
       FROM model_training_active_models
       WHERE domain = ?`,
      [domain]
    );
    const defaultModel = await getDefaultModel(db, domain);

    res.json({
      success: true,
      data: {
        activeModel: activeModel || null,
        defaultModel: defaultModel ? {
          ...defaultModel,
          sample_limits: parseJson(defaultModel.sample_limits_json, null)
        } : null
      }
    });
  } catch (error) {
    console.error('Error getting active model:', error);
    res.status(500).json({ success: false, message: '获取启用模型失败' });
  }
});

router.post('/activate/:domain', async (req, res) => {
  try {
    const db = await getDb();
    const { domain } = req.params;
    const modelKey = typeof req.body?.modelKey === 'string' ? req.body.modelKey : undefined;
    const note = typeof req.body?.note === 'string' ? req.body.note : '手动确认启用，用于预测接口和候选评分优先参考。';

    if (!domainLabels[domain]) {
      return res.status(400).json({ success: false, message: '不支持的训练域' });
    }
    if (domain === 'football') {
      return res.status(400).json({ success: false, message: '足彩模型启用还未接入盘口模型' });
    }

    const model = await getDefaultModel(db, domain, modelKey);
    if (!model) {
      return res.status(404).json({ success: false, message: '没有找到可启用的模型' });
    }

    const now = new Date().toISOString();
    await db.run(
      `INSERT INTO model_training_active_models (
        domain, model_key, run_id, target, model_type, validation_auc, test_auc,
        activated_at, note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(domain) DO UPDATE SET
        model_key = excluded.model_key,
        run_id = excluded.run_id,
        target = excluded.target,
        model_type = excluded.model_type,
        validation_auc = excluded.validation_auc,
        test_auc = excluded.test_auc,
        activated_at = excluded.activated_at,
        note = excluded.note,
        updated_at = excluded.updated_at`,
      [
        domain,
        model.model_key,
        model.run_id || null,
        model.target || null,
        model.model_type || null,
        model.validation_auc ?? null,
        model.test_auc ?? null,
        now,
        note,
        now,
        now
      ]
    );

    const activeModel = await db.get(
      `SELECT domain, model_key, run_id, target, model_type, validation_auc, test_auc, activated_at, note, updated_at
       FROM model_training_active_models
       WHERE domain = ?`,
      [domain]
    );
    res.json({ success: true, data: activeModel, message: '模型已手动设为当前启用版本' });
  } catch (error) {
    console.error('Error activating model:', error);
    res.status(500).json({ success: false, message: `启用模型失败：${error instanceof Error ? error.message : String(error)}` });
  }
});

router.post('/sync-candidates/:domain', async (req, res) => {
  try {
    const db = await getDb();
    const { domain } = req.params;
    const limit = typeof req.body?.limit === 'number' ? req.body.limit : 500;
    const requestedModelKey = typeof req.body?.modelKey === 'string' ? req.body.modelKey : undefined;
    const autoRefreshFeatures = req.body?.autoRefreshFeatures === true;
    const allowInactiveModel = req.body?.allowInactiveModel === true;

    if (!domainLabels[domain]) {
      return res.status(400).json({ success: false, message: '不支持的训练域' });
    }
    if (domain === 'football') {
      return res.status(400).json({ success: false, message: '足彩候选评分还未接入盘口模型' });
    }

    await fs.access(trainingPython);
    const activeModel = await db.get(
      `SELECT model_key, run_id
       FROM model_training_active_models
       WHERE domain = ?`,
      [domain]
    );
    if (!allowInactiveModel) {
      if (!activeModel?.model_key) {
        return res.status(409).json({
          success: false,
          message: '候选模型分数同步必须先手动启用模型，避免最新未验收模型直接进入候选池。'
        });
      }
      if (requestedModelKey && requestedModelKey !== activeModel.model_key) {
        return res.status(409).json({
          success: false,
          message: `候选模型分数只能使用当前启用模型 ${activeModel.model_key}；${requestedModelKey} 尚未手动启用。`
        });
      }
    }
    const modelKeyForScore = allowInactiveModel
      ? (requestedModelKey || activeModel?.model_key)
      : activeModel.model_key;
    const model = await getDefaultModel(db, domain, modelKeyForScore);
    if (!model) {
      return res.status(404).json({ success: false, message: '没有可用模型，先完成模型落库或手动启用模型' });
    }
    const coveredTradeDate = await getLatestCoveredTradeDate(db, { assetTypes: [domain] });
    if (!coveredTradeDate) {
      return res.status(409).json({ success: false, message: '没有覆盖合格的交易日，候选池模型评分已停止。' });
    }

    let featureRefresh: any = null;
    try {
      const beforeRefresh = await runModelFeatureRefreshWorker(domain, true, model.model_key);
      const latestFeatureDate = beforeRefresh?.latestTradeDate || null;
      const needsRefresh = !latestFeatureDate || latestFeatureDate < coveredTradeDate;
      featureRefresh = autoRefreshFeatures && needsRefresh
        ? await runModelFeatureRefreshWorker(domain, false, model.model_key)
        : beforeRefresh;
    } catch (error) {
      featureRefresh = {
        status: 'check_failed',
        message: error instanceof Error ? error.message : String(error)
      };
    }

    const scorePayload = await runCandidatePoolScoreWorker(domain, model.model_key, limit, coveredTradeDate);
    const scoreMap = scorePayload.scores || {};
    const availableScoreCount = Object.values(scoreMap || {}).filter((score: any) => score?.available === true).length;
    if (availableScoreCount === 0) {
      const firstReason = Object.values(scoreMap || {}).map((score: any) => score?.reason).find(Boolean);
      return res.status(409).json({
        success: false,
        message: firstReason || '模型当前没有生成任何可用评分，已保留原有候选评分快照。',
        data: {
          domain,
          modelKey: model.model_key,
          modelRunId: model.run_id,
          coveredTradeDate,
          featureRefresh,
          candidateFeatureRefreshes: scorePayload.candidateFeatureRefreshes || {},
          scored: 0
        }
      });
    }

    await db.run(
      `DELETE FROM model_training_candidate_scores
       WHERE domain = ?
         AND (
           model_key != ?
           OR COALESCE(model_run_id, -1) != COALESCE(?, -1)
           OR COALESCE(as_of_trade_date, trade_date) != ?
         )`,
      [domain, model.model_key, model.run_id ?? null, coveredTradeDate]
    );
    const candidates = await db.all(
      `SELECT id, symbol, name, asset_type, source, trade_date, priority_score,
              review_status, candidate_reason, risk_note, last_checked_at
       FROM financial_candidate_pool
       WHERE pool_status = 'active'
         AND asset_type = ?
         AND (trade_date IS NULL OR trade_date <= ?)
       ORDER BY priority_score DESC, last_checked_at DESC
       LIMIT ?`,
      [domain, coveredTradeDate, limit]
    );
    await db.run(
      `DELETE FROM model_training_candidate_scores
       WHERE domain = ?
         AND model_key = ?
         AND COALESCE(model_run_id, -1) = COALESCE(?, -1)
         AND COALESCE(as_of_trade_date, trade_date) = ?`,
      [domain, model.model_key, model.run_id ?? null, coveredTradeDate]
    );

    const now = new Date().toISOString();
    let scored = 0;
    for (const candidate of candidates) {
      const key = `${candidate.symbol}|${candidate.asset_type}|${candidate.source}`;
      const score = scoreMap[key] || {};
      const probability = score.available === true && typeof score.probability === 'number'
        ? Number(score.probability)
        : null;
      const ruleScore = typeof candidate.priority_score === 'number' ? Number(candidate.priority_score) : null;
      const modelSignal = getModelSignal(probability);
      const ruleSignal = getRuleSignal(ruleScore);
      const conflict = getConflictType(probability, ruleScore);
      if (probability !== null) scored += 1;

      await db.run(
        `INSERT INTO model_training_candidate_scores (
          domain, candidate_id, symbol, name, asset_type, source, trade_date, as_of_trade_date,
          model_key, model_run_id, model_target, probability, model_level_key, model_level_label,
          rule_score, rule_level_key, rule_level_label, conflict_key, conflict_label,
          review_status, candidate_reason, source_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(domain, symbol, asset_type, source, model_key) DO UPDATE SET
          candidate_id = excluded.candidate_id,
          name = excluded.name,
          trade_date = excluded.trade_date,
          as_of_trade_date = excluded.as_of_trade_date,
          model_run_id = excluded.model_run_id,
          model_target = excluded.model_target,
          probability = excluded.probability,
          model_level_key = excluded.model_level_key,
          model_level_label = excluded.model_level_label,
          rule_score = excluded.rule_score,
          rule_level_key = excluded.rule_level_key,
          rule_level_label = excluded.rule_level_label,
          conflict_key = excluded.conflict_key,
          conflict_label = excluded.conflict_label,
          review_status = excluded.review_status,
          candidate_reason = excluded.candidate_reason,
          source_json = excluded.source_json,
          updated_at = excluded.updated_at`,
        [
          domain,
          candidate.id,
          candidate.symbol,
          candidate.name || null,
          candidate.asset_type,
          candidate.source,
          score.tradeDate || candidate.trade_date || null,
          coveredTradeDate,
          model.model_key,
          model.run_id || null,
          score.target || model.target || null,
          probability,
          modelSignal.key,
          modelSignal.label,
          ruleScore,
          ruleSignal.key,
          ruleSignal.label,
          conflict.key,
          conflict.label,
          candidate.review_status || null,
          candidate.candidate_reason || candidate.risk_note || null,
          JSON.stringify({ candidate, score }),
          now,
          now
        ]
      );
    }

    const rows = await db.all(
      `SELECT *
       FROM model_training_candidate_scores
       WHERE domain = ?
         AND model_key = ?
         AND COALESCE(model_run_id, -1) = COALESCE(?, -1)
         AND COALESCE(as_of_trade_date, trade_date) = ?
       ORDER BY
         CASE conflict_key
           WHEN 'rule_model_aligned' THEN 1
           WHEN 'neutral' THEN 2
           WHEN 'rule_high_model_low' THEN 3
           WHEN 'rule_low_model_high' THEN 4
           ELSE 9
         END,
         probability DESC,
         rule_score DESC
       LIMIT 80`,
      [domain, model.model_key, model.run_id ?? null, coveredTradeDate]
    );

    res.json({
      success: true,
      data: {
        domain,
        modelKey: model.model_key,
        modelRunId: model.run_id,
        coveredTradeDate,
        featureRefresh,
        candidateFeatureRefreshes: scorePayload.candidateFeatureRefreshes || {},
        checked: candidates.length,
        scored,
        items: rows
      },
      message: `候选池模型评分已同步：检查 ${candidates.length} 个，成功评分 ${scored} 个`
    });
  } catch (error) {
    console.error('Error syncing candidate model scores:', error);
    res.status(500).json({
      success: false,
      message: `同步候选模型分数失败：${error instanceof Error ? error.message : String(error)}`
    });
  }
});

router.get('/candidate-scores/:domain', async (req, res) => {
  try {
    const db = await getDb();
    const { domain } = req.params;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : 80;

    if (!domainLabels[domain]) {
      return res.status(400).json({ success: false, message: '不支持的训练域' });
    }

    const activeModel = await db.get(
      `SELECT model_key, run_id
       FROM model_training_active_models
       WHERE domain = ?`,
      [domain]
    );
    const coveredTradeDate = domain === 'stock' || domain === 'etf'
      ? await getLatestCoveredTradeDate(db, { assetTypes: [domain] })
      : null;
    const scoreFreshness = activeModel
      ? await db.get(
        `SELECT MAX(COALESCE(as_of_trade_date, trade_date)) AS latest_trade_date, COUNT(*) AS rows
         FROM model_training_candidate_scores
         WHERE domain = ?
           AND model_key = ?
           AND COALESCE(model_run_id, -1) = COALESCE(?, -1)`,
        [domain, activeModel.model_key, activeModel.run_id ?? null]
      )
      : await db.get(
        `SELECT MAX(COALESCE(as_of_trade_date, trade_date)) AS latest_trade_date, COUNT(*) AS rows
         FROM model_training_candidate_scores
         WHERE domain = ?`,
        [domain]
      );
    const latestScoreTradeDate = scoreFreshness?.latest_trade_date || null;
    const scoresFresh = !coveredTradeDate || latestScoreTradeDate === coveredTradeDate;
    const freshnessFilter = coveredTradeDate
      ? scoresFresh
        ? ' AND COALESCE(as_of_trade_date, trade_date) = ?'
        : ' AND 1 = 0'
      : '';
    const freshnessParams = coveredTradeDate && scoresFresh ? [coveredTradeDate] : [];

    const rows = activeModel
      ? await db.all(
        `SELECT id, domain, candidate_id, symbol, name, asset_type, source, trade_date, as_of_trade_date,
                model_key, model_run_id, model_target, probability, model_level_key, model_level_label,
                rule_score, rule_level_key, rule_level_label, conflict_key, conflict_label,
                review_status, candidate_reason, updated_at
         FROM model_training_candidate_scores
         WHERE domain = ?
           AND model_key = ?
           AND COALESCE(model_run_id, -1) = COALESCE(?, -1)
           ${freshnessFilter}
         ORDER BY updated_at DESC, probability DESC, rule_score DESC
         LIMIT ?`,
        [domain, activeModel.model_key, activeModel.run_id ?? null, ...freshnessParams, limit]
      )
      : await db.all(
        `SELECT id, domain, candidate_id, symbol, name, asset_type, source, trade_date, as_of_trade_date,
                model_key, model_run_id, model_target, probability, model_level_key, model_level_label,
                rule_score, rule_level_key, rule_level_label, conflict_key, conflict_label,
                review_status, candidate_reason, updated_at
         FROM model_training_candidate_scores
         WHERE domain = ?
           ${freshnessFilter}
         ORDER BY updated_at DESC, probability DESC, rule_score DESC
         LIMIT ?`,
        [domain, ...freshnessParams, limit]
      );

    res.json({
      success: true,
      data: {
        domain,
        activeModel: activeModel || null,
        coveredTradeDate,
        scoreFreshness: {
          latest_trade_date: latestScoreTradeDate,
          rows: Number(scoreFreshness?.rows || 0),
          status: scoresFresh ? 'fresh' : 'stale',
          message: scoresFresh
            ? '候选模型分数与当前覆盖交易日一致。'
            : `候选模型分数滞后：最新评分日 ${latestScoreTradeDate || '无'}，当前覆盖交易日 ${coveredTradeDate}。`
        },
        items: rows
      }
    });
  } catch (error) {
    console.error('Error getting candidate model scores:', error);
    res.status(500).json({ success: false, message: '获取候选模型分数失败' });
  }
});

router.get('/five-stage/:domain', async (req, res) => {
  try {
    const db = await getDb();
    const { domain } = req.params;

    if (!domainLabels[domain]) {
      return res.status(400).json({ success: false, message: '不支持的训练域' });
    }

    const modelsRow = await db.get(
      `SELECT COUNT(*) AS count
       FROM model_training_artifacts
       WHERE domain = ?`,
      [domain]
    );
    const defaultModel = await getDefaultModel(db, domain);
    const activeModel = await db.get(
      `SELECT domain, model_key, run_id, target, model_type, validation_auc, test_auc, activated_at, note, updated_at
       FROM model_training_active_models
       WHERE domain = ?`,
      [domain]
    );
    const coveredTradeDate = domain === 'stock' || domain === 'etf'
      ? await getLatestCoveredTradeDate(db, { assetTypes: [domain] })
      : null;
    const candidateScoreFreshness = activeModel
      ? await db.get(
        `SELECT MAX(COALESCE(as_of_trade_date, trade_date)) AS latest_trade_date, COUNT(*) AS count
         FROM model_training_candidate_scores
         WHERE domain = ?
           AND model_key = ?
           AND COALESCE(model_run_id, -1) = COALESCE(?, -1)`,
        [domain, activeModel.model_key, activeModel.run_id ?? null]
      )
      : await db.get(
        `SELECT MAX(COALESCE(as_of_trade_date, trade_date)) AS latest_trade_date, COUNT(*) AS count
         FROM model_training_candidate_scores
         WHERE domain = ?`,
        [domain]
      );
    const ruleRows = await db.get(
      `SELECT COUNT(*) AS count
       FROM model_training_rule_candidates
       WHERE domain = ?`,
      [domain]
    );
    const completedRunsRow = await db.get(
      `SELECT COUNT(*) AS count
       FROM model_training_runs
       WHERE domain = ? AND status = 'completed'`,
      [domain]
    );
    const modelsCount = Number(modelsRow?.count || 0);
    const candidateScoresFresh = !coveredTradeDate || candidateScoreFreshness?.latest_trade_date === coveredTradeDate;
    const candidateScoreCount = candidateScoresFresh ? Number(candidateScoreFreshness?.count || 0) : 0;
    const ruleCount = Number(ruleRows?.count || 0);
    const completedRunCount = Number(completedRunsRow?.count || 0);

    const stages = [
      {
        key: 'explain_results',
        order: 1,
        title: '训练结果解释',
        status: modelsCount > 0 ? 'completed' : 'pending',
        summary: modelsCount > 0 ? `已有 ${modelsCount} 个模型结果，可解释最新登记模型。` : '等待模型落库。',
        nextAction: modelsCount > 0 ? '查看指标、特征权重和规则候选。' : '先执行训练流水线。'
      },
      {
        key: 'attach_candidates',
        order: 2,
        title: '当前候选接模型概率',
        status: !candidateScoresFresh ? 'ready' : candidateScoreCount > 0 ? 'completed' : (modelsCount > 0 ? 'ready' : 'pending'),
        summary: !candidateScoresFresh
          ? `候选模型快照滞后：最新评分日 ${candidateScoreFreshness?.latest_trade_date || '无'}，当前覆盖交易日 ${coveredTradeDate}。`
          : candidateScoreCount > 0 ? `已同步 ${candidateScoreCount} 条候选模型快照。` : '候选池还没有模型概率快照。',
        nextAction: !candidateScoresFresh
          ? '先补齐模型特征或重新同步候选分数，避免旧评分误导。'
          : candidateScoreCount > 0 ? '对比模型认可、规则残留和冲突项。' : '点击同步候选模型分数。'
      },
      {
        key: 'review_conflicts',
        order: 3,
        title: '规则 vs 模型复盘样本池',
        status: ruleCount > 0 ? 'completed' : (modelsCount > 0 ? 'ready' : 'pending'),
        summary: ruleCount > 0 ? `已有 ${ruleCount} 条规则候选/回测切片。` : '还没有规则候选和失败样本切片。',
        nextAction: ruleCount > 0 ? '生成复盘驾驶舱，查看冲突样本。' : '先完成随机森林/LightGBM和回测落库。'
      },
      {
        key: 'compare_versions',
        order: 4,
        title: '训练版本对比',
        status: completedRunCount >= 2 ? 'completed' : (completedRunCount === 1 ? 'ready' : 'pending'),
        summary: completedRunCount >= 2 ? `可比较 ${completedRunCount} 个完成版本。` : `当前完成版本 ${completedRunCount} 个。`,
        nextAction: completedRunCount >= 2 ? '查看新旧版本提升来自哪里。' : '下一轮数据更新后再跑一个版本。'
      },
      {
        key: 'activate_model',
        order: 5,
        title: '定期训练 + 手动启用',
        status: activeModel ? 'completed' : (defaultModel ? 'ready' : 'pending'),
        summary: activeModel ? `当前启用 ${activeModel.model_key} / run-${activeModel.run_id || '-'}` : '还没有手动启用的模型。',
        nextAction: activeModel ? '后续新模型只做对比，确认后再手动替换。' : '选择最新模型并手动设为当前启用版本。'
      }
    ];

    res.json({
      success: true,
      data: {
        domain,
        domainLabel: domainLabels[domain],
        defaultModel: defaultModel ? {
          ...defaultModel,
          sample_limits: parseJson(defaultModel.sample_limits_json, null)
        } : null,
        activeModel: activeModel || null,
        coveredTradeDate,
        candidateScoreFreshness: {
          latest_trade_date: candidateScoreFreshness?.latest_trade_date || null,
          rows: Number(candidateScoreFreshness?.count || 0),
          status: candidateScoresFresh ? 'fresh' : 'stale',
          message: candidateScoresFresh
            ? '候选模型分数与当前覆盖交易日一致。'
            : `候选模型分数滞后：最新评分日 ${candidateScoreFreshness?.latest_trade_date || '无'}，当前覆盖交易日 ${coveredTradeDate}。`
        },
        stages
      }
    });
  } catch (error) {
    console.error('Error getting five-stage model status:', error);
    res.status(500).json({ success: false, message: '获取五阶段训练状态失败' });
  }
});

router.get('/candidates/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    const modelKey = typeof req.query.modelKey === 'string' ? req.query.modelKey : undefined;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;
    const top = typeof req.query.top === 'string' ? Number(req.query.top) : undefined;

    if (!domainLabels[domain]) {
      return res.status(400).json({ success: false, message: '不支持的训练域' });
    }
    if (domain === 'football') {
      return res.status(400).json({ success: false, message: '足彩候选扫描还未接入盘口模型' });
    }

    await fs.access(trainingPython);
    const coveredTradeDate = await getLatestCoveredTradeDate(await getDb(), { assetTypes: [domain] });
    const data = await runCandidateScanWorker(domain, modelKey, limit, top, coveredTradeDate);
    res.json({ success: true, data: { ...data, coveredTradeDate } });
  } catch (error) {
    console.error('Error scanning model candidates:', error);
    res.status(500).json({
      success: false,
      message: `候选扫描失败：${error instanceof Error ? error.message : String(error)}`
    });
  }
});

router.get('/review-dashboard/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    const modelKey = typeof req.query.modelKey === 'string' ? req.query.modelKey : undefined;
    const sampleLimit = typeof req.query.sampleLimit === 'string' ? Number(req.query.sampleLimit) : undefined;
    const top = typeof req.query.top === 'string' ? Number(req.query.top) : undefined;

    if (!domainLabels[domain]) {
      return res.status(400).json({ success: false, message: '不支持的训练域' });
    }
    if (domain === 'football') {
      return res.status(400).json({ success: false, message: '足彩复盘驾驶舱还未接入盘口模型' });
    }

    await fs.access(trainingPython);
    const data = await runReviewDashboardWorker(domain, modelKey, sampleLimit, top);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error building model review dashboard:', error);
    res.status(500).json({
      success: false,
      message: `复盘驾驶舱生成失败：${error instanceof Error ? error.message : String(error)}`
    });
  }
});

router.get('/compare-runs/:domain', async (req, res) => {
  try {
    const { domain } = req.params;
    const limit = typeof req.query.limit === 'string' ? Number(req.query.limit) : undefined;

    if (!domainLabels[domain]) {
      return res.status(400).json({ success: false, message: '不支持的训练域' });
    }
    if (domain === 'football') {
      return res.status(400).json({ success: false, message: '足彩版本对比还未接入盘口模型' });
    }

    const db = await getDb();
    const data = await buildCompareRunsFromLocalFiles(db, domain, limit || 8);
    res.json({ success: true, data });
  } catch (error) {
    console.error('Error comparing model training runs:', error);
    res.status(500).json({
      success: false,
      message: `训练版本对比失败：${error instanceof Error ? error.message : String(error)}`
    });
  }
});

router.get('/predict/:domain/:symbol', async (req, res) => {
  try {
    const { domain, symbol } = req.params;
    const modelKey = typeof req.query.modelKey === 'string' ? req.query.modelKey : undefined;
    const tradeDate = typeof req.query.tradeDate === 'string' ? req.query.tradeDate : undefined;

    if (!domainLabels[domain]) {
      return res.status(400).json({ success: false, message: '不支持的训练域' });
    }
    if (domain === 'football') {
      return res.status(400).json({ success: false, message: '足彩预测接口还未接入盘口模型' });
    }

    await fs.access(trainingPython);
    const coveredTradeDate = domain === 'stock' || domain === 'etf'
      ? await getLatestCoveredTradeDate(await getDb(), { assetTypes: [domain] })
      : null;
    const effectiveTradeDate = tradeDate || coveredTradeDate || undefined;
    const data = await runPredictionWorker(domain, symbol, modelKey, effectiveTradeDate);
    res.json({ success: true, data: { ...data, coveredTradeDate } });
  } catch (error) {
    console.error('Error running model prediction:', error);
    res.status(500).json({
      success: false,
      message: `模型预测失败：${error instanceof Error ? error.message : String(error)}`
    });
  }
});

router.post('/run/:domain', async (req, res) => {
  try {
    const db = await getDb();
    const { domain } = req.params;

    if (!domainLabels[domain]) {
      return res.status(400).json({ success: false, message: '不支持的训练域' });
    }

    const existingRunningRun = await db.get(
      `SELECT * FROM model_training_runs
       WHERE domain = ? AND status = 'running'
       ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
       LIMIT 1`,
      [domain]
    );
    if (existingRunningRun) {
      return res.json({ success: true, data: existingRunningRun, message: '已有训练任务运行中' });
    }

    await fs.mkdir(trainingRoot, { recursive: true });
    await fs.access(trainingRoot);
    await fs.access(trainingPython);

    const nextItem = getFirstPlanItem();
    if (!nextItem) {
      return res.json({ success: true, data: null, message: '训练计划为空，无法启动' });
    }

    const now = new Date().toISOString();
    const runInsert = await db.run(
      `INSERT INTO model_training_runs (domain, status, output_dir, current_item_key, message, started_at, created_at, updated_at)
       VALUES (?, 'running', '', ?, ?, ?, ?, ?)`,
      [domain, nextItem.item_key, `流水线启动，当前步骤：${nextItem.title}`, now, now, now]
    );
    if (!runInsert.lastID) {
      throw new Error('创建训练运行记录失败');
    }
    const runId = runInsert.lastID;

    const outputDir = path.join(trainingRoot, domain, `run-${runId}`);
    await fs.mkdir(outputDir, { recursive: true });

    let sourceRowCount = 0;
    if (domain === 'stock' || domain === 'etf') {
      const row = await db.get(
        `SELECT COUNT(*) AS count FROM financial_daily_prices
         WHERE asset_type = ? AND close IS NOT NULL AND close > 0 AND trade_date IS NOT NULL`,
        [domain]
      );
      sourceRowCount = Number(row?.count || 0);
    } else if (domain === 'football') {
      const row = await db.get('SELECT COUNT(*) AS count FROM football_matches WHERE is_deleted = 0');
      sourceRowCount = Number(row?.count || 0);
    }

    const manifest = {
      runId: runInsert.lastID,
      domain,
      domainLabel: domainLabels[domain],
      currentItemKey: nextItem.item_key,
      currentItemTitle: nextItem.title,
      sourceRowCount,
      outputDir,
      startedAt: now,
      note: '训练产物统一写入 7100 外接盘。流水线会按计划顺序自动推进，失败时停在失败步骤；后续数据增加时，可重新启动训练生成新 run。'
    };
    await fs.writeFile(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    await db.run(
      `UPDATE model_training_runs
       SET output_dir = ?, source_row_count = ?, updated_at = ?
       WHERE id = ?`,
      [outputDir, sourceRowCount, now, runId]
    );

    await seedRunPlan(db, runId, domain, nextItem.item_key, `训练运行目录：${outputDir}；源数据行数：${sourceRowCount}`);

    const run = await db.get('SELECT * FROM model_training_runs WHERE id = ?', [runId]);
    startPipelineWorker(runId, domain, outputDir);
    res.json({ success: true, data: run, message: '训练任务已启动' });
  } catch (error) {
    console.error('Error starting model training:', error);
    res.status(500).json({
      success: false,
      message: `启动训练失败：${error instanceof Error ? error.message : String(error)}`
    });
  }
});

router.patch('/plan/:domain/:itemKey', async (req, res) => {
  try {
    const db = await getDb();
    const { domain, itemKey } = req.params;
    const { status, note } = req.body;

    if (!domainLabels[domain]) {
      return res.status(400).json({ success: false, message: '不支持的训练域' });
    }
    if (!['pending', 'running', 'completed', 'failed'].includes(status)) {
      return res.status(400).json({ success: false, message: '不支持的训练状态' });
    }

    const now = new Date().toISOString();
    const completedAt = status === 'completed' ? now : null;
    const latestRun = await db.get(
      `SELECT id
       FROM model_training_runs
       WHERE domain = ?
       ORDER BY datetime(REPLACE(started_at, 'T', ' ')) DESC, id DESC
       LIMIT 1`,
      [domain]
    );
    let useRunPlan = false;
    let result = latestRun
      ? await db.run(
        `UPDATE model_training_run_plan_items
         SET status = ?, note = COALESCE(?, note), completed_at = ?, updated_at = ?
         WHERE run_id = ? AND domain = ? AND item_key = ?`,
        [status, note ?? null, completedAt, now, latestRun.id, domain, itemKey]
      )
      : { changes: 0 };

    if (result.changes) {
      useRunPlan = true;
    } else {
      result = await db.run(
        `UPDATE model_training_plan_items
         SET status = ?, note = COALESCE(?, note), completed_at = ?, updated_at = ?
         WHERE domain = ? AND item_key = ?`,
        [status, note ?? null, completedAt, now, domain, itemKey]
      );
    }

    if (!result.changes) {
      return res.status(404).json({ success: false, message: '训练计划项不存在' });
    }

    const item = useRunPlan
      ? await db.get(
        `SELECT id, run_id, domain, item_key, stage, title, description, status, sort_order, completed_at, note, updated_at
         FROM model_training_run_plan_items
         WHERE run_id = ? AND domain = ? AND item_key = ?`,
        [latestRun.id, domain, itemKey]
      )
      : await db.get(
        `SELECT id, NULL AS run_id, domain, item_key, stage, title, description, status, sort_order, completed_at, note, updated_at
         FROM model_training_plan_items
         WHERE domain = ? AND item_key = ?`,
        [domain, itemKey]
      );
    res.json({ success: true, data: item });
  } catch (error) {
    console.error('Error updating model training plan:', error);
    res.status(500).json({ success: false, message: '更新模型训练计划失败' });
  }
});

export default router;
