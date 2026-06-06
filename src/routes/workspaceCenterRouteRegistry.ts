import type { Express } from "express";
import businessWorkspaceCenterRoutes from "./businessWorkspaceCenterRoutes";
import { businessWorkspaceCenterServices } from "../services/workspaceCenterScopedServices";
import { createTaskCenterRoutes } from "./taskCenterRoutes";

export const registerWorkspaceCenterRoutes = (app: Express) => {
  app.use("/api/business", businessWorkspaceCenterRoutes);
  // Legacy alias for manual curl/scripts that used /api/task-center before workspace scoping.
  app.use("/api", createTaskCenterRoutes(businessWorkspaceCenterServices.taskCenter));
};
