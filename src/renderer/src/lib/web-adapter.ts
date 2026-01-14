// Web 环境适配器 - 模拟 Electron API
import { api, AccountData, Account, Group, Tag } from './api'
import { apiV2 } from './api-v2'

// 上次同步时间（用于增量同步）
let lastSyncTime = 0

// 本地数据版本缓存（用于冲突检测）
const localVersions: {
  accounts: Map<string, number>
  groups: Map<string, number>
  tags: Map<string, number>
} = {
  accounts: new Map(),
  groups: new Map(),
  tags: new Map()
}

// 待推送的变更队列
const pendingChanges: {
  accounts: {
    created: Partial<Account>[]
    updated: (Partial<Account> & { id: string; version: number })[]
    deleted: string[]
  }
  groups: {
    created: Partial<Group>[]
    updated: (Partial<Group> & { id: string; version: number })[]
    deleted: string[]
  }
  tags: {
    created: Partial<Tag>[]
    updated: (Partial<Tag> & { id: string; version: number })[]
    deleted: string[]
  }
  settings: Record<string, unknown>
} = {
  accounts: { created: [], updated: [], deleted: [] },
  groups: { created: [], updated: [], deleted: [] },
  tags: { created: [], updated: [], deleted: [] },
  settings: {}
}

// 清空待推送变更
function clearPendingChanges() {
  pendingChanges.accounts = { created: [], updated: [], deleted: [] }
  pendingChanges.groups = { created: [], updated: [], deleted: [] }
  pendingChanges.tags = { created: [], updated: [], deleted: [] }
  pendingChanges.settings = {}
}

// 检查是否有待推送的变更
function hasPendingChanges(): boolean {
  return (
    pendingChanges.accounts.created.length > 0 ||
    pendingChanges.accounts.updated.length > 0 ||
    pendingChanges.accounts.deleted.length > 0 ||
    pendingChanges.groups.created.length > 0 ||
    pendingChanges.groups.updated.length > 0 ||
    pendingChanges.groups.deleted.length > 0 ||
    pendingChanges.tags.created.length > 0 ||
    pendingChanges.tags.updated.length > 0 ||
    pendingChanges.tags.deleted.length > 0 ||
    Object.keys(pendingChanges.settings).length > 0
  )
}

