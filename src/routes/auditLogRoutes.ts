import express from "express";
import {
  businessWorkspaceCenterServices,
  type AuditLogInput,
  type ScopedWorkspaceAuditService
} from "../services/workspaceCenterScopedServices";
import { getWorkspaceCenterStatusCode } from "../services/workspaceCenterErrors";

export const createAuditLogRoutes = (
  auditService: ScopedWorkspaceAuditService = businessWorkspaceCenterServices.audit
) => {
const router = express.Router();

router.get("/audit-logs", async (req, res) => {
  try {
    const data = await auditService.listAuditLogs({
      module: req.query.module,
      action: req.query.action,
      status: req.query.status,
      limit: req.query.limit
    });
    res.json({ success: true, data });
  } catch (error) {
    console.error("Error fetching audit logs:", error);
    res.status(getWorkspaceCenterStatusCode(error)).json({ success: false, message: "获取审计日志失败" });
  }
});

router.post("/audit-logs", async (req, res) => {
  try {
    const data = await auditService.createAuditLog(req.body || {});
    res.json({ success: true, data });
  } catch (error) {
    console.error("Error creating audit log:", error);
    res.status(getWorkspaceCenterStatusCode(error)).json({
      success: false,
      message: (error as Error).message || "写入审计日志失败"
    });
  }
});

router.post("/audit-logs/bulk", async (req, res) => {
  try {
    const entries = Array.isArray(req.body?.logs) ? req.body.logs as AuditLogInput[] : [];
    const data = await auditService.createAuditLogs(entries);
    res.json({ success: true, data });
  } catch (error) {
    console.error("Error bulk creating audit logs:", error);
    res.status(getWorkspaceCenterStatusCode(error)).json({
      success: false,
      message: (error as Error).message || "批量写入审计日志失败"
    });
  }
});

return router;
};

export default createAuditLogRoutes();
