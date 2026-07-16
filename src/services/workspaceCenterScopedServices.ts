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
  getTaskCenterHealth as getTaskCenterHealthBase,
  getTaskCenterRun as getTaskCenterRunBase,
  getTaskCenterSnapshot as getTaskCenterSnapshotBase,
  getTaskCenterTask as getTaskCenterTaskBase,
  updateTaskCenterTask as updateTaskCenterTaskBase
} from "./workspaceTaskCenterService";

const CURRENT_WORKSPACE = "business" as const;

const withCurrentWorkspaceBody = <T extends Record<string, any>>(body: T = {} as T) => ({
  ...body,
  workspace: CURRENT_WORKSPACE
});

const withCurrentWorkspaceAuditLog = (body: AuditLogInput = {}): AuditLogInput => ({
  ...body,
  workspace: CURRENT_WORKSPACE
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
  listEntityTags(options: Record<string, any>): Promise<any[]>;
  setEntityTags(entityType: string, entityId: string, body: Record<string, any>): Promise<any>;
}

export interface ScopedWorkspaceTaskCenterService {
  getTaskCenterSnapshot(compactInput: unknown): Promise<any>;
  getTaskCenterHealth(): Promise<any>;
  getTaskCenterRun(id: string): Promise<any>;
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

export const businessWorkspaceCenterServices: ScopedWorkspaceCenterServices = {
  todo: {
    getTodoCenterData: () => getTodoCenterDataBase(CURRENT_WORKSPACE),
    listManualTodos: () => listManualTodosBase(CURRENT_WORKSPACE),
    getManualTodo: (id) => getManualTodoBase(id, CURRENT_WORKSPACE),
    createManualTodo: (body) => createManualTodoBase(withCurrentWorkspaceBody(body)),
    updateManualTodo: (id, body) => updateManualTodoBase(id, withCurrentWorkspaceBody(body), CURRENT_WORKSPACE),
    deleteManualTodo: (id) => deleteManualTodoBase(id, CURRENT_WORKSPACE)
  },
  audit: {
    listAuditLogs: (options) => listAuditLogsBase({ ...options, workspace: CURRENT_WORKSPACE }),
    createAuditLog: (body) => createAuditLogBase(withCurrentWorkspaceAuditLog(body)),
    createAuditLogs: (entries) => createAuditLogsBase(entries.map(withCurrentWorkspaceAuditLog))
  },
  tag: {
    listWorkspaceTags: () => listWorkspaceTagsBase(CURRENT_WORKSPACE),
    createWorkspaceTag: (body) => createWorkspaceTagBase(withCurrentWorkspaceBody(body)),
    updateWorkspaceTag: (id, body) => updateWorkspaceTagBase(id, withCurrentWorkspaceBody(body)),
    deleteWorkspaceTag: (id) => deleteWorkspaceTagBase(id, CURRENT_WORKSPACE),
    listEntityTags: async (options) => {
      const { listEntityTags } = await import("./workspaceTagService");
      return listEntityTags({ ...options, workspace: CURRENT_WORKSPACE });
    },
    setEntityTags: async (entityType, entityId, body) => {
      const { setEntityTags } = await import("./workspaceTagService");
      return setEntityTags(entityType, entityId, withCurrentWorkspaceBody(body));
    }
  },
  taskCenter: {
    getTaskCenterSnapshot: (compactInput) => getTaskCenterSnapshotBase(CURRENT_WORKSPACE, compactInput),
    getTaskCenterHealth: () => getTaskCenterHealthBase(CURRENT_WORKSPACE),
    getTaskCenterRun: (id) => getTaskCenterRunBase(id, CURRENT_WORKSPACE),
    getTaskCenterTask: (id) => getTaskCenterTaskBase(id, CURRENT_WORKSPACE),
    updateTaskCenterTask: (id, body) => updateTaskCenterTaskBase(id, withCurrentWorkspaceBody(body), CURRENT_WORKSPACE),
    deleteTaskCenterTask: (id) => deleteTaskCenterTaskBase(id, CURRENT_WORKSPACE)
  }
};

export type { AuditLogInput };