export const webAdapter = {
  // 加载账号数据 - 使用独立的 v2 list 接口（微服务架构）
  // includeDeleted: 是否包含已删除的账号（用于回收站视图）
  async loadAccounts(options?: { includeDeleted?: boolean }): Promise<AccountData> {
    try {
      // 使用独立的 v2 list 接口并行获取数据（微服务架构）
      const includeDeleted = options?.includeDeleted ?? true // 默认获取所有账号（包括已删除），前端过滤
      console.log('[Web] Loading data using v2 independent list APIs (microservice style)...', { includeDeleted })
      
      // 并行调用所有独立的 list 接口
      const [accountsRes, groupsRes, tagsRes, settingsRes] = await Promise.all([
        apiV2.accounts.list({ pageSize: 10000, includeDeleted }), // 获取所有账号（包括已删除）
        apiV2.groups.list(),
        apiV2.tags.list(),
        apiV2.settings.list()
      ])

      // 检查所有接口是否成功
      if (!accountsRes.success || !groupsRes.success || !tagsRes.success || !settingsRes.success) {
        console.warn('[Web] Some v2 list APIs failed, falling back to v1 API', {
          accounts: accountsRes.success,
          groups: groupsRes.success,
          tags: tagsRes.success,
          settings: settingsRes.success
        })
        return await loadAccountsV1()
      }

      const accounts = accountsRes.data.accounts
      const groups = groupsRes.data.groups
      const tags = tagsRes.data.tags
      const settings = settingsRes.data.settings
      // 使用最新的 serverTime
      const serverTime = Math.max(
        accountsRes.data.serverTime || 0,
        groupsRes.data.serverTime || 0,
        tagsRes.data.serverTime || 0,
        settingsRes.data.serverTime || 0
      )

      // 更新同步时间
      lastSyncTime = serverTime

      // 更新本地版本缓存
      localVersions.accounts.clear()
      localVersions.groups.clear()
      localVersions.tags.clear()

      // 转换数组为 Record 格式
      const accountsRecord: Record<string, Account> = {}
      for (const account of accounts) {
        accountsRecord[account.id] = account
        if (account.version) {
          localVersions.accounts.set(account.id, account.version)
        }
      }

      const groupsRecord: Record<string, Group> = {}
      for (const group of groups) {
        groupsRecord[group.id] = group
        if (group.version) {
          localVersions.groups.set(group.id, group.version)
        }
      }

      const tagsRecord: Record<string, Tag> = {}
      for (const tag of tags) {
        tagsRecord[tag.id] = tag
        if (tag.version) {
          localVersions.tags.set(tag.id, tag.version)
        }
      }

      // 从账号数据中提取 machineId 绑定信息
      const accountMachineIds: Record<string, string> = {}
      for (const account of accounts) {
        if (account.machineId) {
          accountMachineIds[account.id] = account.machineId
        }
      }

      console.log('[Web] Loaded via v2 independent list APIs:', {
        accounts: Object.keys(accountsRecord).length,
        groups: Object.keys(groupsRecord).length,
        tags: Object.keys(tagsRecord).length,
        accountMachineIds: Object.keys(accountMachineIds).length,
        serverTime
      })

      return {
        accounts: accountsRecord,
        tags: tagsRecord,
        groups: groupsRecord,
        activeAccountId: (settings?.activeAccountId as string) ?? null,
        autoRefreshEnabled: (settings?.autoRefreshEnabled as boolean) ?? undefined,
        autoRefreshInterval: (settings?.autoRefreshInterval as number) ?? undefined,
        statusCheckInterval: (settings?.statusCheckInterval as number) ?? undefined,
        privacyMode: (settings?.privacyMode as boolean) ?? undefined,
        proxyEnabled: (settings?.proxyEnabled as boolean) ?? undefined,
        proxyUrl: (settings?.proxyUrl as string) ?? undefined,
        autoSwitchEnabled: (settings?.autoSwitchEnabled as boolean) ?? undefined,
        autoSwitchThreshold: (settings?.autoSwitchThreshold as number) ?? undefined,
        autoSwitchInterval: (settings?.autoSwitchInterval as number) ?? undefined,
        theme: (settings?.theme as string) ?? undefined,
        darkMode: (settings?.darkMode as boolean) ?? undefined,
        machineIdConfig: settings?.machineIdConfig as AccountData['machineIdConfig'],
        accountMachineIds,
        machineIdHistory: [] // machineIdHistory 需要单独接口获取，暂时返回空数组
      }
    } catch (error) {
      console.error('[Web] v2 Load failed, falling back to v1:', error)
      // 回退到 v1 API
      return await loadAccountsV1()
    }
  },

  // 保存账号数据 - 使用 v2 sync/push 接口进行增量同步
  async saveAccounts(data: {
    accounts?: Record<string, Account>
    tags?: Record<string, Tag>
    groups?: Record<string, Group>
  }): Promise<{ success: boolean; error?: string }> {
    try {
      // 计算变更
      const changes = computeChanges(data)

      // 如果没有变更，直接返回成功
      if (!hasChangesInPayload(changes)) {
        console.log('[Web] No changes to push')
        return { success: true }
      }

      console.log('[Web] Pushing changes via v2 sync/push...', {
        accounts: {
          created: changes.accounts?.created?.length ?? 0,
          updated: changes.accounts?.updated?.length ?? 0,
          deleted: changes.accounts?.deleted?.length ?? 0
        },
        groups: {
          created: changes.groups?.created?.length ?? 0,
          updated: changes.groups?.updated?.length ?? 0,
          deleted: changes.groups?.deleted?.length ?? 0
        },
        tags: {
          created: changes.tags?.created?.length ?? 0,
          updated: changes.tags?.updated?.length ?? 0,
          deleted: changes.tags?.deleted?.length ?? 0
        }
      })

      // 尝试使用 v2 API 推送变更
      const response = await apiV2.sync.push(changes)

      if (response.success) {
        // 更新同步时间
        lastSyncTime = response.data.serverTime

        // 处理冲突
        if (response.data.conflicts && response.data.conflicts.length > 0) {
          console.warn('[Web] Conflicts detected:', response.data.conflicts)
          // 自动解决冲突：使用服务器数据
          for (const conflict of response.data.conflicts) {
            if (conflict.resource === 'accounts' && conflict.serverData) {
              const serverAccount = conflict.serverData as Account
              localVersions.accounts.set(conflict.id, conflict.serverVersion)
              // 更新本地数据（如果需要）
              if (data.accounts && data.accounts[conflict.id]) {
                data.accounts[conflict.id] = serverAccount
              }
            } else if (conflict.resource === 'groups' && conflict.serverData) {
              const serverGroup = conflict.serverData as Group
              localVersions.groups.set(conflict.id, conflict.serverVersion)
              if (data.groups && data.groups[conflict.id]) {
                data.groups[conflict.id] = serverGroup
              }
            } else if (conflict.resource === 'tags' && conflict.serverData) {
              const serverTag = conflict.serverData as Tag
              localVersions.tags.set(conflict.id, conflict.serverVersion)
              if (data.tags && data.tags[conflict.id]) {
                data.tags[conflict.id] = serverTag
              }
            }
          }
        }

        // 更新本地版本缓存
        updateLocalVersionsFromResponse(response.data.results, data)

        console.log('[Web] Changes pushed successfully')
        return { success: true }
      }

      // v2 API 失败，回退到 v1 API
      console.warn('[Web] v2 push failed, falling back to v1 API')
      return await saveAccountsV1(data)
    } catch (error) {
      console.error('[Web] v2 Save failed, falling back to v1:', error)
      // 回退到 v1 API
      return await saveAccountsV1(data)
    }
  },

  // 获取增量变更（用于后台同步）
  async getChanges(): Promise<{
    success: boolean
    changes?: {
      accounts?: { created: Account[]; updated: Account[]; deleted: string[] }
      groups?: { created: Group[]; updated: Group[]; deleted: string[] }
      tags?: { created: Tag[]; updated: Tag[]; deleted: string[] }
    }
    serverTime?: number
  }> {
    try {
      const response = await apiV2.sync.changes(lastSyncTime)

      if (response.success) {
        lastSyncTime = response.data.serverTime
        return {
          success: true,
          changes: response.data.changes,
          serverTime: response.data.serverTime
        }
      }

      return { success: false }
    } catch (error) {
      console.error('[Web] Failed to get changes:', error)
      return { success: false }
    }
  },

  // 获取上次同步时间
  getLastSyncTime(): number {
    return lastSyncTime
  },

  // 设置上次同步时间
  setLastSyncTime(time: number): void {
    lastSyncTime = time
  },

  // 获取完整数据
  async getFullData(): Promise<AccountData | null> {
    try {
      return await api.getData()
    } catch (error) {
      console.error('[Web] Get full data failed:', error)
      return null
    }
  },

  // 保存完整数据
  async saveFullData(data: AccountData): Promise<{ success: boolean; error?: string }> {
    try {
      await api.saveData(data)
      return { success: true }
    } catch (error) {
      return { success: false, error: String(error) }
    }
  },

  async getAppVersion(): Promise<string> {
    return '2.2.11-web'
  },

  // 账号操作 - Web 版本通过后端 API 实现
  async checkAccountStatus(
    account: Account
  ): Promise<{ success: boolean; data?: unknown; error?: { message?: string } }> {
    // Web 端：调用后端 API 检查账号状态
    try {
      const response = await fetch(`/api/accounts/${account.id}/check-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })

      if (!response.ok) {
        const error = await response.json()
        return { success: false, error: { message: error.error || 'Check status failed' } }
      }

      const result = await response.json()
      return {
        success: true,
        data: result.data
      }
    } catch (error) {
      return { success: false, error: { message: String(error) } }
    }
  },

  async refreshAccountToken(
    account: Account
  ): Promise<{
    success: boolean
    data?: { accessToken: string; refreshToken: string; expiresIn: number }
    error?: { message?: string }
  }> {
    // Web 端：调用后端 API 刷新 Token
    try {
      const response = await fetch(`/api/accounts/${account.id}/refresh-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      })

      if (!response.ok) {
        const error = await response.json()
        return { success: false, error: { message: error.error || 'Refresh token failed' } }
      }

      const result = await response.json()
      return {
        success: true,
        data: result.data
      }
    } catch (error) {
      return { success: false, error: { message: String(error) } }
    }
  },

  async verifyAccountCredentials(): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'Not implemented in web version' }
  },

  async switchAccount(): Promise<{ success: boolean }> {
    return { success: true }
  },

  async loadKiroCredentials(): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'Not available in web version' }
  },

  async getLocalActiveAccount(): Promise<{ success: boolean }> {
    return { success: false }
  },

  // 机器码相关
  async machineIdGetCurrent(): Promise<{ success: boolean; machineId: string }> {
    return { success: true, machineId: 'web-browser' }
  },

  async machineIdGenerateRandom(): Promise<string> {
    return 'web-' + Math.random().toString(36).substring(2, 15)
  },

  async machineIdSet(): Promise<{ success: boolean }> {
    return { success: true }
  },

  async machineIdGetOSType(): Promise<string> {
    return 'web'
  },

  async machineIdCheckAdmin(): Promise<boolean> {
    return false
  },

  async machineIdBackupToFile(id: string): Promise<void> {
    const blob = new Blob([id], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'machine-id-backup.txt'
    a.click()
    URL.revokeObjectURL(url)
  },

  async machineIdRestoreFromFile(): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'Not available in web version' }
  },

  async machineIdRequestAdminRestart(): Promise<void> {
    alert('Web 版本不需要管理员权限')
  },

  // 代理设置
  setProxy(): void {
    // Web 版本不支持
  },

  // 文件操作
  async importFromFile(): Promise<string | null> {
    return new Promise((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.json'
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0]
        if (file) {
          const text = await file.text()
          resolve(text)
        } else {
          resolve(null)
        }
      }
      input.click()
    })
  },

  async exportToFile(content: string, filename: string): Promise<boolean> {
    const blob = new Blob([content], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
    return true
  },

  // Kiro 设置相关 - Web 版本不支持
  async getKiroSettings(): Promise<{ settings: Record<string, unknown> }> {
    return { settings: {} }
  },

  async saveKiroSettings(): Promise<{ success: boolean }> {
    return { success: true }
  },

  async openKiroSettingsFile(): Promise<void> {
    alert('Web 版本不支持打开本地文件')
  },

  async openKiroMcpConfig(): Promise<void> {
    alert('Web 版本不支持打开本地文件')
  },

  async openKiroSteeringFolder(): Promise<void> {
    alert('Web 版本不支持打开本地文件夹')
  },

  async openKiroSteeringFile(): Promise<void> {
    alert('Web 版本不支持打开本地文件')
  },

  async readKiroSteeringFile(): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'Not available in web version' }
  },

  async saveKiroSteeringFile(): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'Not available in web version' }
  },

  async createKiroDefaultRules(): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'Not available in web version' }
  },

  async deleteKiroSteeringFile(): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'Not available in web version' }
  },

  async saveMcpServer(): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'Not available in web version' }
  },

  async deleteMcpServer(): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: 'Not available in web version' }
  },

  openExternal(url: string): void {
    window.open(url, '_blank')
  },

  onSocialAuthCallback(): () => void {
    return () => {}
  }
}

