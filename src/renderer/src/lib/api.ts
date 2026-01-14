// Web API 客户端 - 与数据库表结构对应
// Electron-Web 模式下，需要使用远程服务器地址

import { apiMonitor, errorReporter } from './monitor'

// 401 错误回调（用于自动跳转登录页面）
let onUnauthorized: (() => void) | null = null

/**
 * 设置401错误回调函数
 * @param callback 当收到401响应时调用的回调函数
 */
export function setUnauthorizedCallback(callback: () => void) {
  onUnauthorized = callback
}

// 动态获取 API Base URL（支持 Electron-Web 模式）
const getApiBase = (): string => {
  // 优先使用环境变量配置的 API 地址
  if (import.meta.env.VITE_API_BASE) {
    return import.meta.env.VITE_API_BASE
  }

  // Electron-Web 模式：从 WEB_SERVER_URL 环境变量获取服务器地址
  // 这个变量在页面加载后由 Electron 主进程注入
  if (
    typeof window !== 'undefined' &&
    (window as { __WEB_SERVER_URL__?: string }).__WEB_SERVER_URL__
  ) {
    return (window as { __WEB_SERVER_URL__?: string }).__WEB_SERVER_URL__ + '/api'
  }

  // 默认使用相对路径（纯 Web 模式）
  return '/api'
}

// 检测是否在 Electron 环境
export const isElectron = (): boolean => {
  // 检查是否有 Electron 特有的 API
  // web-adapter 会注入 window.api，但不会有 process 对象
  if (typeof window === 'undefined') return false

  // 方法1: 检查 navigator.userAgent 是否包含 Electron
  if (navigator.userAgent.toLowerCase().includes('electron')) {
    return true
  }

  // 方法2: 检查是否有 Electron 特有的 contextBridge API
  // Electron preload 脚本通过 contextBridge 暴露的 API 会有特殊标记
  if (window.api && typeof window.api.getAppVersion === 'function') {
    // 检查版本号是否包含 'web' 标记（web-adapter 返回 '1.2.7-web'）
    // 这是一个同步检查，我们用一个标记来区分
    const isWebAdapter = (window.api as { __isWebAdapter?: boolean }).__isWebAdapter
    if (isWebAdapter === true) {
      return false
    }
  }

  // 方法3: 检查 window.process 是否存在（Electron 环境特有）
  if ((window as { process?: { type?: string } }).process?.type) {
    return true
  }

  // 默认：如果 window.api 存在但没有 web 标记，假设是 Electron
  return window.api !== undefined && !(window.api as { __isWebAdapter?: boolean }).__isWebAdapter
}

/**
 * 封装 fetch 请求，自动处理401错误和性能监控
 * Electron 和 Web 统一使用密码认证（JWT cookie）
 */
export async function fetchWithAuth(url: string, options?: RequestInit): Promise<Response> {
  const startTime = performance.now()
  
  // 解析端点用于监控
  let endpoint: string
  try {
    const urlObj = new URL(url, window.location.origin)
    endpoint = urlObj.pathname
  } catch {
    endpoint = url
  }
  const method = options?.method || 'GET'

  try {
    const response = await fetch(url, {
      ...options,
      credentials: 'include' // 确保携带 cookie
    })
    
    // 记录API调用性能
    const duration = performance.now() - startTime
    apiMonitor.recordApiCall(
      endpoint,
      method,
      Math.round(duration),
      response.ok,
      response.status
    )
    
    // 慢请求告警（> 3秒）
    if (duration > 3000) {
      console.warn(`[API] Slow request: ${method} ${endpoint} took ${Math.round(duration)}ms`)
    }

    // 检查是否为401未授权错误
    if (response.status === 401) {
      if (onUnauthorized) {
        onUnauthorized()
      }
    }

    return response
  } catch (error) {
    // 记录失败的API调用
    const duration = performance.now() - startTime
    apiMonitor.recordApiCall(
      endpoint,
      method,
      Math.round(duration),
      false
    )
    
    // 记录错误
    errorReporter.captureError(error as Error, {
      endpoint,
      method,
      action: 'api_call'
    })
    
    throw error
  }
}

