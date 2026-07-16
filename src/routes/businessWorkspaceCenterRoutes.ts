import express from "express";
import { businessWorkspaceCenterServices } from "../services/workspaceCenterScopedServices";
import { createAuditLogRoutes } from "./auditLogRoutes";
import { createTagSystemRoutes } from "./tagSystemRoutes";
import { createTaskCenterRoutes } from "./taskCenterRoutes";
import { createTodoCenterRoutes } from "./todoCenterRoutes";
import auditCenterRoutes from "./auditCenterRoutes";

const businessWorkspaceCenterRoutes = express.Router();
businessWorkspaceCenterRoutes.use(createTodoCenterRoutes(businessWorkspaceCenterServices.todo));
businessWorkspaceCenterRoutes.use(createTaskCenterRoutes(businessWorkspaceCenterServices.taskCenter));
businessWorkspaceCenterRoutes.use(createAuditLogRoutes(businessWorkspaceCenterServices.audit));
businessWorkspaceCenterRoutes.use(createTagSystemRoutes(businessWorkspaceCenterServices.tag));
businessWorkspaceCenterRoutes.use(auditCenterRoutes);

export default businessWorkspaceCenterRoutes;
