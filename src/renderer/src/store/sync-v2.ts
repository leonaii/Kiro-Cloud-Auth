// V2 同步模块 - 增量同步和版本冲突处理
import { apiV2 } from '../lib/api-v2'
import type { Account, AccountGroup as Group, AccountTag as Tag } from '../types/account'

// 自动同步到服务器开关
// 默认为 false，本地账号不会自动保存到云端
// 只有当手动点击"检测"时才会传到服务器
let autoSyncToServer = false

/**
 * 获取自动同步到服务器的开关状态
 */
export function getAutoSyncToServer(): boolean {
  return autoSyncToServer
}

/**
 * 设置自动同步到服务器的开关状态
 * @param value - true 表示自动同步，false 表示不自动同步
 */
export function setAutoSyncToServer(value: boolean): void {
  autoSyncToServer = value
  console.log('[SyncV2] autoSyncToServer set to:', value)
}

// 同步状态
interface SyncState {
  lastSyncTime: number
  isSyncing: boolean
  localVersions: {
    // 账号版本号：使用 email + idp 作为 key
    accounts: Map<string, number>
    groups: Map<string, number>
    tags: Map<string, number>
  }
}

// 全局同步状态
const syncState: SyncState = {
  lastSyncTime: 0,
  isSyncing: false,
  localVersions: {
    accounts: new Map(),
    groups: new Map(),
    tags: new Map()
  }
}

/**
 * 生成账号的版本 key（基于 email + idp）
 */
function getAccountVersionKey(email: string, idp: string): string {
  return `${email}|${idp}`
}

// 获取同步状态
export function getSyncState(): SyncState {
  return syncState
}

// 设置上次同步时间
export function setLastSyncTime(time: number): void {
  syncState.lastSyncTime = time
}

// 获取上次同步时间
export function getLastSyncTime(): number {
  return syncState.lastSyncTime
}

// 更新本地版本缓存
export function updateLocalVersion(
  type: 'accounts' | 'groups' | 'tags',
  id: string,
  version: number,
  email?: string,
  idp?: string
): void {
  if (type === 'accounts' && email && idp) {
    // 账号使用 email + idp 作为 key
    const key = getAccountVersionKey(email, idp)
    syncState.localVersions[type].set(key, version)
  } else {
    // 其他类型仍使用 id
    syncState.localVersions[type].set(id, version)
  }
}

// 获取本地版本
export function getLocalVersion(
  type: 'accounts' | 'groups' | 'tags',
  id: string,
  email?: string,
  idp?: string
): number | undefined {
  if (type === 'accounts' && email && idp) {
    // 账号使用 email + idp 作为 key
    const key = getAccountVersionKey(email, idp)
    return syncState.localVersions[type].get(key)
  } else {
    // 其他类型仍使用 id
    return syncState.localVersions[type].get(id)
  }
}

// 清除本地版本缓存
export function clearLocalVersions(): void {
  syncState.localVersions.accounts.clear()
  syncState.localVersions.groups.clear()
  syncState.localVersions.tags.clear()
}

/**
 * 从服务器获取增量变更
 * @param onUpdate 更新回调函数
 */
export async function syncChangesFromServer(onUpdate: (changes: {
  accounts?: { created: Account[]; updated: Account[]; deleted: string[] }
  groups?: { created: Group[]; updated: Group[]; deleted: string[] }
  tags?: { created: Tag[]; updated: Tag[]; deleted: string[] }
}) => void): Promise<{ success: boolean; error?: string }> {
  if (syncState.isSyncing) {
    console.log('[SyncV2] Already syncing, skipping...')
    return { success: false, error: 'Already syncing' }
  }

  syncState.isSyncing = true

  try {
    console.log('[SyncV2] Fetching changes since:', syncState.lastSyncTime)
    const response = await apiV2.sync.changes(syncState.lastSyncTime)

    if (!response.success) {
      console.error('[SyncV2] Failed to fetch changes')
      return { success: false, error: 'Failed to fetch changes' }
    }

    const { changes, serverTime, hasMore } = response.data

    // 更新同步时间
    syncState.lastSyncTime = serverTime

    // 更新本地版本缓存
    if (changes.accounts) {
      for (const account of [...changes.accounts.created, ...changes.accounts.updated]) {
        if (account.version && account.email && account.idp) {
          // 使用 email + idp 作为 key
          const key = getAccountVersionKey(account.email, account.idp)
          syncState.localVersions.accounts.set(key, account.version)
        }
      }
      for (const id of changes.accounts.deleted) {
        // 删除时需要从账号信息中获取 email 和 idp
        // 注意：这里可能需要额外的逻辑来处理已删除账号的版本清理
        // 暂时保留 id 方式，因为删除操作只返回 id
        syncState.localVersions.accounts.delete(id)
      }
    }

    if (changes.groups) {
      for (const group of [...changes.groups.created, ...changes.groups.updated]) {
        if (group.version) {
          syncState.localVersions.groups.set(group.id, group.version)
        }
      }
      for (const id of changes.groups.deleted) {
        syncState.localVersions.groups.delete(id)
      }
    }

    if (changes.tags) {
      for (const tag of [...changes.tags.created, ...changes.tags.updated]) {
        if (tag.version) {
          syncState.localVersions.tags.set(tag.id, tag.version)
        }
      }
      for (const id of changes.tags.deleted) {
        syncState.localVersions.tags.delete(id)
      }
    }

    // 调用更新回调
    onUpdate(changes as {
      accounts?: { created: Account[]; updated: Account[]; deleted: string[] }
      groups?: { created: Group[]; updated: Group[]; deleted: string[] }
      tags?: { created: Tag[]; updated: Tag[]; deleted: string[] }
    })

    console.log('[SyncV2] Changes applied:', {
      accounts: {
        created: changes.accounts?.created.length ?? 0,
        updated: changes.accounts?.updated.length ?? 0,
        deleted: changes.accounts?.deleted.length ?? 0
      },
      groups: {
        created: changes.groups?.created.length ?? 0,
        updated: changes.groups?.updated.length ?? 0,
        deleted: changes.groups?.deleted.length ?? 0
      },
      tags: {
        created: changes.tags?.created.length ?? 0,
        updated: changes.tags?.updated.length ?? 0,
        deleted: changes.tags?.deleted.length ?? 0
      },
      hasMore
    })

    // 如果还有更多变更，继续获取
    if (hasMore) {
      console.log('[SyncV2] More changes available, fetching...')
      return syncChangesFromServer(onUpdate)
    }

    return { success: true }
  } catch (error) {
    console.error('[SyncV2] Sync failed:', error)
    return { success: false, error: String(error) }
  } finally {
    syncState.isSyncing = false
  }
}

