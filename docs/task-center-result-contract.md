# 任务中心结果契约（生意抓数）

日常主路径是：定时/手动执行 → Python 脚本 → 写 `price_records` / 行情锚点 → 任务健康与新鲜度展示。  
本契约区分「脚本是否跑完」和「是否写出有效数据」，避免「成功但 0 更新」被当成数据新鲜。

## 两层状态

| 字段 | 含义 | 典型来源 |
|---|---|---|
| `run_status` | 进程结果：脚本是否正常结束 | `task_center_runs.status`：`success` / `skipped` / `error` / `running` |
| `data_status` | 数据结果：本次是否有效写入或暴露缺口 | 从 `result_json` 汇总，见下表 |

健康页应同时展示两者。新鲜度**只看上次 `data_status = updated` 的时间**，不看单纯的 `success` / `skipped`。

## 脚本 stdout JSON（业务任务）

脚本最后一行输出 JSON 对象（任务中心解析 stdout）。推荐字段：

```json
{
  "status": "success",
  "message": "人类可读摘要",
  "inserted_count": 0,
  "updated_count": 0,
  "skipped_count": 0,
  "source_count": 0,
  "matched_count": 0,
  "filtered_count": 0,
  "unmapped_enabled_objects": [],
  "missing_source_objects": [],
  "source_errors": []
}
```

约定：

- `status: "skipped"`：按业务规则主动跳过（如非交易日），对应 `run_status=skipped`。
- 计数优先用 `*_count` 蛇形字段；兼容 `inserted` / `updatedCount` 等别名（由 `summarizeTaskRunPayload` 归一）。
- 主备源可嵌套 `primary` / `backup` / `steps[].data`；汇总会向下合并。
- 任务中心落库时会再写入：`run_status`、`data_status`、`data_summary`（不要在脚本里依赖这些字段作为输入）。

## `data_status` 判定（权威实现：`summarizeTaskRunPayload`）

按优先级：

1. `source_error`：`source_errors` / `failed_*` 等 > 0  
2. `updated`：`inserted_count + updated_count > 0`  
3. `mapping_gap`：未映射 / 缺来源对象等 > 0  
4. `no_change`：有来源或匹配/跳过/过滤痕迹，但无新增更新（常见：源站未变价）  
5. `no_source_data`：有 payload 但无上述任何有效信号  
6. `unknown`：无 payload  

## 健康态如何读（抓数巡检）

| 现象 | 含义 | 建议动作 |
|---|---|---|
| `run_status=success` + `data_status=updated` | 正常写入 | 无 |
| `run_status=success` + `data_status=no_change` | 跑通但无新价 | 看源站是否停更；新鲜度会按上次写入老化 |
| `data_status=no_source_data` / `source_error` | 抓取失败或空页 | 查脚本日志 / Cookie / 源站 |
| `data_status=mapping_gap` | 有货未映射 | 去数据源映射补全 |
| 新鲜度 `stale` / 健康 `stale_data` | 长期无有效写入 | 优先怀疑源站或映射，不是「任务没跑」 |
| `run_status=skipped` | 规则跳过 | 不算写入；不刷新新鲜度 |

## 相关代码

- 汇总：`src/services/workspaceTaskCenterService.ts` → `summarizeTaskRunPayload`
- 落库信封：`src/routes/taskCenterRoutes.ts`（写入 `run_status` / `data_status`）
- Python 解释器与子进程 env：`src/utils/taskExecutionEnv.ts`（禁止 `config.python`）
- 断言：`tests/task-center-contract.test.ts`、`tests/task-center-summary.test.ts`
