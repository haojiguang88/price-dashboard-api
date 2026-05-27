import express from "express";
import {
  businessWorkspaceCenterServices,
  type ScopedWorkspaceTodoService
} from "../services/workspaceCenterScopedServices";
import { getWorkspaceCenterStatusCode } from "../services/workspaceCenterErrors";

export const createTodoCenterRoutes = (
  todoService: ScopedWorkspaceTodoService = businessWorkspaceCenterServices.todo
) => {
const router = express.Router();

router.get("/todo-center", async (req, res) => {
  try {
    const data = await todoService.getTodoCenterData();
    res.json({ success: true, data, message: "获取待办中心数据成功" });
  } catch (error) {
    res.status(getWorkspaceCenterStatusCode(error)).json({
      success: false,
      message: "获取待办中心数据失败",
      error: (error as Error).message
    });
  }
});

router.get("/manual-todos", async (req, res) => {
  try {
    const todos = await todoService.listManualTodos();
    res.json({ success: true, data: todos, message: "获取手动待办列表成功" });
  } catch (error) {
    res.status(getWorkspaceCenterStatusCode(error)).json({
      success: false,
      message: "获取手动待办列表失败",
      error: (error as Error).message
    });
  }
});

router.get("/manual-todos/:id", async (req, res) => {
  try {
    const todo = await todoService.getManualTodo(String(req.params.id));
    res.json({ success: true, data: todo, message: "获取手动待办详情成功" });
  } catch (error) {
    res.status(getWorkspaceCenterStatusCode(error)).json({
      success: false,
      message: (error as Error).message || "获取手动待办详情失败"
    });
  }
});

router.post("/manual-todos", async (req, res) => {
  try {
    const data = await todoService.createManualTodo(req.body || {});
    res.json({ success: true, data, message: "新增手动待办成功" });
  } catch (error) {
    res.status(getWorkspaceCenterStatusCode(error)).json({
      success: false,
      message: (error as Error).message || "新增手动待办失败"
    });
  }
});

router.put("/manual-todos/:id", async (req, res) => {
  try {
    const data = await todoService.updateManualTodo(String(req.params.id), req.body || {});
    res.json({ success: true, data, message: "编辑手动待办成功" });
  } catch (error) {
    res.status(getWorkspaceCenterStatusCode(error)).json({
      success: false,
      message: (error as Error).message || "编辑手动待办失败"
    });
  }
});

router.delete("/manual-todos/:id", async (req, res) => {
  try {
    const data = await todoService.deleteManualTodo(String(req.params.id));
    res.json({ success: true, data, message: "删除手动待办成功" });
  } catch (error) {
    res.status(getWorkspaceCenterStatusCode(error)).json({
      success: false,
      message: (error as Error).message || "删除手动待办失败"
    });
  }
});

return router;
};

export default createTodoCenterRoutes();
