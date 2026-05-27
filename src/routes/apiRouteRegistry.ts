import type { Express } from "express";
import { registerBusinessRoutes } from "./businessRouteRegistry";
import { registerWorkspaceCenterRoutes } from "./workspaceCenterRouteRegistry";
import { registerAppSupportRoutes } from "./appSupportRouteRegistry";

export const registerApiRoutes = (app: Express) => {
  registerBusinessRoutes(app);
  registerWorkspaceCenterRoutes(app);
  registerAppSupportRoutes(app);
};