/**
 * 初始化同步（获取完整快照）
 * 注意：settings 已移除，应通过独立的 apiV2.settings.list() 接口获取
 */
export async function initializeSync(): Promise<{
  success: boolean
  data?: {
    accounts: Account[]
    groups: Group[]
    tags: Tag[]
    serverTime: number
  }
  error?: string
}> {
  try {
    console.log('[SyncV2] Initializing sync with snapshot...')
    const response = await apiV2.sync.snapshot()

    if (!response.success) {
      console.error('[SyncV2] Snapshot failed')
      return { success: false, error: 'Snapshot failed' }
    }

    const { accounts, groups, tags, serverTime } = response.data

    // 更新同步时间
    syncState.lastSyncTime = serverTime

    // 清除并重建版本缓存
    clearLocalVersions()

    for (const account of accounts) {
      if (account.version && account.email && account.idp) {
        // 使用 email + idp 作为 key
        const key = getAccountVersionKey(account.email, account.idp)
        syncState.localVersions.accounts.set(key, account.version)
      }
    }

    for (const group of groups) {
      if (group.version) {
        syncState.localVersions.groups.set(group.id, group.version)
      }
    }

    for (const tag of tags) {
      if (tag.version) {
        syncState.localVersions.tags.set(tag.id, tag.version)
      }
    }

    console.log('[SyncV2] Snapshot loaded:', {
      accounts: accounts.length,
      groups: groups.length,
      tags: tags.length,
      serverTime
    })

    return {
      success: true,
      data: {
        accounts: accounts as Account[],
        groups: groups as Group[],
        tags: tags as Tag[],
        serverTime
      }
    }
  } catch (error) {
    console.error('[SyncV2] Initialize sync error:', error)
    return { success: false, error: String(error) }
  }
}

/**
 * 检查是否需要完整同步（首次加载或长时间未同步）
 */
export function needsFullSync(): boolean {
  // 如果从未同步过，需要完整同步
  if (syncState.lastSyncTime === 0) {
    return true
  }

  // 如果超过 1 小时未同步，建议完整同步
  const ONE_HOUR = 60 * 60 * 1000
  if (Date.now() - syncState.lastSyncTime > ONE_HOUR) {
    return true
  }

  return false
}

/**
 * 准备账号更新数据（添加版本号）
 * 基于 email + idp 获取版本号
 */
export function prepareAccountUpdate(
  account: Partial<Account> & { id: string; email: string; idp: string }
): Partial<Account> & { id: string; version: number } {
  const key = getAccountVersionKey(account.email, account.idp)
  const version = syncState.localVersions.accounts.get(key) ?? 1
  return { ...account, version }
}

/**
 * 准备分组更新数据（添加版本号）
 */
export function prepareGroupUpdate(
  group: Partial<Group> & { id: string }
): Partial<Group> & { id: string; version: number } {
  const version = syncState.localVersions.groups.get(group.id) ?? 1
  return { ...group, version }
}

/**
 * 准备标签更新数据（添加版本号）
 */
export function prepareTagUpdate(
  tag: Partial<Tag> & { id: string }
): Partial<Tag> & { id: string; version: number } {
  const version = syncState.localVersions.tags.get(tag.id) ?? 1
  return { ...tag, version }
}