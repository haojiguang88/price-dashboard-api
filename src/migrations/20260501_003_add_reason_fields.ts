// 趋势阶段结果表添加 reason_code 和 reason_details 字段
export const migration = {
  id: '20260501_003',
  name: 'Add reason_code and reason_details fields to trend phase results',
  sql: `
    -- 添加 reason_code 字段
    ALTER TABLE financial_trend_phase_results 
    ADD COLUMN reason_code TEXT;
    
    -- 添加 reason_details 字段
    ALTER TABLE financial_trend_phase_results 
    ADD COLUMN reason_details TEXT;
  `
};

export default migration;