// 注意：不要在模块顶层缓存 API_BASE，因为 window.__WEB_SERVER_URL__ 是异步注入的
// 每次调用时都动态获取
// const API_BASE = getApiBase() // ❌ 已移除：会在模块加载时缓存

// 账号类型
export interface Account {
  id: string
  email: string
  userId?: string
  nickname?: string
  idp?: string
  status?: string
  isActive?: boolean
  groupId?: string
  tags?: string[]
  createdAt?: number
  lastUsedAt?: number
  lastCheckedAt?: number
  version?: number
  updatedAt?: number
  deletedAt?: number
  isDel?: boolean
  credentials?: {
    accessToken?: string
    csrfToken?: string
    refreshToken?: string
    clientId?: string
    clientSecret?: string
    region?: string
    expiresAt?: number
    authMethod?: string
    provider?: string
  }
  subscription?: {
    type?: string
    title?: string
    rawType?: string
    daysRemaining?: number
    expiresAt?: number
    managementTarget?: string
    upgradeCapability?: string
    overageCapability?: string
  }
  usage?: {
    current?: number
    limit?: number
    percentUsed?: number
    lastUpdated?: number
    baseLimit?: number
    baseCurrent?: number
    freeTrialLimit?: number
    freeTrialCurrent?: number
    freeTrialExpiry?: number // Unix 时间戳（毫秒）
    bonuses?: unknown[]
    nextResetDate?: number // Unix 时间戳（毫秒）
    resourceDetail?: {
      resourceType?: string
      displayName?: string
      displayNamePlural?: string
      currency?: string
      unit?: string
      overageRate?: number
      overageCap?: number
      overageEnabled?: boolean
    }
  }
}

// 分组类型
export interface Group {
  id: string
  name: string
  color: string
  order?: number
  createdAt?: number
  version?: number
  updatedAt?: number
}

// 标签类型
export interface Tag {
  id: string
  name: string
  color: string
  createdAt?: number
  version?: number
  updatedAt?: number
}

// 完整数据类型 (与 account.json 结构一致)
export interface AccountData {
  accounts: Record<string, Account>
  groups: Record<string, Group>
  tags: Record<string, Tag>
  activeAccountId?: string | null
  autoRefreshEnabled?: boolean
  autoRefreshInterval?: number
  statusCheckInterval?: number
  privacyMode?: boolean
  proxyEnabled?: boolean
  proxyUrl?: string
  autoSwitchEnabled?: boolean
  autoSwitchThreshold?: number
  autoSwitchInterval?: number
  theme?: string
  darkMode?: boolean
  machineIdConfig?: {
    autoSwitchOnAccountChange?: boolean
    bindMachineIdToAccount?: boolean
    useBindedMachineId?: boolean
  }
  accountMachineIds?: Record<string, string>
  machineIdHistory?: Array<{
    id: string
    machineId: string
    timestamp: number
    action: string
  }>
}

// ==================== V2 API 类型定义 ====================

// V2 分页响应
export interface V2PaginationInfo {
  page: number
  pageSize: number
  total: number
  totalPages: number
  hasNext: boolean
}

// V2 账号列表响应
export interface V2AccountsListResponse {
  success: boolean
  data?: {
    accounts: Account[]
    pagination: V2PaginationInfo
    serverTime: number
  }
  /** 错误代码，当 success 为 false 时存在 */
  error?: string
  /** 错误消息，当 success 为 false 时存在 */
  message?: string
}

// V2 单个账号响应
export interface V2AccountResponse {
  success: boolean
  data?: Account
  /** 错误代码，当 success 为 false 时存在 */
  error?: string
  /** 错误消息，当 success 为 false 时存在 */
  message?: string
}

// V2 创建/更新响应
export interface V2MutationResponse {
  success: boolean
  data?: {
    id: string
    version: number
    updatedAt: number
    created?: boolean
  }
  /** 错误代码，当 success 为 false 时存在 */
  error?: string
  /** 错误消息，当 success 为 false 时存在 */
  message?: string
}

