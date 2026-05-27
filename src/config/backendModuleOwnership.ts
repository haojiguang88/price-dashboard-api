export type BackendModuleOwner = "business" | "workspace-center" | "shared-platform";

export interface BackendModuleOwnership {
  key: string;
  owner: BackendModuleOwner;
  apiBases: string[];
  routeFiles: string[];
  databaseScope: "business" | "trading" | "workspace-split" | "shared";
  splitTarget: "business-api" | "duplicate-per-app" | "temporary-shared";
  note: string;
}

// Planning metadata for the product split. This file is intentionally not used
// at runtime yet; it is the source of truth for route and database ownership.
export const backendModuleOwnership: readonly BackendModuleOwnership[] = [
  {
    key: "commodity-price-core",
    owner: "business",
    apiBases: ["/api", "/api/dashboard", "/api/monitor-rules", "/api/abnormal-monitor", "/api/volatility-analysis", "/api/elasticity-analysis"],
    routeFiles: [
      "priceRoutes.ts",
      "masterDataRoutes.ts",
      "originalPriceRecordsRoutes.ts",
      "dashboardRoutes.ts",
      "monitorRulesRoutes.ts",
      "abnormalMonitorRoutes.ts",
      "volatilityAnalysisRoutes.ts",
      "elasticityAnalysisRoutes.ts"
    ],
    databaseScope: "business",
    splitTarget: "business-api",
    note: "商品价格、主数据、商品分析和价格异动监控，归原生意系统。"
  },
  {
    key: "business-plan-position-risk",
    owner: "business",
    apiBases: ["/api", "/api/risk"],
    routeFiles: [
      "planRoutes.ts",
      "watchlistRoutes.ts",
      "positionRoutes.ts",
      "endedPositionsRoutes.ts",
      "sellRecordsRoutes.ts",
      "annualPlansRoutes.ts",
      "annualPlanItemsRoutes.ts",
      "annualPlanItemChangesRoutes.ts",
      "riskControlRoutes.ts",
      "followRoutes.ts"
    ],
    databaseScope: "business",
    splitTarget: "business-api",
    note: "生意侧计划、仓位、年度计划、风控和关注状态，不能被交易系统长期依赖。"
  },
  {
    key: "business-review-knowledge",
    owner: "business",
    apiBases: ["/api"],
    routeFiles: [
      "eventRecordsRoutes.ts",
      "opinionRecordsRoutes.ts",
      "missedProjectsRoutes.ts",
      "tradeReviewsRoutes.ts",
      "treeHangingCasesRoutes.ts",
      "marketReviewsRoutes.ts",
      "ruleExperiencesRoutes.ts",
      "rejectedOpportunitiesRoutes.ts",
      "speculationCycleRoutes.ts",
      "productSupplyEventsRoutes.ts",
      "footballLotteryRoutes.ts"
    ],
    databaseScope: "business",
    splitTarget: "business-api",
    note: "认知记录、商品复盘、拒绝机会池和供给时间线，默认留在生意系统。"
  },
  {
    key: "workspace-centers",
    owner: "workspace-center",
    apiBases: [
      "/api/business/todo-center",
      "/api/business/task-center",
      "/api/business/audit-logs",
      "/api/business/tags"
    ],
    routeFiles: [
      "businessWorkspaceCenterRoutes.ts",
      "todoCenterRoutes.ts",
      "taskCenterRoutes.ts",
      "auditLogRoutes.ts",
      "tagSystemRoutes.ts"
    ],
    databaseScope: "workspace-split",
    splitTarget: "duplicate-per-app",
    note: "待办、任务、审计和标签已从泛型 workspace alias 过渡到生意/交易固定 route scope，并通过 workspaceCenterScopedServices 固定 service scope；下一步继续拆物理表边界。"
  },
  {
    key: "shared-platform-preferences",
    owner: "shared-platform",
    apiBases: ["/api/user-preferences", "/api/analysis-annotations"],
    routeFiles: ["userPreferenceRoutes.ts", "analysisAnnotationRoutes.ts"],
    databaseScope: "shared",
    splitTarget: "temporary-shared",
    note: "短期保持平台共享；物理拆分前按 key/module 加前缀或复制成两套表。"
  }
];
