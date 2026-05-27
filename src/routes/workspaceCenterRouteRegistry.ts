import type { Express } from "express";
import businessWorkspaceCenterRoutes from "./businessWorkspaceCenterRoutes";

export const registerWorkspaceCenterRoutes = (app: Express) => {
  app.use("/api/business", businessWorkspaceCenterRoutes);
};