// ==================== 辅助函数 ====================

// v1 API 加载账号（回退方案）
async function loadAccountsV1(): Promise<AccountData> {
  try {
    const data = await api.getData()
    console.log('[Web] Loaded via v1 API:', {
      accounts: Object.keys(data.accounts || {}).length,
      groups: Object.keys(data.groups || {}).length,
      tags: Object.keys(data.tags || {}).length,
      accountMachineIds: Object.keys(data.accountMachineIds || {}).length
    })
    return {
      accounts: data.accounts || {},
      tags: data.tags || {},
      groups: data.groups || {},
      activeAccountId: data.activeAccountId,
      autoRefreshEnabled: data.autoRefreshEnabled,
      autoRefreshInterval: data.autoRefreshInterval,
      statusCheckInterval: data.statusCheckInterval,
      privacyMode: data.privacyMode,
      proxyEnabled: data.proxyEnabled,
      proxyUrl: data.proxyUrl,
      autoSwitchEnabled: data.autoSwitchEnabled,
      autoSwitchThreshold: data.autoSwitchThreshold,
      autoSwitchInterval: data.autoSwitchInterval,
      theme: data.theme,
      darkMode: data.darkMode,
      machineIdConfig: data.machineIdConfig,
      accountMachineIds: data.accountMachineIds || {},
      machineIdHistory: data.machineIdHistory || []
    }
  } catch (error) {
    console.error('[Web] v1 Load failed:', error)
    return { accounts: {}, tags: {}, groups: {}, accountMachineIds: {} }
  }
}

