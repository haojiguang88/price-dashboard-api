import express from "express";
import {
  businessWorkspaceCenterServices,
  type ScopedWorkspaceTagService
} from "../services/workspaceCenterScopedServices";
import { getWorkspaceCenterStatusCode } from "../services/workspaceCenterErrors";

export const createTagSystemRoutes = (
  tagService: ScopedWorkspaceTagService = businessWorkspaceCenterServices.tag
) => {
const router = express.Router();

router.get("/tags", async (req, res) => {
  try {
    const data = await tagService.listWorkspaceTags();
    res.json({ success: true, data, message: "获取标签成功" });
  } catch (error) {
    res.status(getWorkspaceCenterStatusCode(error)).json({
      success: false,
      message: (error as Error).message || "获取标签失败"
    });
  }
});

router.post("/tags", async (req, res) => {
  try {
    const data = await tagService.createWorkspaceTag(req.body || {});
    res.json({ success: true, data, message: "新增标签成功" });
  } catch (error) {
    res.status(getWorkspaceCenterStatusCode(error)).json({
      success: false,
      message: (error as Error).message || "新增标签失败"
    });
  }
});

router.put("/tags/:id", async (req, res) => {
  try {
    const data = await tagService.updateWorkspaceTag(String(req.params.id), req.body || {});
    res.json({ success: true, data, message: "编辑标签成功" });
  } catch (error) {
    res.status(getWorkspaceCenterStatusCode(error)).json({
      success: false,
      message: (error as Error).message || "编辑标签失败"
    });
  }
});

router.delete("/tags/:id", async (req, res) => {
  try {
    const data = await tagService.deleteWorkspaceTag(String(req.params.id));
    res.json({ success: true, data, message: "删除标签成功" });
  } catch (error) {
    res.status(getWorkspaceCenterStatusCode(error)).json({
      success: false,
      message: (error as Error).message || "删除标签失败"
    });
  }
});

return router;
};

export default createTagSystemRoutes();
