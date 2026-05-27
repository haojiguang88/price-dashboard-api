import type { Express } from "express";
import { registerBusinessRoutes } from "./businessRouteRegistry";
import { registerWorkspaceCenterRoutes } from "./workspaceCenterRouteRegistry";
import { registerPlatformRoutes } from "./platformRouteRegistry";

export const registerApiRoutes = (app: Express) => {
  registerBusinessRoutes(app);
  registerWorkspaceCenterRoutes(app);
  registerPlatformRoutes(app);
};
