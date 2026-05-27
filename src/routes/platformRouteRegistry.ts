import type { Express } from "express";
import analysisAnnotationRoutes from "./analysisAnnotationRoutes";
import userPreferenceRoutes from "./userPreferenceRoutes";

export const registerPlatformRoutes = (app: Express) => {
  app.use("/api", analysisAnnotationRoutes);
  app.use("/api", userPreferenceRoutes);
};