// v1 API 保存账号（回退方案）- 不再使用 syncDelete
async function saveAccountsV1(data: {
  accounts?: Record<string, Account>
  tags?: Record<string, Tag>
  groups?: Record<string, Group>
}): Promise<{ success: boolean; error?: string }> {
  try {
    const currentData = await api.getData()
    const mergedData: AccountData = {
      ...currentData,
      accounts: data.accounts || currentData.accounts,
      tags: data.tags || currentData.tags,
      groups: data.groups || currentData.groups
      // 注意：移除了 syncDelete: true，不再同步删除
    }
    await api.saveData(mergedData)
    return { success: true }
  } catch (error) {
    console.error('[Web] v1 Save failed:', error)
    return { success: false, error: String(error) }
  }
}

// 计算变更
function computeChanges(data: {
  accounts?: Record<string, Account>
  tags?: Record<string, Tag>
  groups?: Record<string, Group>
}): {
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
} {
  const changes: {
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
  } = {}

  // 计算账号变更
  if (data.accounts) {
    const accountChanges: {
      created: Partial<Account>[]
      updated: (Partial<Account> & { id: string; version: number })[]
      deleted: string[]
    } = { created: [], updated: [], deleted: [] }

    for (const [id, account] of Object.entries(data.accounts)) {
      const localVersion = localVersions.accounts.get(id)

      if (localVersion === undefined) {
        // 新创建的账号
        accountChanges.created.push(account)
      } else {
        // 已存在的账号，检查是否有更新
        accountChanges.updated.push({
          ...account,
          id,
          version: localVersion
        })
      }
    }

    // 检查删除的账号（标记为 isDel 的账号）
    for (const [id, account] of Object.entries(data.accounts)) {
      if (account.isDel) {
        accountChanges.deleted.push(id)
      }
    }

    if (
      accountChanges.created.length > 0 ||
      accountChanges.updated.length > 0 ||
      accountChanges.deleted.length > 0
    ) {
      changes.accounts = accountChanges
    }
  }

  // 计算分组变更
  if (data.groups) {
    const groupChanges: {
      created: Partial<Group>[]
      updated: (Partial<Group> & { id: string; version: number })[]
      deleted: string[]
    } = { created: [], updated: [], deleted: [] }

    for (const [id, group] of Object.entries(data.groups)) {
      const localVersion = localVersions.groups.get(id)

      if (localVersion === undefined) {
        groupChanges.created.push(group)
      } else {
        groupChanges.updated.push({
          ...group,
          id,
          version: localVersion
        })
      }
    }

    if (
      groupChanges.created.length > 0 ||
      groupChanges.updated.length > 0 ||
      groupChanges.deleted.length > 0
    ) {
      changes.groups = groupChanges
    }
  }

  // 计算标签变更
  if (data.tags) {
    const tagChanges: {
      created: Partial<Tag>[]
      updated: (Partial<Tag> & { id: string; version: number })[]
      deleted: string[]
    } = { created: [], updated: [], deleted: [] }

    for (const [id, tag] of Object.entries(data.tags)) {
      const localVersion = localVersions.tags.get(id)

      if (localVersion === undefined) {
        tagChanges.created.push(tag)
      } else {
        tagChanges.updated.push({
          ...tag,
          id,
          version: localVersion
        })
      }
    }

    if (
      tagChanges.created.length > 0 ||
      tagChanges.updated.length > 0 ||
      tagChanges.deleted.length > 0
    ) {
      changes.tags = tagChanges
    }
  }

  return changes
}

