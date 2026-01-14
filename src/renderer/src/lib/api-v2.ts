// V2 API 客户端 - 增量同步和细化接口
// 从 api.ts 导入基础类型和工具函数

import { fetchWithAuth } from './api'
import type {
  Account,
  Group,
  Tag,
  V2AccountsListResponse,
  V2AccountResponse,
  V2MutationResponse,
  V2DeleteResponse,
  V2BatchOperation,
  V2BatchResponse,
  V2SyncSnapshotResponse,
  V2SyncChangesRequest,
  V2SyncChangesResponse,
  V2SettingsResponse,
  V2SettingResponse
} from './api'

// 动态获取 API Base URL（支持 Electron-Web 模式）
const getApiBase = (): string => {
  // 优先使用环境变量配置的 API 地址
  if (import.meta.env.VITE_API_BASE) {
    return import.meta.env.VITE_API_BASE
  }

  // Electron-Web 模式：从 WEB_SERVER_URL 环境变量获取服务器地址
  if (
    typeof window !== 'undefined' &&
    (window as { __WEB_SERVER_URL__?: string }).__WEB_SERVER_URL__
  ) {
    return (window as { __WEB_SERVER_URL__?: string }).__WEB_SERVER_URL__ + '/api'
  }

  // 默认使用相对路径（纯 Web 模式）
  return '/api'
}

// ==================== V2 API ====================

