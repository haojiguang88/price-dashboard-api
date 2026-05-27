import type { WorkspaceKey } from "../utils/workspace";
import {
  createManualTodo as createManualTodoBase,
  deleteManualTodo as deleteManualTodoBase,
  getManualTodo as getManualTodoBase,
  getTodoCenterData as getTodoCenterDataBase,
  listManualTodos as listManualTodosBase,
  updateManualTodo as updateManualTodoBase
} from "./workspaceTodoService";
import {
  createAuditLog as createAuditLogBase,
  createAuditLogs as createAuditLogsBase,
  listAuditLogs as listAuditLogsBase,
  type AuditLogInput
} from "./workspaceAuditService";
import {
  createWorkspaceTag as createWorkspaceTagBase,
  deleteWorkspaceTag as deleteWorkspaceTagBase,
  listWorkspaceTags as listWorkspaceTagsBase,
  updateWorkspaceTag as updateWorkspaceTagBase
} from "./workspaceTagService";
import {
  deleteTaskCenterTask as deleteTaskCenterTaskBase,
  getTaskCenterSnapshot as getTaskCenterSnapshotBase,
  getTaskCenterTask as getTaskCenterTaskBase,
  updateTaskCenterTask as updateTaskCenterTaskBase
} from "./workspaceTaskCenterService";

const withWorkspaceBody = <T extends Record<string, any>>(workspace: WorkspaceKey, body: T = {} as T) => ({
  ...body,
  workspace
});

const withWorkspaceAuditLog = (workspace: WorkspaceKey, body: AuditLogInput = {}): AuditLogInput => ({
  ...body,
  workspace
});

export interface ScopedWorkspaceTodoService {
  getTodoCenterData(): Promise<any>;
  listManualTodos(): Promise<any[]>;
  getManualTodo(id: string): Promise<any>;
  createManualTodo(body: Record<string, any>): Promise<any>;
  updateManualTodo(id: string, body: Record<string, any>): Promise<any>;
  deleteManualTodo(id: string): Promise<any>;
}

export interface ScopedWorkspaceAuditService {
  listAuditLogs(options: Omit<Parameters<typeof listAuditLogsBase>[0], "workspace">): Promise<any[]>;
  createAuditLog(body: AuditLogInput): Promise<any>;
  createAuditLogs(entries: AuditLogInput[]): Promise<any[]>;
}

export interface ScopedWorkspaceTagService {
  listWorkspaceTags(): Promise<any[]>;
  createWorkspaceTag(body: Record<string, any>): Promise<any>;
  updateWorkspaceTag(id: string, body: Record<string, any>): Promise<any>;
  deleteWorkspaceTag(id: string): Promise<any>;
}

export interface ScopedWorkspaceTaskCenterService {
  getTaskCenterSnapshot(compactInput: unknown): Promise<any>;
  getTaskCenterTask(id: string): Promise<any>;
  updateTaskCenterTask(id: string, body: Record<string, any>): Promise<any>;
  deleteTaskCenterTask(id: string): Promise<any>;
}

export interface ScopedWorkspaceCenterServices {
  todo: ScopedWorkspaceTodoService;
  audit: ScopedWorkspaceAuditService;
  tag: ScopedWorkspaceTagService;
  taskCenter: ScopedWorkspaceTaskCenterService;
}

export const createWorkspaceTodoService = (workspace: WorkspaceKey): ScopedWorkspaceTodoService => ({
  getTodoCenterData: () => getTodoCenterDataBase(workspace),
  listManualTodos: () => listManualTodosBase(workspace),
  getManualTodo: (id) => getManualTodoBase(id, workspace),
  createManualTodo: (body) => createManualTodoBase(withWorkspaceBody(workspace, body)),
  updateManualTodo: (id, body) => updateManualTodoBase(id, withWorkspaceBody(workspace, body), workspace),
  deleteManualTodo: (id) => deleteManualTodoBase(id, workspace)
});

export const createWorkspaceAuditService = (workspace: WorkspaceKey): ScopedWorkspaceAuditService => ({
  listAuditLogs: (options) => listAuditLogsBase({ ...options, workspace }),
  createAuditLog: (body) => createAuditLogBase(withWorkspaceAuditLog(workspace, body)),
  createAuditLogs: (entries) => createAuditLogsBase(entries.map((entry) => withWorkspaceAuditLog(workspace, entry)))
});

export const createWorkspaceTagService = (workspace: WorkspaceKey): ScopedWorkspaceTagService => ({
  listWorkspaceTags: () => listWorkspaceTagsBase(workspace),
  createWorkspaceTag: (body) => createWorkspaceTagBase(withWorkspaceBody(workspace, body)),
  updateWorkspaceTag: (id, body) => updateWorkspaceTagBase(id, withWorkspaceBody(workspace, body)),
  deleteWorkspaceTag: (id) => deleteWorkspaceTagBase(id, workspace)
});

export const createWorkspaceTaskCenterService = (workspace: WorkspaceKey): ScopedWorkspaceTaskCenterService => ({
  getTaskCenterSnapshot: (compactInput) => getTaskCenterSnapshotBase(workspace, compactInput),
  getTaskCenterTask: (id) => getTaskCenterTaskBase(id, workspace),
  updateTaskCenterTask: (id, body) => updateTaskCenterTaskBase(id, withWorkspaceBody(workspace, body), workspace),
  deleteTaskCenterTask: (id) => deleteTaskCenterTaskBase(id, workspace)
});

export const createWorkspaceCenterServices = (workspace: WorkspaceKey): ScopedWorkspaceCenterServices => ({
  todo: createWorkspaceTodoService(workspace),
  audit: createWorkspaceAuditService(workspace),
  tag: createWorkspaceTagService(workspace),
  taskCenter: createWorkspaceTaskCenterService(workspace)
});

export const businessWorkspaceCenterServices = createWorkspaceCenterServices("business");

export type { AuditLogInput };
