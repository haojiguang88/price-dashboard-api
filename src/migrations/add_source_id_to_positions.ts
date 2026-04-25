// 为 positions 表添加 source_id 字段的迁移
const migration = {
  id: '20260425_002',
  name: 'Add source_id to positions table',
  sql: `
    -- 为 positions 表添加 source_id 字段
    ALTER TABLE positions ADD COLUMN source_id TEXT;
  `
};

export default migration;