import type { RequestHandler } from "express";
import {
  closeRequestDatabaseContext,
  createRequestDatabaseContext,
  runWithRequestDatabaseContext
} from "../config/database";

export const requestDatabaseContextMiddleware: RequestHandler = (_req, res, next) => {
  const context = createRequestDatabaseContext();
  let cleanupStarted = false;
  const cleanup = () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    void closeRequestDatabaseContext(context).catch(error => {
      console.error("Failed to close request database connection", error);
    });
  };

  res.once("finish", cleanup);
  res.once("close", cleanup);
  runWithRequestDatabaseContext(context, next);
};