// V2 删除响应
export interface V2DeleteResponse {
  success: boolean
  data?: {
    id: string
    deleted: boolean
    deletedAt: number
  }
  /** 错误代码，当 success 为 false 时存在 */
  error?: string
  /** 错误消息，当 success 为 false 时存在 */
  message?: string
}

// V2 批量操作请求
export interface V2BatchOperation {
  action: 'create' | 'update' | 'delete'
  data: Partial<Account> & { id: string; version?: number }
}

// V2 批量操作响应
export interface V2BatchResponse {
  success: boolean
  data?: {
    results: Array<{
      id: string
      success: boolean
      version?: number
      error?: string
      currentVersion?: number
    }>
    summary: {
      total: number
      succeeded: number
      failed: number
    }
  }
  /** 错误代码，当 success 为 false 时存在 */
  error?: string
  /** 错误消息，当 success 为 false 时存在 */
  message?: string
}

// V2 同步快照响应
// 注意：settings 已移除，应通过独立的 /api/v2/settings 接口获取
export interface V2SyncSnapshotResponse {
  success: boolean
  data?: {
    accounts: Account[]
    groups: Group[]
    tags: Tag[]
    machineIdBindings?: Array<{ accountId: string; machineId: string }>
    machineIdHistory?: Array<{
      id: string
      machineId: string
      timestamp: number
      action: string
    }>
    serverTime: number
    snapshotVersion: string
  }
  /** 错误代码，当 success 为 false 时存在 */
  error?: string
  /** 错误消息，当 success 为 false 时存在 */
  message?: string
}

// V2 增量变更请求
// 注意：settings 已移除
export interface V2SyncChangesRequest {
  lastSyncTime: number
  resources?: ('accounts' | 'groups' | 'tags')[]
}

// V2 增量变更响应
// 注意：settings 已移除
export interface V2SyncChangesResponse {
  success: boolean
  data?: {
    changes: {
      accounts?: {
        created: Account[]
        updated: Account[]
        deleted: string[]
      }
      groups?: {
        created: Group[]
        updated: Group[]
        deleted: string[]
      }
      tags?: {
        created: Tag[]
        updated: Tag[]
        deleted: string[]
      }
    }
    serverTime: number
    hasMore: boolean
  }
  /** 错误代码，当 success 为 false 时存在 */
  error?: string
  /** 错误消息，当 success 为 false 时存在 */
  message?: string
}

// V2 推送变更请求
export interface V2SyncPushRequest {
  changes: {
    accounts?: {
      created?: Partial<Account>[]
      updated?: (Partial<Account> & { id: string; version: number })[]
      deleted?: string[]
    }
    groups?: {
      created?: Partial<Group>[]
      updated?: (Partial<Group> & { id: string; version: number })[]
      deleted?: string[]
    }
    tags?: {
      created?: Partial<Tag>[]
      updated?: (Partial<Tag> & { id: string; version: number })[]
      deleted?: string[]
    }
    settings?: Record<string, unknown>
  }
  clientTime: number
}

// V2 推送变更响应
export interface V2SyncPushResponse {
  success: boolean
  data?: {
    results: {
      accounts?: {
        succeeded: string[]
        failed: Array<{
          id: string
          error: string
          serverData?: Account
        }>
      }
      groups?: {
        succeeded: string[]
        failed: Array<{
          id: string
          error: string
          serverData?: Group
        }>
      }
      tags?: {
        succeeded: string[]
        failed: Array<{
          id: string
          error: string
          serverData?: Tag
        }>
      }
      settings?: {
        succeeded: string[]
        failed: Array<{
          key: string
          error: string
        }>
      }
    }
    conflicts: Array<{
      resource: string
      id: string
      localVersion: number
      serverVersion: number
      serverData: unknown
    }>
    serverTime: number
  }
  /** 错误代码，当 success 为 false 时存在 */
  error?: string
  /** 错误消息，当 success 为 false 时存在 */
  message?: string
}

