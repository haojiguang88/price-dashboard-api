import type { Express } from "express";
import { registerBusinessRoutes } from "./businessRouteRegistry";
import { registerWorkspaceCenterRoutes } from "./workspaceCenterRouteRegistry";
import { registerSharedRoutes } from "./sharedRouteRegistry";

export const registerApiRoutes = (app: Express) => {
  registerBusinessRoutes(app);
  registerWorkspaceCenterRoutes(app);
  registerSharedRoutes(app);
};