export const apiV2 = {
  // ==================== V2 同步接口 ====================
  sync: {
    /**
     * 获取完整数据快照（用于初始化）
     * @param options 可选参数
     * 注意：settings 已从 snapshot 中移除，应通过独立的 settings.list() 接口获取
     */
    async snapshot(options?: {
      includeDeleted?: boolean
      resources?: ('accounts' | 'groups' | 'tags')[]
    }): Promise<V2SyncSnapshotResponse> {
      const API_BASE = getApiBase()
      const params = new URLSearchParams()
      if (options?.includeDeleted) params.set('includeDeleted', 'true')
      if (options?.resources) params.set('resources', options.resources.join(','))
      const queryString = params.toString()
      const url = `${API_BASE}/v2/sync/snapshot${queryString ? `?${queryString}` : ''}`
      const res = await fetchWithAuth(url)
      return res.json()
    },

    /**
     * 获取增量变更（用于后台同步）
     * @param modifiedSince 上次同步时间戳（毫秒）
     * @param resources 要同步的资源类型
     * 注意：settings 已从 changes 中移除
     */
    async changes(
      modifiedSince: number,
      resources?: ('accounts' | 'groups' | 'tags')[]
    ): Promise<V2SyncChangesResponse> {
      const API_BASE = getApiBase()
      const body: V2SyncChangesRequest = {
        lastSyncTime: modifiedSince,
        resources
      }
      const res = await fetchWithAuth(`${API_BASE}/v2/sync/changes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      return res.json()
    }
  },

  // ==================== V2 账号接口 ====================
  accounts: {
    /**
     * 查询账号列表
     * @param options 查询参数
     */
    async list(options?: {
      page?: number
      pageSize?: number
      fields?: string[]
      includeDeleted?: boolean
      modifiedSince?: number
      groupId?: string
      status?: string
      sortBy?: string
      sortOrder?: 'asc' | 'desc'
    }): Promise<V2AccountsListResponse> {
      const API_BASE = getApiBase()
      const params = new URLSearchParams()
      if (options?.page) params.set('page', options.page.toString())
      if (options?.pageSize) params.set('pageSize', options.pageSize.toString())
      if (options?.fields) params.set('fields', options.fields.join(','))
      if (options?.includeDeleted) params.set('includeDeleted', 'true')
      if (options?.modifiedSince) params.set('modifiedSince', options.modifiedSince.toString())
      if (options?.groupId) params.set('groupId', options.groupId)
      if (options?.status) params.set('status', options.status)
      if (options?.sortBy) params.set('sortBy', options.sortBy)
      if (options?.sortOrder) params.set('sortOrder', options.sortOrder)
      const queryString = params.toString()
      const url = `${API_BASE}/v2/accounts${queryString ? `?${queryString}` : ''}`
      const res = await fetchWithAuth(url)
      return res.json()
    },

    /**
     * 获取单个账号
     * @param id 账号ID
     */
    async get(id: string): Promise<V2AccountResponse> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/accounts/${encodeURIComponent(id)}`)
      return res.json()
    },

    /**
     * 创建账号
     * @param data 账号数据
     */
    async create(data: Partial<Account>): Promise<V2MutationResponse> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/accounts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
      return res.json()
    },

    /**
     * 更新账号（需要版本号）
     * @param id 账号ID
     * @param data 更新数据（必须包含version）
     */
    async update(
      id: string,
      data: Partial<Account> & { version: number }
    ): Promise<V2MutationResponse> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/accounts/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
      return res.json()
    },

    /**
     * 删除账号（软删除）
     * @param id 账号ID
     */
    async delete(id: string): Promise<V2DeleteResponse> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/accounts/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      })
      return res.json()
    },

    /**
     * 批量操作账号
     * @param operations 操作列表
     */
    async batch(operations: V2BatchOperation[]): Promise<V2BatchResponse> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/accounts/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations, stopOnError: false })
      })
      return res.json()
    }
  },

  // ==================== V2 分组接口 ====================
  groups: {
    /**
     * 查询分组列表
     * @param options 查询参数
     */
    async list(options?: {
      modifiedSince?: number
    }): Promise<{ success: boolean; data: { groups: Group[]; serverTime: number } }> {
      const API_BASE = getApiBase()
      const params = new URLSearchParams()
      if (options?.modifiedSince) params.set('modifiedSince', options.modifiedSince.toString())
      const queryString = params.toString()
      const url = `${API_BASE}/v2/groups${queryString ? `?${queryString}` : ''}`
      const res = await fetchWithAuth(url)
      return res.json()
    },

    /**
     * 获取单个分组
     * @param id 分组ID
     */
    async get(id: string): Promise<{ success: boolean; data: Group }> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/groups/${encodeURIComponent(id)}`)
      return res.json()
    },

    /**
     * 创建分组
     * @param data 分组数据
     */
    async create(data: Partial<Group>): Promise<V2MutationResponse> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/groups`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
      return res.json()
    },

    /**
     * 更新分组（需要版本号）
     * @param id 分组ID
     * @param data 更新数据（必须包含version）
     */
    async update(
      id: string,
      data: Partial<Group> & { version: number }
    ): Promise<V2MutationResponse> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/groups/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
      return res.json()
    },

    /**
     * 删除分组
     * @param id 分组ID
     */
    async delete(id: string): Promise<V2DeleteResponse> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/groups/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      })
      return res.json()
    },

    /**
     * 批量操作分组
     * @param operations 操作列表
     */
    async batch(
      operations: Array<{
        action: 'create' | 'update' | 'delete'
        data: Partial<Group> & { id: string; version?: number }
      }>
    ): Promise<V2BatchResponse> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/groups/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations, stopOnError: false })
      })
      return res.json()
    }
  },

  // ==================== V2 标签接口 ====================
  tags: {
    /**
     * 查询标签列表
     * @param options 查询参数
     */
    async list(options?: {
      modifiedSince?: number
    }): Promise<{ success: boolean; data: { tags: Tag[]; serverTime: number } }> {
      const API_BASE = getApiBase()
      const params = new URLSearchParams()
      if (options?.modifiedSince) params.set('modifiedSince', options.modifiedSince.toString())
      const queryString = params.toString()
      const url = `${API_BASE}/v2/tags${queryString ? `?${queryString}` : ''}`
      const res = await fetchWithAuth(url)
      return res.json()
    },

    /**
     * 获取单个标签
     * @param id 标签ID
     */
    async get(id: string): Promise<{ success: boolean; data: Tag }> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/tags/${encodeURIComponent(id)}`)
      return res.json()
    },

    /**
     * 创建标签
     * @param data 标签数据
     */
    async create(data: Partial<Tag>): Promise<V2MutationResponse> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
      return res.json()
    },

    /**
     * 更新标签（需要版本号）
     * @param id 标签ID
     * @param data 更新数据（必须包含version）
     */
    async update(id: string, data: Partial<Tag> & { version: number }): Promise<V2MutationResponse> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/tags/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
      return res.json()
    },

    /**
     * 删除标签
     * @param id 标签ID
     */
    async delete(id: string): Promise<V2DeleteResponse> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/tags/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      })
      return res.json()
    },

    /**
     * 批量操作标签
     * @param operations 操作列表
     */
    async batch(
      operations: Array<{
        action: 'create' | 'update' | 'delete'
        data: Partial<Tag> & { id: string; version?: number }
      }>
    ): Promise<V2BatchResponse> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/tags/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ operations, stopOnError: false })
      })
      return res.json()
    }
  },

  // ==================== V2 设置接口 ====================
  settings: {
    /**
     * 获取所有设置
     * @param options 查询参数
     */
    async list(options?: { modifiedSince?: number }): Promise<V2SettingsResponse> {
      const API_BASE = getApiBase()
      const params = new URLSearchParams()
      if (options?.modifiedSince) params.set('modifiedSince', options.modifiedSince.toString())
      const queryString = params.toString()
      const url = `${API_BASE}/v2/settings${queryString ? `?${queryString}` : ''}`
      const res = await fetchWithAuth(url)
      return res.json()
    },

    /**
     * 获取单个设置
     * @param key 设置键
     */
    async get(key: string): Promise<V2SettingResponse> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/settings/${encodeURIComponent(key)}`)
      return res.json()
    },

    /**
     * 更新单个设置
     * @param key 设置键
     * @param data 设置数据
     */
    async update(
      key: string,
      data: { value: unknown; version?: number }
    ): Promise<V2MutationResponse> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/settings/${encodeURIComponent(key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      })
      return res.json()
    },

    /**
     * 批量更新设置
     * @param settings 设置键值对
     */
    async batch(
      settings: Record<string, unknown>
    ): Promise<{
      success: boolean
      data: { succeeded: string[]; failed: Array<{ key: string; error: string }> }
    }> {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/v2/settings/batch`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      })
      return res.json()
    }
  }
}

// 导出类型
export type { V2SyncSnapshotResponse, V2SyncChangesResponse }