// V2 设置响应
export interface V2SettingsResponse {
  success: boolean
  data?: Record<string, unknown>
  /** 错误代码，当 success 为 false 时存在 */
  error?: string
  /** 错误消息，当 success 为 false 时存在 */
  message?: string
}

// V2 单个设置响应
export interface V2SettingResponse {
  success: boolean
  data?: {
    key: string
    value: unknown
    version: number
    updatedAt: number
  }
  /** 错误代码，当 success 为 false 时存在 */
  error?: string
  /** 错误消息，当 success 为 false 时存在 */
  message?: string
}

// V2 版本冲突错误
export interface V2VersionConflictError {
  success: false
  error: 'VERSION_CONFLICT'
  message: string
  currentVersion: number
  serverData: unknown
}

// ==================== V1 API ====================

export const api = {
  // ==================== 完整数据 API ====================

  async getData(): Promise<AccountData> {
    const API_BASE = getApiBase() // ✅ 每次调用时动态获取
    const res = await fetchWithAuth(`${API_BASE}/data`)
    return res.json()
  },

  async saveData(data: AccountData): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/data`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
    return res.json()
  },

  async importData(data: AccountData): Promise<{ success: boolean; message?: string }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    })
    return res.json()
  },

  async exportData(): Promise<AccountData> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/export`)
    return res.json()
  },

  // ==================== 账号 API ====================

  async getAccounts(): Promise<Record<string, Account>> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/accounts`)
    return res.json()
  },

  async getAccountsList(): Promise<Account[]> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/accounts/list`)
    return res.json()
  },

  async getAccount(id: string): Promise<Account> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/accounts/${encodeURIComponent(id)}`)
    return res.json()
  },

  async createAccount(id: string, account: Partial<Account>): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/accounts/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(account)
    })
    return res.json()
  },

  async updateAccount(id: string, account: Partial<Account>): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/accounts/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(account)
    })
    return res.json()
  },

  async deleteAccount(id: string): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/accounts/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    })
    return res.json()
  },

  async batchDeleteAccounts(ids: string[]): Promise<{ success: boolean; count: number }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/accounts/batch-delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    })
    return res.json()
  },

  async activateAccount(id: string): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/accounts/${encodeURIComponent(id)}/activate`, {
      method: 'POST'
    })
    return res.json()
  },

  async updateAccountStatus(
    id: string,
    status: string,
    lastCheckedAt?: number
  ): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/accounts/${encodeURIComponent(id)}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, lastCheckedAt })
    })
    return res.json()
  },

  async updateAccountCredentials(
    id: string,
    credentials: Partial<Account['credentials']>
  ): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/accounts/${encodeURIComponent(id)}/credentials`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(credentials)
    })
    return res.json()
  },

  async updateAccountUsage(
    id: string,
    usage: Partial<Account['usage']>
  ): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/accounts/${encodeURIComponent(id)}/usage`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(usage)
    })
    return res.json()
  },

  async updateAccountGroup(id: string, groupId: string | null): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/accounts/${encodeURIComponent(id)}/group`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId })
    })
    return res.json()
  },

  async updateAccountTags(id: string, tags: string[]): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/accounts/${encodeURIComponent(id)}/tags`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags })
    })
    return res.json()
  },

  // ==================== 分组 API ====================

  async getGroups(): Promise<Record<string, Group>> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/groups`)
    return res.json()
  },

  async getGroupsList(): Promise<Group[]> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/groups/list`)
    return res.json()
  },

  async createGroup(id: string, group: Partial<Group>): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/groups/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(group)
    })
    return res.json()
  },

  async updateGroup(id: string, group: Partial<Group>): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/groups/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(group)
    })
    return res.json()
  },

  async deleteGroup(id: string): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/groups/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    })
    return res.json()
  },

  // ==================== 标签 API ====================

  async getTags(): Promise<Record<string, Tag>> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/tags`)
    return res.json()
  },

  async getTagsList(): Promise<Tag[]> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/tags/list`)
    return res.json()
  },

  async createTag(id: string, tag: Partial<Tag>): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/tags/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tag)
    })
    return res.json()
  },

  async updateTag(id: string, tag: Partial<Tag>): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/tags/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tag)
    })
    return res.json()
  },

  async deleteTag(id: string): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/tags/${encodeURIComponent(id)}`, {
      method: 'DELETE'
    })
    return res.json()
  },

  // ==================== 设置 API ====================

  async getSettings(): Promise<Record<string, unknown>> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/settings`)
    return res.json()
  },

  async getSetting<T = unknown>(key: string): Promise<T | null> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/settings/${encodeURIComponent(key)}`)
    return res.json()
  },

  async saveSetting(key: string, value: unknown): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/settings/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value })
    })
    return res.json()
  },

  async saveSettings(settings: Record<string, unknown>): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    })
    return res.json()
  },

  // ==================== 机器码 API ====================

  async getMachineIdConfig(): Promise<AccountData['machineIdConfig']> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/machine-id/config`)
    return res.json()
  },

  async saveMachineIdConfig(config: AccountData['machineIdConfig']): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/machine-id/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    })
    return res.json()
  },

  async getMachineIdBindings(): Promise<Record<string, string>> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/machine-id/bindings`)
    return res.json()
  },

  async bindMachineId(accountId: string, machineId: string): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(
      `${API_BASE}/machine-id/bindings/${encodeURIComponent(accountId)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ machineId })
      }
    )
    return res.json()
  },

  async unbindMachineId(accountId: string): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(
      `${API_BASE}/machine-id/bindings/${encodeURIComponent(accountId)}`,
      {
        method: 'DELETE'
      }
    )
    return res.json()
  },

  async getMachineIdHistory(): Promise<AccountData['machineIdHistory']> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/machine-id/history`)
    return res.json()
  },

  async addMachineIdHistory(record: {
    id: string
    machineId: string
    timestamp: number
    action: string
  }): Promise<{ success: boolean }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/machine-id/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record)
    })
    return res.json()
  },

  // ==================== 统计 API ====================

  async getStats(): Promise<{
    accounts: number
    activeAccounts: number
    groups: number
    tags: number
    totalUsage: number
    totalLimit: number
  }> {
    const API_BASE = getApiBase()
    const res = await fetchWithAuth(`${API_BASE}/stats`)
    return res.json()
  },

  async healthCheck(): Promise<{ status: string; database: string; version?: string }> {
    // 动态获取 API_BASE（支持 Electron-Web 模式的延迟注入）
    const apiBase = getApiBase()
    const res = await fetchWithAuth(`${apiBase}/health`)
    return res.json()
  }
}

// ==================== V2 API ====================
// V2 API 从 api-v2.ts 导入
export { apiV2 } from './api-v2'

// ==================== 类型导出说明 ====================
// 所有 V2 响应类型已通过 export interface 声明自动导出，可直接导入使用：
// - V2PaginationInfo: 分页信息
// - V2AccountsListResponse: 账号列表响应
// - V2AccountResponse: 单个账号响应
// - V2MutationResponse: 创建/更新响应
// - V2DeleteResponse: 删除响应
// - V2BatchOperation: 批量操作请求
// - V2BatchResponse: 批量操作响应
// - V2SyncSnapshotResponse: 同步快照响应
// - V2SyncChangesRequest: 增量变更请求
// - V2SyncChangesResponse: 增量变更响应
// - V2SyncPushRequest: 推送变更请求
// - V2SyncPushResponse: 推送变更响应
// - V2SettingsResponse: 设置响应
// - V2SettingResponse: 单个设置响应
// - V2VersionConflictError: 版本冲突错误
//
// 注意：所有 V2 响应类型的 data 字段都是可选的（data?:），
// 并包含 error?: string 和 message?: string 字段用于错误处理。
// 时间戳字段（如 freeTrialExpiry、nextResetDate、expiresAt）使用 Unix 毫秒时间戳（number 类型）。