// 检查变更负载是否有内容
function hasChangesInPayload(changes: {
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
}): boolean {
  return (
    (changes.accounts?.created?.length ?? 0) > 0 ||
    (changes.accounts?.updated?.length ?? 0) > 0 ||
    (changes.accounts?.deleted?.length ?? 0) > 0 ||
    (changes.groups?.created?.length ?? 0) > 0 ||
    (changes.groups?.updated?.length ?? 0) > 0 ||
    (changes.groups?.deleted?.length ?? 0) > 0 ||
    (changes.tags?.created?.length ?? 0) > 0 ||
    (changes.tags?.updated?.length ?? 0) > 0 ||
    (changes.tags?.deleted?.length ?? 0) > 0
  )
}

// 从响应更新本地版本缓存
function updateLocalVersionsFromResponse(
  results: {
    accounts?: {
      succeeded: string[]
      failed: Array<{ id: string; error: string; serverData?: Account }>
    }
    groups?: {
      succeeded: string[]
      failed: Array<{ id: string; error: string; serverData?: Group }>
    }
    tags?: {
      succeeded: string[]
      failed: Array<{ id: string; error: string; serverData?: Tag }>
    }
  },
  data: {
    accounts?: Record<string, Account>
    tags?: Record<string, Tag>
    groups?: Record<string, Group>
  }
): void {
  // 更新账号版本
  if (results.accounts && data.accounts) {
    for (const id of results.accounts.succeeded) {
      const account = data.accounts[id]
      if (account) {
        const newVersion = (localVersions.accounts.get(id) ?? 0) + 1
        localVersions.accounts.set(id, newVersion)
      }
    }
    // 处理失败的账号（使用服务器数据的版本）
    for (const failed of results.accounts.failed) {
      if (failed.serverData?.version) {
        localVersions.accounts.set(failed.id, failed.serverData.version)
      }
    }
  }

  // 更新分组版本
  if (results.groups && data.groups) {
    for (const id of results.groups.succeeded) {
      const group = data.groups[id]
      if (group) {
        const newVersion = (localVersions.groups.get(id) ?? 0) + 1
        localVersions.groups.set(id, newVersion)
      }
    }
    for (const failed of results.groups.failed) {
      if (failed.serverData?.version) {
        localVersions.groups.set(failed.id, failed.serverData.version)
      }
    }
  }

  // 更新标签版本
  if (results.tags && data.tags) {
    for (const id of results.tags.succeeded) {
      const tag = data.tags[id]
      if (tag) {
        const newVersion = (localVersions.tags.get(id) ?? 0) + 1
        localVersions.tags.set(id, newVersion)
      }
    }
    for (const failed of results.tags.failed) {
      if (failed.serverData?.version) {
        localVersions.tags.set(failed.id, failed.serverData.version)
      }
    }
  }
}

// 标记这是 Web 适配器（用于 isElectron 检测）
const webAdapterWithMark = {
  ...webAdapter,
  __isWebAdapter: true as const
}

// 在 Web 环境中注入适配器
if (typeof window !== 'undefined' && !window.api) {
  ;(window as unknown as { api: typeof webAdapterWithMark }).api = webAdapterWithMark
}