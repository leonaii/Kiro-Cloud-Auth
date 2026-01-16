import { create } from 'zustand'
import { v4 as uuidv4 } from 'uuid'
import { apiV2 } from '../lib/api-v2'
import {
  createStateSnapshot,
  applyOptimisticUpdate,
  maskEmail as maskEmailUtil,
  maskNickname as maskNicknameUtil,
  parseTimestamp
} from '../lib/utils'
import { getAutoSyncToServer } from './sync-v2'
import type {
  Account,
  AccountGroup,
  AccountTag,
  AccountFilter,
  AccountSort,
  AccountStatus,
  AccountStats,
  AccountExportData,
  AccountImportItem,
  BatchOperationResult,
  AccountSubscription,
  SubscriptionType
} from '../types/account'
import type { LocalSettingsData } from '../../../types/local-settings'

// ============================================
// API 错误处理工具
// ============================================

/**
 * API 调用结果类型
 */
interface ApiCallResult<T> {
  success: boolean
  data?: T
  error?: string
  errorType?: string
  /** 版本冲突时服务器返回的最新数据 */
  serverData?: Account
  /** 是否发生了版本冲突 */
  isConflict?: boolean
}

/**
 * 冲突解决配置
 */
const CONFLICT_RESOLUTION_CONFIG = {
  /** 最大自动重试次数 */
  MAX_AUTO_RETRIES: 2,
  /** 是否显示冲突通知 */
  SHOW_CONFLICT_NOTIFICATION: true
}

/**
 * API 错误上下文
 */
interface ApiErrorContext {
  operation: string
  accountId?: string
  email?: string
  resourceType?: 'account' | 'group' | 'tag' | 'settings'
}

/**
 * 分类错误消息，返回用户友好的错误提示
 */
function classifyApiError(errorMessage: string): { type: string; userMessage: string } {
  const lowerMessage = errorMessage.toLowerCase()

  // 网络错误
  if (lowerMessage.includes('fetch') ||
      lowerMessage.includes('network') ||
      lowerMessage.includes('econnrefused') ||
      lowerMessage.includes('etimedout') ||
      lowerMessage.includes('enotfound')) {
    return {
      type: 'NETWORK_ERROR',
      userMessage: '网络连接失败，请检查网络设置'
    }
  }

  // 版本冲突
  if (lowerMessage.includes('version_conflict') ||
      lowerMessage.includes('conflict') ||
      lowerMessage.includes('409')) {
    return {
      type: 'VERSION_CONFLICT',
      userMessage: '数据已被其他客户端修改，请刷新后重试'
    }
  }

  // 认证错误
  if (lowerMessage.includes('unauthorized') ||
      lowerMessage.includes('401') ||
      lowerMessage.includes('invalid_grant') ||
      lowerMessage.includes('token')) {
    return {
      type: 'AUTH_ERROR',
      userMessage: '认证失败，请重新登录'
    }
  }

  // 资源不存在
  if (lowerMessage.includes('not_found') ||
      lowerMessage.includes('404') ||
      lowerMessage.includes('not found')) {
    return {
      type: 'NOT_FOUND',
      userMessage: '请求的资源不存在'
    }
  }

  // 验证错误
  if (lowerMessage.includes('validation') ||
      lowerMessage.includes('invalid') ||
      lowerMessage.includes('400')) {
    return {
      type: 'VALIDATION_ERROR',
      userMessage: '请求参数无效'
    }
  }

  // 服务器错误
  if (lowerMessage.includes('500') ||
      lowerMessage.includes('internal') ||
      lowerMessage.includes('server error')) {
    return {
      type: 'SERVER_ERROR',
      userMessage: '服务器内部错误，请稍后重试'
    }
  }

  // 默认错误
  return {
    type: 'UNKNOWN_ERROR',
    userMessage: errorMessage || '操作失败，请重试'
  }
}

/**
 * 版本冲突响应数据结构
 */
interface ConflictResponseData {
  success: false
  error: string
  errorType: string
  details?: {
    retryable?: boolean
    clientVersion?: number
    serverVersion?: number
    serverData?: Account
  }
}

/**
 * 检查响应是否为版本冲突
 */
function isVersionConflictResponse(response: unknown): response is ConflictResponseData {
  if (!response || typeof response !== 'object') return false
  const resp = response as Record<string, unknown>
  return resp.success === false &&
         (resp.errorType === 'CONFLICT_ERROR' ||
          (typeof resp.error === 'string' && resp.error.toLowerCase().includes('conflict')))
}

/**
 * API 错误处理包装器
 * 统一处理所有 API 调用的错误，避免未捕获的 Promise rejection
 * 增强版：支持版本冲突检测和服务器数据提取
 */
async function handleApiCall<T>(
  apiCall: () => Promise<T>,
  errorContext: ApiErrorContext
): Promise<ApiCallResult<T>> {
  try {
    const data = await apiCall()

    // 检查返回数据是否为版本冲突响应
    // API 可能返回 { success: false, errorType: 'CONFLICT_ERROR', details: { serverData: ... } }
    if (isVersionConflictResponse(data)) {
      const conflictData = data as ConflictResponseData
      console.warn('[API Conflict] ' + errorContext.operation + ':', {
        clientVersion: conflictData.details?.clientVersion,
        serverVersion: conflictData.details?.serverVersion,
        context: errorContext
      })

      return {
        success: false,
        error: '数据已被其他客户端修改，已自动同步最新数据',
        errorType: 'VERSION_CONFLICT',
        isConflict: true,
        serverData: conflictData.details?.serverData
      }
    }

    return { success: true, data }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    const { type, userMessage } = classifyApiError(errorMessage)

    // 记录详细错误日志
    console.error('[API Error] ' + errorContext.operation + ':', {
      errorType: type,
      errorMessage,
      context: errorContext
    })

    return {
      success: false,
      error: userMessage,
      errorType: type
    }
  }
}

/**
 * 显示冲突解决通知
 * 使用 console.info 记录，实际项目中可替换为 toast 通知
 */
function showConflictNotification(email: string): void {
  if (CONFLICT_RESOLUTION_CONFIG.SHOW_CONFLICT_NOTIFICATION) {
    console.info(`[Conflict Resolution] 账号 ${email} 已被其他客户端修改，已自动同步最新数据`)
    // 如果项目中有 toast 通知系统，可以在这里调用
    // toast.info(`账号 ${email} 已被其他客户端修改，已自动同步最新数据`)
  }
}

/**
 * 处理版本冲突并自动重试
 * 统一的冲突处理逻辑，避免代码重复
 *
 * @param accountId - 账号ID
 * @param accountEmail - 账号邮箱
 * @param serverData - 服务器返回的最新数据
 * @param originalUpdates - 原始更新内容
 * @param set - Zustand set 函数
 * @returns Promise<boolean> - 重试是否成功
 */
async function handleVersionConflict(
  accountId: string,
  accountEmail: string,
  serverData: Account,
  originalUpdates: Partial<Account>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  set: any
): Promise<boolean> {
  // 服务器优先策略：用服务器数据替换本地状态
  set((state: { accounts: Map<string, Account> }) => {
    const accounts = new Map(state.accounts)
    accounts.set(accountId, serverData)
    return { accounts }
  })

  // 显示冲突通知
  showConflictNotification(accountEmail)

  // 自动重试：使用服务器返回的新版本号重新应用用户的修改
  console.log(`[Account] Conflict detected, auto-retrying with server version: ${serverData.version}`)

  const retryResult = await handleApiCall(
    () => apiV2.accounts.update(accountId, {
      ...originalUpdates,
      version: serverData.version || 1,
      email: serverData.email,
      idp: serverData.idp
    }),
    { operation: 'update_account_retry', accountId, email: accountEmail, resourceType: 'account' }
  )

  if (retryResult.success && retryResult.data) {
    const retryResponse = retryResult.data
    if (retryResponse.success && retryResponse.data) {
      // 重试成功，更新本地状态
      set((state: { accounts: Map<string, Account> }) => {
        const accounts = new Map(state.accounts)
        const existingAccount = accounts.get(accountId)
        if (existingAccount) {
          accounts.set(accountId, {
            ...existingAccount,
            ...originalUpdates,
            version: retryResponse.data!.version
          })
        }
        return { accounts }
      })
      console.log(`[Account] Account updated after conflict resolution: ${accountEmail}`)
      return true
    }
  }

  // 重试失败，保持服务器数据
  console.warn(`[Account] Retry failed, keeping server data for: ${accountEmail}`)
  return false
}

/**
 * 批量操作结果类型（增强版）
 */
interface EnhancedBatchResult extends BatchOperationResult {
  errorsByType?: Record<string, number>
}

/**
 * 使用 Promise.allSettled 执行批量操作
 * 确保单个失败不影响其他操作
 */
async function executeBatchOperations<T>(
  operations: Array<{ id: string; operation: () => Promise<T> }>,
  operationName: string
): Promise<EnhancedBatchResult> {
  const result: EnhancedBatchResult = {
    success: 0,
    failed: 0,
    errors: [],
    errorsByType: {}
  }

  const settledResults = await Promise.allSettled(
    operations.map(async ({ id, operation }) => {
      try {
        await operation()
        return { id, success: true as const }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)
        const { type } = classifyApiError(errorMessage)
        return { id, success: false as const, error: errorMessage, errorType: type }
      }
    })
  )

  for (const settled of settledResults) {
    if (settled.status === 'fulfilled') {
      const value = settled.value
      if (value.success) {
        result.success++
      } else {
        result.failed++
        result.errors.push({ id: value.id, error: value.error || 'Unknown error' })
        if (value.errorType && result.errorsByType) {
          result.errorsByType[value.errorType] = (result.errorsByType[value.errorType] || 0) + 1
        }
      }
    } else {
      // Promise rejected（不应该发生，因为我们在内部捕获了错误）
      result.failed++
      result.errors.push({ id: 'unknown', error: settled.reason?.message || 'Unknown error' })
    }
  }

  // 记录批量操作结果
  console.log('[' + operationName + '] Batch operation completed:', {
    success: result.success,
    failed: result.failed,
    errorsByType: result.errorsByType
  })

  return result
}

// ============================================
// 账号管理 Store
// ============================================

// Web 端本地设置存储 Key
const WEB_SETTINGS_STORAGE_KEY = 'kiro-web-settings'

// 本地设置键列表（这些设置存储在客户端本地，不同步到服务器）
const LOCAL_SETTINGS_KEYS = [
  'privacyMode',
  'theme',
  'darkMode',
  'autoRefreshEnabled',
  'autoRefreshInterval',
  'statusCheckInterval',
  'autoSwitchEnabled',
  'autoSwitchThreshold',
  'autoSwitchInterval',
  'proxyEnabled',
  'proxyUrl',
  'machineIdConfig',
  'accountMachineIds',
  'machineIdHistory',
  'localActiveAccountId',
  'bitBrowserConfig'
] as const

// 重新导出 LocalSettingsData 类型，保持向后兼容
export type { LocalSettingsData }

// 自动换号定时器
let autoSwitchTimer: ReturnType<typeof setInterval> | null = null

// 定时自动保存定时器（防止数据丢失）
let autoSaveTimer: ReturnType<typeof setInterval> | null = null
const AUTO_SAVE_INTERVAL = 30 * 1000 // 每 30 秒自动保存一次

// Electron 客户端后台同步定时器
let backgroundSyncTimer: ReturnType<typeof setInterval> | null = null
const BACKGROUND_SYNC_INTERVAL = 10 * 1000 // 每 10 秒同步一次
const BACKGROUND_SYNC_TIMEOUT = 3 * 1000 // 3 秒超时
let lastSaveHash = '' // 用于检测数据是否变化

interface AccountsState {
  // 应用版本号
  appVersion: string

  // 数据
  accounts: Map<string, Account>
  groups: Map<string, AccountGroup>
  tags: Map<string, AccountTag>

  // 当前激活账号（数据库同步用，Web 模式）
  activeAccountId: string | null
  // 本地激活账号（仅 Electron 本地维护，不同步到数据库）
  localActiveAccountId: string | null

  // 筛选和排序
  filter: AccountFilter
  sort: AccountSort

  // 选中的账号（用于批量操作）
  selectedIds: Set<string>

  // 加载状态
  isLoading: boolean
  isSyncing: boolean

  // 自动刷新设置
  autoRefreshEnabled: boolean
  autoRefreshInterval: number // 分钟
  statusCheckInterval: number // 分钟

  // 隐私模式
  privacyMode: boolean

  // 代理设置
  proxyEnabled: boolean
  proxyUrl: string // 格式: http://host:port 或 socks5://host:port

  // 自动换号设置
  autoSwitchEnabled: boolean
  autoSwitchThreshold: number // 余额阈值，低于此值时自动切换
  autoSwitchInterval: number // 检查间隔（分钟）

  // 主题设置
  theme: string // 主题名称: default, purple, emerald, orange, rose, cyan, amber
  darkMode: boolean // 深色模式

  // 机器码管理
  machineIdConfig: {
    autoSwitchOnAccountChange: boolean // 切号时自动更换机器码
    bindMachineIdToAccount: boolean // 账户机器码绑定
    useBindedMachineId: boolean // 使用绑定的机器码（否则随机生成）
  }
  currentMachineId: string // 当前机器码
  originalMachineId: string | null // 备份的原始机器码
  originalBackupTime: number | null // 原始机器码备份时间
  accountMachineIds: Record<string, string> // 账户绑定的机器码映射
  machineIdHistory: Array<{
    id: string
    machineId: string
    timestamp: number
    action: 'initial' | 'manual' | 'auto_switch' | 'restore' | 'bind'
    accountId?: string
    accountEmail?: string
  }>

  // 比特浏览器配置
  bitBrowserConfig: {
    enabled: boolean // 是否启用比特浏览器打开登录页面
    port: number // 比特浏览器 API 端口号，默认 54345
    browserId: string // 比特浏览器窗口 ID
  }
}

interface AccountsActions {
  // 账号 CRUD
  addAccount: (account: Omit<Account, 'id' | 'createdAt' | 'isActive'>) => Promise<string>
  updateAccount: (id: string, updates: Partial<Account>) => Promise<void>

  // 软删除和恢复
  deleteAccount: (id: string) => Promise<boolean>
  batchDeleteAccounts: (ids: string[]) => Promise<BatchOperationResult>
  restoreAccount: (id: string) => Promise<boolean>
  batchRestoreAccounts: (ids: string[]) => Promise<BatchOperationResult>

  // 激活账号
  setActiveAccount: (id: string | null) => void
  getActiveAccount: () => Account | null

  // 分组操作
  addGroup: (group: Omit<AccountGroup, 'id' | 'createdAt' | 'order'>) => Promise<string>
  updateGroup: (id: string, updates: Partial<AccountGroup>) => Promise<void>
  removeGroup: (id: string) => Promise<void>
  moveAccountsToGroup: (accountIds: string[], groupId: string | undefined) => Promise<void>

  // 标签操作
  addTag: (tag: Omit<AccountTag, 'id'>) => Promise<string>
  updateTag: (id: string, updates: Partial<AccountTag>) => Promise<void>
  removeTag: (id: string) => Promise<void>
  addTagToAccounts: (accountIds: string[], tagId: string) => Promise<void>
  removeTagFromAccounts: (accountIds: string[], tagId: string) => Promise<void>

  // 筛选和排序
  setFilter: (filter: AccountFilter) => void
  clearFilter: () => void
  setSort: (sort: AccountSort) => void
  setShowDeleted: (showDeleted: boolean) => void
  getFilteredAccounts: () => Account[]

  // 选择操作
  selectAccount: (id: string) => void
  deselectAccount: (id: string) => void
  selectAll: () => void
  deselectAll: () => void
  toggleSelection: (id: string) => void
  getSelectedAccounts: () => Account[]

  // 导入导出
  exportAccounts: (ids?: string[]) => AccountExportData
  importAccounts: (items: AccountImportItem[]) => BatchOperationResult
  // 支持标准导出格式和简化数组格式
  importFromExportData: (data: AccountExportData | unknown[]) => Promise<BatchOperationResult>

  // 状态管理
  updateAccountStatus: (id: string, status: AccountStatus, error?: string) => void
  refreshAccountToken: (id: string) => Promise<boolean>
  batchRefreshTokens: (ids: string[]) => Promise<BatchOperationResult>
  checkAccountStatus: (id: string) => Promise<void>
  batchCheckStatus: (ids: string[]) => Promise<BatchOperationResult>

  // 统计
  getStats: () => AccountStats

  // 持久化
  loadFromStorage: () => Promise<void>
  saveToStorage: () => Promise<void>

  // 设置
  setAutoRefresh: (enabled: boolean, interval?: number) => void
  setStatusCheckInterval: (interval: number) => void

  // 隐私模式
  setPrivacyMode: (enabled: boolean) => void
  maskEmail: (email: string) => string
  maskNickname: (nickname: string | undefined) => string

  // 代理设置
  setProxy: (enabled: boolean, url?: string) => void

  // 主题设置
  setTheme: (theme: string) => void
  setDarkMode: (enabled: boolean) => void
  applyTheme: () => void

  // 自动换号
  setAutoSwitch: (enabled: boolean, threshold?: number, interval?: number) => void
  startAutoSwitch: () => void
  stopAutoSwitch: () => void
  checkAndAutoSwitch: () => Promise<void>


  // 定时自动保存（防止数据丢失）
  startAutoSave: () => void
  stopAutoSave: () => void

  // Electron 客户端后台同步（从服务器拉取最新账号信息）
  startBackgroundSync: () => void
  stopBackgroundSync: () => void
  syncAccountsFromServer: () => Promise<void>

  // 机器码管理
  setMachineIdConfig: (config: Partial<{
    autoSwitchOnAccountChange: boolean
    bindMachineIdToAccount: boolean
    useBindedMachineId: boolean
  }>) => void

  // 比特浏览器配置
  setBitBrowserConfig: (config: Partial<{
    enabled: boolean
    port: number
    browserId: string
  }>) => void
  refreshCurrentMachineId: () => Promise<void>
  changeMachineId: (newMachineId?: string) => Promise<boolean>
  restoreOriginalMachineId: () => Promise<boolean>
  bindMachineIdToAccount: (accountId: string, machineId?: string) => void
  getMachineIdForAccount: (accountId: string) => string | null
  backupOriginalMachineId: () => void
  clearMachineIdHistory: () => void
}

type AccountsStore = AccountsState & AccountsActions

// 默认排序
const defaultSort: AccountSort = { field: 'createdAt', order: 'desc' }

// 默认筛选
const defaultFilter: AccountFilter = {}

export const useAccountsStore = create<AccountsStore>()((set, get) => ({
  // 初始状态
  appVersion: '1.0.0',
  accounts: new Map(),
  groups: new Map(),
  tags: new Map(),
  activeAccountId: null,
  localActiveAccountId: null,
  filter: defaultFilter,
  sort: defaultSort,
  selectedIds: new Set(),
  isLoading: false,
  isSyncing: false,
  autoRefreshEnabled: false,
  autoRefreshInterval: 5,
  statusCheckInterval: 60,
  privacyMode: false,
  proxyEnabled: false,
  proxyUrl: '',
  autoSwitchEnabled: false,
  autoSwitchThreshold: 0,
  autoSwitchInterval: 5,
  theme: 'default',
  darkMode: false,

  machineIdConfig: {
    autoSwitchOnAccountChange: true, // 默认启用切换账号时自动更换机器码
    bindMachineIdToAccount: false,
    useBindedMachineId: false
  },
  currentMachineId: '',
  originalMachineId: null,
  originalBackupTime: null,
  accountMachineIds: {},
  machineIdHistory: [],

  // 比特浏览器配置
  bitBrowserConfig: {
    enabled: false, // 默认不启用
    port: 54345, // 默认端口
    browserId: '' // 默认空，需要用户填写
  },

  // ==================== 账号 CRUD ====================

  addAccount: async (accountData) => {
    const id = uuidv4()
    const now = Date.now()

    const account: Account = {
      ...accountData,
      id,
      createdAt: now,
      lastUsedAt: now,
      isActive: false,
      tags: accountData.tags || [],
      version: 1,
      // 标记账号是否需要同步到服务器
      needsSync: !getAutoSyncToServer()
    }

    // 保存状态快照用于回滚
    const snapshot = createStateSnapshot(get().accounts)

    // 先更新本地状态（乐观更新）
    set((state: { accounts: Map<string, Account> }) => ({
      accounts: applyOptimisticUpdate(state.accounts, id, account)
    }))

    // 检查是否需要自动同步到服务器
    if (!getAutoSyncToServer()) {
      // 不自动同步，只保存在本地
      console.log(`[Account] Account created locally (not synced): ${account.email}`)
      return id
    }

    // 使用 handleApiCall 包装 API 调用
    const result = await handleApiCall(
      () => apiV2.accounts.create({ ...account, version: 1, needsSync: undefined }),
      { operation: 'create_account', accountId: id, email: account.email, resourceType: 'account' }
    )

    if (result.success && result.data) {
      const response = result.data
      if (response.success && response.data) {
        // 更新本地状态，使用服务器返回的版本号，并清除 needsSync 标记
        set((state: { accounts: Map<string, Account> }) => ({
          accounts: applyOptimisticUpdate(state.accounts, id, { version: response.data!.version, needsSync: false })
        }))
        console.log(`[Account] Account created via V2 API: ${account.email}`)
        return id
      } else {
        // API 返回失败，回滚本地状态
        console.error('[Account] Failed to create account via V2 API:', response.error)
        set({ accounts: snapshot })
        throw new Error(response.error || response.message || 'Failed to create account')
      }
    } else {
      // 网络或其他错误，回滚本地状态
      console.error('[Account] Error creating account:', result.error)
      set({ accounts: snapshot })
      throw new Error(result.error || 'Failed to create account')
    }
  },

  updateAccount: async (id, updates) => {
    const { accounts } = get()
    const account = accounts.get(id)

    if (!account) {
      console.error('[Account] Account not found:', id)
      return
    }

    // 保存状态快照用于回滚
    const snapshot = createStateSnapshot(accounts)
    // 保存原始更新内容，用于冲突后重试
    const originalUpdates = { ...updates }

    // 先更新本地状态（乐观更新）
    set((state: { accounts: Map<string, Account> }) => ({
      accounts: applyOptimisticUpdate(state.accounts, id, updates)
    }))

    // 使用 handleApiCall 包装 API 调用
    // 传递 email 和 idp 用于版本号管理
    const result = await handleApiCall(
      () => apiV2.accounts.update(id, {
        ...updates,
        version: account.version || 1,
        email: account.email,
        idp: account.idp
      }),
      { operation: 'update_account', accountId: id, email: account.email, resourceType: 'account' }
    )

    if (result.success && result.data) {
      const response = result.data
      if (response.success && response.data) {
        // 更新本地状态，使用服务器返回的新版本号
        set((state: { accounts: Map<string, Account> }) => ({
          accounts: applyOptimisticUpdate(state.accounts, id, { version: response.data!.version })
        }))
        console.log(`[Account] Account updated via V2 API: ${account.email}`)
      } else if (isVersionConflictResponse(response)) {
        // 版本冲突：服务器返回了冲突响应
        const conflictResponse = response as unknown as ConflictResponseData
        const serverData = conflictResponse.details?.serverData

        if (serverData) {
          // 使用统一的冲突处理函数
          await handleVersionConflict(id, account.email, serverData, originalUpdates, set)
        } else {
          // 没有服务器数据，回滚到快照
          console.error('[Account] Conflict without server data, rolling back')
          set({ accounts: snapshot })
        }
      } else {
        // API 返回其他失败，回滚本地状态
        console.error('[Account] Failed to update account via V2 API:', response.error)
        set({ accounts: snapshot })
      }
    } else if (result.isConflict && result.serverData) {
      // handleApiCall 检测到冲突并提取了服务器数据
      await handleVersionConflict(id, account.email, result.serverData, originalUpdates, set)
    } else {
      // 网络或其他错误，回滚本地状态
      console.error('[Account] Error updating account:', result.error)
      set({ accounts: snapshot })
    }
  },

  // ==================== 软删除和恢复 ====================

  deleteAccount: async (id) => {
    const { accounts, activeAccountId, localActiveAccountId } = get()
    const account = accounts.get(id)

    if (!account) {
      console.error('[Account] Account not found:', id)
      return false
    }

    // 保存状态快照用于回滚
    const snapshot = {
      accounts: createStateSnapshot(accounts),
      activeAccountId,
      localActiveAccountId
    }

    // 先更新本地状态（乐观更新）
    const now = Date.now()
    set((state: { accounts: Map<string, Account>; activeAccountId: string | null; localActiveAccountId: string | null }) => {
      const updatedAccounts = applyOptimisticUpdate(state.accounts, id, { isDel: true, deletedAt: now })
      // 如果是当前激活账号，清除激活状态
      const newActiveAccountId = state.activeAccountId === id ? null : state.activeAccountId
      const newLocalActiveAccountId = state.localActiveAccountId === id ? null : state.localActiveAccountId
      return { accounts: updatedAccounts, activeAccountId: newActiveAccountId, localActiveAccountId: newLocalActiveAccountId }
    })

    // 使用 handleApiCall 包装 API 调用
    const result = await handleApiCall(
      () => apiV2.accounts.delete(id),
      { operation: 'delete_account', accountId: id, email: account.email, resourceType: 'account' }
    )

    if (result.success && result.data) {
      const response = result.data
      if (response.success) {
        // 删除操作成功，保持本地状态（已在乐观更新中设置）
        console.log(`[Account] Account deleted via V2 API: ${account.email}`)
        return true
      } else {
        // API 返回失败，回滚本地状态
        console.error('[Account] Failed to delete account via V2 API:', response.error)
        set({
          accounts: snapshot.accounts,
          activeAccountId: snapshot.activeAccountId,
          localActiveAccountId: snapshot.localActiveAccountId
        })
        return false
      }
    } else {
      // 网络或其他错误，回滚本地状态
      console.error('[Account] Error deleting account:', result.error)
      set({
        accounts: snapshot.accounts,
        activeAccountId: snapshot.activeAccountId,
        localActiveAccountId: snapshot.localActiveAccountId
      })
      return false
    }
  },

  batchDeleteAccounts: async (ids) => {
    // 使用 executeBatchOperations 统一处理批量操作
    const operations = ids.map(id => ({
      id,
      operation: async () => {
        const success = await get().deleteAccount(id)
        if (!success) throw new Error('Delete failed')
      }
    }))

    return executeBatchOperations(operations, 'batchDeleteAccounts')
  },

  restoreAccount: async (id) => {
    const { accounts } = get()
    const account = accounts.get(id)

    if (!account) {
      console.error('[Account] Account not found:', id)
      return false
    }

    // 保存状态快照用于回滚
    const snapshot = createStateSnapshot(accounts)

    // 先更新本地状态（乐观更新）
    set((state: { accounts: Map<string, Account> }) => ({
      accounts: applyOptimisticUpdate(state.accounts, id, { isDel: false, deletedAt: undefined })
    }))

    // 使用 handleApiCall 包装 API 调用
    const result = await handleApiCall(
      () => apiV2.accounts.update(id, {
        isDel: false,
        deletedAt: undefined,
        version: account.version || 1,
        email: account.email,
        idp: account.idp
      }),
      { operation: 'restore_account', accountId: id, email: account.email, resourceType: 'account' }
    )

    if (result.success && result.data) {
      const response = result.data
      if (response.success && response.data) {
        // 更新本地状态，使用服务器返回的版本号
        set((state: { accounts: Map<string, Account> }) => ({
          accounts: applyOptimisticUpdate(state.accounts, id, { version: response.data!.version })
        }))
        console.log(`[Account] Account restored via V2 API: ${account.email}`)
        return true
      } else {
        // API 返回失败，回滚本地状态
        console.error('[Account] Failed to restore account via V2 API:', response.error)
        set({ accounts: snapshot })
        return false
      }
    } else {
      // 网络或其他错误，回滚本地状态
      console.error('[Account] Error restoring account:', result.error)
      set({ accounts: snapshot })
      return false
    }
  },

  batchRestoreAccounts: async (ids) => {
    // 使用 executeBatchOperations 统一处理批量操作
    const operations = ids.map(id => ({
      id,
      operation: async () => {
        const success = await get().restoreAccount(id)
        if (!success) throw new Error('Restore failed')
      }
    }))

    return executeBatchOperations(operations, 'batchRestoreAccounts')
  },

  // ==================== 激活账号 ====================

  setActiveAccount: async (id) => {
    const state = get()

    // 检测是否是 Electron 环境
    const isElectronEnv = typeof window !== 'undefined' &&
      window.api &&
      typeof window.api.getAppVersion === 'function' &&
      !(window.api as { __isWebAdapter?: boolean }).__isWebAdapter

    if (isElectronEnv) {
      // Electron 模式：只更新本地状态，不修改账号的 isActive 字段
      set({ localActiveAccountId: id })
      // 注意：不再更新 lastUsedAt，避免切换账号时改变排序
    } else {
      // Web 模式：保持原有逻辑
      set((s) => {
        const accounts = new Map(s.accounts)

        // 取消之前的激活状态
        if (s.activeAccountId) {
          const prev = accounts.get(s.activeAccountId)
          if (prev) {
            accounts.set(s.activeAccountId, { ...prev, isActive: false })
          }
        }

        // 设置新的激活状态
        if (id) {
          const account = accounts.get(id)
          if (account) {
            accounts.set(id, { ...account, isActive: true, lastUsedAt: Date.now() })
          }
        }

        return { accounts, activeAccountId: id }
      })
    }

    // 切换账号时自动更换机器码（如果启用）
    if (id && state.machineIdConfig.autoSwitchOnAccountChange) {
      try {
        const account = state.accounts.get(id)

        if (state.machineIdConfig.bindMachineIdToAccount) {
          // 使用账户绑定的机器码
          let boundMachineId = state.accountMachineIds[id]

          if (!boundMachineId) {
            // 如果没有绑定机器码，为该账户生成一个
            boundMachineId = await window.api.machineIdGenerateRandom()
            get().bindMachineIdToAccount(id, boundMachineId)
          }

          if (state.machineIdConfig.useBindedMachineId) {
            // 使用绑定的机器码
            await get().changeMachineId(boundMachineId)
          } else {
            // 随机生成新机器码
            await get().changeMachineId()
          }
        } else {
          // 每次切换都随机生成新机器码
          await get().changeMachineId()
        }

        // 更新历史记录
        const newMachineId = get().currentMachineId
        set((s) => ({
          machineIdHistory: [
            ...s.machineIdHistory,
            {
              id: crypto.randomUUID(),
              machineId: newMachineId,
              timestamp: Date.now(),
              action: 'auto_switch' as const,
              accountId: id,
              accountEmail: account?.email
            }
          ]
        }))

        console.log(`[MachineId] Auto-switched machine ID for account: ${account?.email}`)
      } catch (error) {
        console.error('[MachineId] Failed to auto-switch machine ID:', error)
      }
    }

    get().saveToStorage()
  },

  getActiveAccount: () => {
    const { accounts, activeAccountId, localActiveAccountId } = get()
    // Electron 模式优先使用 localActiveAccountId
    const effectiveId = localActiveAccountId || activeAccountId
    return effectiveId ? accounts.get(effectiveId) ?? null : null
  },

  // ==================== 分组操作 ====================

  addGroup: async (groupData) => {
    const id = uuidv4()
    const { groups } = get()

    const group: AccountGroup = {
      ...groupData,
      id,
      order: groups.size,
      createdAt: Date.now(),
      version: 1
    }

    // 保存状态快照用于回滚
    const snapshot = new Map(groups)

    // 先更新本地状态（乐观更新）
    set((state) => {
      const groups = new Map(state.groups)
      groups.set(id, group)
      return { groups }
    })

    // 使用 handleApiCall 包装 API 调用
    const result = await handleApiCall(
      () => apiV2.groups.create({ ...group, version: 1 }),
      { operation: 'create_group', resourceType: 'group' }
    )

    if (result.success && result.data) {
      const response = result.data
      if (response.success && response.data) {
        // 更新本地状态，使用服务器返回的版本号
        set((state) => {
          const groups = new Map(state.groups)
          const existingGroup = groups.get(id)
          if (existingGroup) {
            groups.set(id, {
              ...existingGroup,
              version: response.data!.version
            })
          }
          return { groups }
        })
        console.log(`[Group] Group created via V2 API: ${group.name}`)
        return id
      } else {
        // API 返回失败，回滚本地状态
        console.error('[Group] Failed to create group via V2 API:', response.error)
        set({ groups: snapshot })
        throw new Error(response.error || response.message || 'Failed to create group')
      }
    } else {
      // 网络或其他错误，回滚本地状态
      console.error('[Group] Error creating group:', result.error)
      set({ groups: snapshot })
      throw new Error(result.error || 'Failed to create group')
    }
  },

  updateGroup: async (id, updates) => {
    const { groups } = get()
    const group = groups.get(id)

    if (!group) {
      console.error('[Group] Group not found:', id)
      return
    }

    // 保存状态快照用于回滚
    const snapshot = new Map(groups)

    // 先更新本地状态（乐观更新）
    set((state) => {
      const groups = new Map(state.groups)
      groups.set(id, { ...group, ...updates })
      return { groups }
    })

    // 使用 handleApiCall 包装 API 调用
    const result = await handleApiCall(
      () => apiV2.groups.update(id, { ...updates, version: group.version || 1 }),
      { operation: 'update_group', resourceType: 'group' }
    )

    if (result.success && result.data) {
      const response = result.data
      if (response.success && response.data) {
        // 更新本地状态，使用服务器返回的新版本号
        set((state) => {
          const groups = new Map(state.groups)
          const existingGroup = groups.get(id)
          if (existingGroup) {
            groups.set(id, {
              ...existingGroup,
              version: response.data!.version
            })
          }
          return { groups }
        })
        console.log(`[Group] Group updated via V2 API: ${group.name}`)
      } else {
        // API 返回失败，回滚本地状态
        console.error('[Group] Failed to update group via V2 API:', response.error)
        set({ groups: snapshot })
      }
    } else {
      // 网络或其他错误，回滚本地状态
      console.error('[Group] Error updating group:', result.error)
      set({ groups: snapshot })
    }
  },

  removeGroup: async (id) => {
    const { groups, accounts } = get()
    const group = groups.get(id)

    if (!group) {
      console.error('[Group] Group not found:', id)
      return
    }

    // 保存状态快照用于回滚
    const groupsSnapshot = new Map(groups)
    const accountsSnapshot = new Map(accounts)

    // 先更新本地状态（乐观更新）
    set((state) => {
      const groups = new Map(state.groups)
      groups.delete(id)

      // 移除账号的分组引用
      const accounts = new Map(state.accounts)
      for (const [accountId, account] of accounts) {
        if (account.groupId === id) {
          accounts.set(accountId, { ...account, groupId: undefined })
        }
      }

      return { groups, accounts }
    })

    // 使用 handleApiCall 包装 API 调用
    const result = await handleApiCall(
      () => apiV2.groups.delete(id),
      { operation: 'delete_group', resourceType: 'group' }
    )

    if (result.success && result.data) {
      const response = result.data
      if (response.success) {
        console.log(`[Group] Group deleted via V2 API: ${group.name}`)
      } else {
        // API 返回失败，回滚本地状态
        console.error('[Group] Failed to delete group via V2 API:', response.error)
        set({ groups: groupsSnapshot, accounts: accountsSnapshot })
      }
    } else {
      // 网络或其他错误，回滚本地状态
      console.error('[Group] Error deleting group:', result.error)
      set({ groups: groupsSnapshot, accounts: accountsSnapshot })
    }
  },

  moveAccountsToGroup: async (accountIds, groupId) => {
    const { accounts } = get()

    // 循环调用 V2 API 更新每个账号的分组
    for (const id of accountIds) {
      const account = accounts.get(id)
      if (account) {
        try {
          await get().updateAccount(id, { groupId })
        } catch (error) {
          console.error(`[Account] Failed to move account ${id} to group:`, error)
        }
      }
    }
  },

  // ==================== 标签操作 ====================

  addTag: async (tagData) => {
    const id = uuidv4()
    const { tags } = get()

    const tag: AccountTag = { ...tagData, id, version: 1 }

    // 保存状态快照用于回滚
    const snapshot = new Map(tags)

    // 先更新本地状态（乐观更新）
    set((state) => {
      const tags = new Map(state.tags)
      tags.set(id, tag)
      return { tags }
    })

    // 使用 handleApiCall 包装 API 调用
    const result = await handleApiCall(
      () => apiV2.tags.create({ ...tag, version: 1 }),
      { operation: 'create_tag', resourceType: 'tag' }
    )

    if (result.success && result.data) {
      const response = result.data
      if (response.success && response.data) {
        // 更新本地状态，使用服务器返回的版本号
        set((state) => {
          const tags = new Map(state.tags)
          const existingTag = tags.get(id)
          if (existingTag) {
            tags.set(id, {
              ...existingTag,
              version: response.data!.version
            })
          }
          return { tags }
        })
        console.log(`[Tag] Tag created via V2 API: ${tag.name}`)
        return id
      } else {
        // API 返回失败，回滚本地状态
        console.error('[Tag] Failed to create tag via V2 API:', response.error)
        set({ tags: snapshot })
        throw new Error(response.error || response.message || 'Failed to create tag')
      }
    } else {
      // 网络或其他错误，回滚本地状态
      console.error('[Tag] Error creating tag:', result.error)
      set({ tags: snapshot })
      throw new Error(result.error || 'Failed to create tag')
    }
  },

  updateTag: async (id, updates) => {
    const { tags } = get()
    const tag = tags.get(id)

    if (!tag) {
      console.error('[Tag] Tag not found:', id)
      return
    }

    // 保存状态快照用于回滚
    const snapshot = new Map(tags)

    // 先更新本地状态（乐观更新）
    set((state) => {
      const tags = new Map(state.tags)
      tags.set(id, { ...tag, ...updates })
      return { tags }
    })

    // 使用 handleApiCall 包装 API 调用
    const result = await handleApiCall(
      () => apiV2.tags.update(id, { ...updates, version: tag.version || 1 }),
      { operation: 'update_tag', resourceType: 'tag' }
    )

    if (result.success && result.data) {
      const response = result.data
      if (response.success && response.data) {
        // 更新本地状态，使用服务器返回的新版本号
        set((state) => {
          const tags = new Map(state.tags)
          const existingTag = tags.get(id)
          if (existingTag) {
            tags.set(id, {
              ...existingTag,
              version: response.data!.version
            })
          }
          return { tags }
        })
        console.log(`[Tag] Tag updated via V2 API: ${tag.name}`)
      } else {
        // API 返回失败，回滚本地状态
        console.error('[Tag] Failed to update tag via V2 API:', response.error)
        set({ tags: snapshot })
      }
    } else {
      // 网络或其他错误，回滚本地状态
      console.error('[Tag] Error updating tag:', result.error)
      set({ tags: snapshot })
    }
  },

  removeTag: async (id) => {
    const { tags, accounts } = get()
    const tag = tags.get(id)

    if (!tag) {
      console.error('[Tag] Tag not found:', id)
      return
    }

    // 保存状态快照用于回滚
    const tagsSnapshot = new Map(tags)
    const accountsSnapshot = new Map(accounts)

    // 先更新本地状态（乐观更新）
    set((state) => {
      const tags = new Map(state.tags)
      tags.delete(id)

      // 移除账号的标签引用
      const accounts = new Map(state.accounts)
      for (const [accountId, account] of accounts) {
        if (account.tags.includes(id)) {
          accounts.set(accountId, {
            ...account,
            tags: account.tags.filter((t) => t !== id)
          })
        }
      }

      return { tags, accounts }
    })

    // 使用 handleApiCall 包装 API 调用
    const result = await handleApiCall(
      () => apiV2.tags.delete(id),
      { operation: 'delete_tag', resourceType: 'tag' }
    )

    if (result.success && result.data) {
      const response = result.data
      if (response.success) {
        console.log(`[Tag] Tag deleted via V2 API: ${tag.name}`)
      } else {
        // API 返回失败，回滚本地状态
        console.error('[Tag] Failed to delete tag via V2 API:', response.error)
        set({ tags: tagsSnapshot, accounts: accountsSnapshot })
      }
    } else {
      // 网络或其他错误，回滚本地状态
      console.error('[Tag] Error deleting tag:', result.error)
      set({ tags: tagsSnapshot, accounts: accountsSnapshot })
    }
  },

  addTagToAccounts: async (accountIds, tagId) => {
    const { accounts } = get()

    // 循环调用 V2 API 更新每个账号的标签
    for (const id of accountIds) {
      const account = accounts.get(id)
      if (account && !account.tags.includes(tagId)) {
        try {
          await get().updateAccount(id, { tags: [...account.tags, tagId] })
        } catch (error) {
          console.error(`[Account] Failed to add tag to account ${id}:`, error)
        }
      }
    }
  },

  removeTagFromAccounts: async (accountIds, tagId) => {
    const { accounts } = get()

    // 循环调用 V2 API 更新每个账号的标签
    for (const id of accountIds) {
      const account = accounts.get(id)
      if (account && account.tags.includes(tagId)) {
        try {
          await get().updateAccount(id, { tags: account.tags.filter((t) => t !== tagId) })
        } catch (error) {
          console.error(`[Account] Failed to remove tag from account ${id}:`, error)
        }
      }
    }
  },

  // ==================== 筛选和排序 ====================

  setFilter: (filter) => {
    set({ filter })
  },

  clearFilter: () => {
    set({ filter: defaultFilter })
  },

  setSort: (sort) => {
    set({ sort })
  },

  setShowDeleted: (showDeleted) => {
    set((state) => ({
      filter: { ...state.filter, showDeleted }
    }))
  },

  getFilteredAccounts: () => {
    const { accounts, filter, sort } = get()

    let result = Array.from(accounts.values())

    // 软删除筛选：默认不显示已删除账号，除非明确设置 showDeleted
    if (filter.showDeleted) {
      // 只显示已删除的账号
      result = result.filter((a) => a.isDel === true)
    } else {
      // 只显示未删除的账号
      result = result.filter((a) => !a.isDel)
    }

    // 应用筛选
    if (filter.search) {
      const search = filter.search.toLowerCase()
      result = result.filter(
        (a) =>
          (a.email || '').toLowerCase().includes(search) ||
          (a.nickname || '').toLowerCase().includes(search)
      )
    }

    if (filter.subscriptionTypes?.length) {
      result = result.filter((a) => filter.subscriptionTypes!.includes(a.subscription.type))
    }

    if (filter.statuses?.length) {
      result = result.filter((a) => filter.statuses!.includes(a.status))
    }

    if (filter.idps?.length) {
      result = result.filter((a) => filter.idps!.includes(a.idp))
    }

    if (filter.groupIds?.length) {
      // 支持未分组筛选：使用特殊标识 '__ungrouped__'
      const hasUngrouped = filter.groupIds.includes('__ungrouped__')
      const otherGroupIds = filter.groupIds.filter(id => id !== '__ungrouped__')
      
      result = result.filter((a) => {
        // 如果选中了未分组，且账号没有分组
        if (hasUngrouped && !a.groupId) {
          return true
        }
        // 如果账号有分组，且分组在筛选列表中
        if (a.groupId && otherGroupIds.includes(a.groupId)) {
          return true
        }
        return false
      })
    }

    if (filter.tagIds?.length) {
      result = result.filter((a) => filter.tagIds!.some((t) => a.tags.includes(t)))
    }

    if (filter.usageMin !== undefined) {
      result = result.filter((a) => a.usage.percentUsed >= filter.usageMin!)
    }

    if (filter.usageMax !== undefined) {
      result = result.filter((a) => a.usage.percentUsed <= filter.usageMax!)
    }

    if (filter.daysRemainingMin !== undefined) {
      result = result.filter(
        (a) => a.subscription.daysRemaining !== undefined &&
               a.subscription.daysRemaining >= filter.daysRemainingMin!
      )
    }

    if (filter.daysRemainingMax !== undefined) {
      result = result.filter(
        (a) => a.subscription.daysRemaining !== undefined &&
               a.subscription.daysRemaining <= filter.daysRemainingMax!
      )
    }

    // 应用排序
    result.sort((a, b) => {
      let cmp = 0

      switch (sort.field) {
        case 'email':
          cmp = a.email.localeCompare(b.email)
          break
        case 'nickname':
          cmp = (a.nickname ?? '').localeCompare(b.nickname ?? '')
          break
        case 'subscription':
          cmp = a.subscription.type.localeCompare(b.subscription.type)
          break
        case 'usage':
          cmp = a.usage.percentUsed - b.usage.percentUsed
          break
        case 'daysRemaining':
          cmp = (a.subscription.daysRemaining ?? 999) - (b.subscription.daysRemaining ?? 999)
          break
        case 'lastUsedAt':
          cmp = a.lastUsedAt - b.lastUsedAt
          break
        case 'createdAt':
          cmp = a.createdAt - b.createdAt
          break
        case 'status':
            cmp = a.status.localeCompare(b.status)
            break
        }

        return sort.order === 'desc' ? -cmp : cmp
      })

      // 本地顶置：将本地激活账号（localActiveAccountId）置顶
      // 仅在 Electron 环境下生效，不影响服务器数据排序
      const { localActiveAccountId } = get()
      if (localActiveAccountId) {
        const activeIndex = result.findIndex(a => a.id === localActiveAccountId)
        if (activeIndex > 0) {
          // 将激活账号移到数组开头
          const [activeAccount] = result.splice(activeIndex, 1)
          // 空值安全检查：确保 activeAccount 存在后再添加
          if (activeAccount) {
            result.unshift(activeAccount)
          }
        }
      }

      return result
    },

  // ==================== 选择操作 ====================

  selectAccount: (id) => {
    set((state) => {
      const selectedIds = new Set(state.selectedIds)
      selectedIds.add(id)
      return { selectedIds }
    })
  },

  deselectAccount: (id) => {
    set((state) => {
      const selectedIds = new Set(state.selectedIds)
      selectedIds.delete(id)
      return { selectedIds }
    })
  },

  selectAll: () => {
    const filtered = get().getFilteredAccounts()
    set({ selectedIds: new Set(filtered.map((a) => a.id)) })
  },

  deselectAll: () => {
    set({ selectedIds: new Set() })
  },

  toggleSelection: (id) => {
    set((state) => {
      const selectedIds = new Set(state.selectedIds)
      if (selectedIds.has(id)) {
        selectedIds.delete(id)
      } else {
        selectedIds.add(id)
      }
      return { selectedIds }
    })
  },

  getSelectedAccounts: () => {
    const { accounts, selectedIds } = get()
    return Array.from(selectedIds)
      .map((id) => accounts.get(id))
      .filter((a): a is Account => a !== undefined)
  },

  // ==================== 导入导出 ====================

  exportAccounts: (ids) => {
    const { accounts, groups, tags } = get()

    let exportAccounts: Account[]
    if (ids?.length) {
      exportAccounts = ids
        .map((id) => accounts.get(id))
        .filter((a): a is Account => a !== undefined)
    } else {
      exportAccounts = Array.from(accounts.values())
    }

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const data: AccountExportData = {
      version: get().appVersion,
      exportedAt: Date.now(),
      accounts: exportAccounts.map(({ isActive, ...rest }) => rest),
      groups: Array.from(groups.values()),
      tags: Array.from(tags.values())
    }

    return data
  },

  importAccounts: (items) => {
    const result: BatchOperationResult = { success: 0, failed: 0, errors: [] }

    for (const item of items) {
      try {
        const now = Date.now()

        const account: Omit<Account, 'id' | 'createdAt' | 'isActive'> = {
          email: item.email,
          nickname: item.nickname,
          idp: item.idp ?? 'Google',
          credentials: {
            accessToken: item.accessToken,
            csrfToken: item.csrfToken,
            refreshToken: item.refreshToken,
            expiresAt: now + 3600 * 1000
          },
          subscription: {
            type: 'Free'
          },
          usage: {
            current: 0,
            limit: 25,
            percentUsed: 0,
            lastUpdated: now
          },
          groupId: item.groupId,
          tags: item.tags ?? [],
          status: 'unknown',
          lastUsedAt: now
        }

        get().addAccount(account)
        result.success++
      } catch (error) {
        result.failed++
        result.errors.push({
          id: item.email,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }

    return result
  },

  importFromExportData: async (data) => {
    const result: BatchOperationResult = { success: 0, failed: 0, errors: [] }
    const { accounts: existingAccounts } = get()

    // 检查账户是否已存在（通过 email + idp 组合判断）
    const isAccountExists = (email: string, idp: string): boolean => {
      return Array.from(existingAccounts.values()).some(
        acc => acc.email === email && acc.idp === idp
      )
    }

    // 检测是否是简化数组格式（外部工具导出的格式）
    // 简化格式：[{ id, email, refreshToken, accessToken, usageLimits, ... }]
    interface SimplifiedAccount {
      id: string
      email: string
      refreshToken: string
      profileArn?: string
      expiresAt: string
      accessToken: string
      usageLimits?: {
        totalLimit: number
        totalUsed: number
        available: number
        subscriptionTitle?: string
        subscriptionType?: string
        nextDateReset?: number
      }
      status?: string
      addedAt?: string
      authMethod?: string
      provider?: string
    }

    // 检测数据格式：
    // 1. 标准导出格式：{ version, exportedAt, accounts: [...], groups: [...], tags: [...] }
    // 2. 简化数组格式：[{ id, email, refreshToken, ... }]
    const isStandardFormat = !Array.isArray(data) &&
      typeof data === 'object' &&
      data !== null &&
      'accounts' in (data as object) &&
      Array.isArray((data as AccountExportData).accounts)

    const isSimplifiedFormat = Array.isArray(data) && data.length > 0 &&
      typeof (data as SimplifiedAccount[])[0] === 'object' &&
      (data as SimplifiedAccount[])[0] !== null &&
      typeof (data as SimplifiedAccount[])[0].email === 'string' &&
      typeof (data as SimplifiedAccount[])[0].refreshToken === 'string'

    // 转换简化格式为标准格式
    let normalizedData: AccountExportData
    if (isSimplifiedFormat) {
      const simplifiedAccounts = data as SimplifiedAccount[]
      const now = Date.now()

      // 将简化格式转换为标准 Account 格式
      const convertedAccounts: Omit<Account, 'isActive'>[] = simplifiedAccounts.map((acc, index) => {
        // 解析订阅类型
        let subscriptionType: SubscriptionType = 'Free'
        const rawSubType = acc.usageLimits?.subscriptionType || ''
        if (rawSubType.includes('PRO') || rawSubType.includes('Pro')) {
          subscriptionType = 'Pro'
        } else if (rawSubType.includes('ENTERPRISE') || rawSubType.includes('Enterprise')) {
          subscriptionType = 'Enterprise'
        } else if (rawSubType.includes('TEAMS') || rawSubType.includes('Teams')) {
          subscriptionType = 'Teams'
        }

        // 解析身份提供商
        type IdpType = 'Google' | 'Github' | 'BuilderId' | 'AWSIdC' | 'Internal'
        let idp: IdpType = 'BuilderId'
        const provider = acc.provider || ''
        if (provider === 'Google') idp = 'Google'
        else if (provider === 'Github' || provider === 'GitHub') idp = 'Github'
        else if (provider === 'BuilderId') idp = 'BuilderId'

        // 解析认证方式
        const authMethod: 'IdC' | 'social' = acc.authMethod === 'IdC' ? 'IdC' : 'social'

        // 解析过期时间
        let expiresAt = now + 3600 * 1000
        if (acc.expiresAt) {
          const parsed = Date.parse(acc.expiresAt)
          if (!isNaN(parsed)) expiresAt = parsed
        }

        // 解析添加时间
        let createdAt = now
        if (acc.addedAt) {
          const parsed = Date.parse(acc.addedAt)
          if (!isNaN(parsed)) createdAt = parsed
        }

        // 计算使用量
        const totalLimit = acc.usageLimits?.totalLimit || 550
        const totalUsed = acc.usageLimits?.totalUsed || 0
        const percentUsed = totalLimit > 0 ? totalUsed / totalLimit : 0

        return {
          id: acc.id || `imported-${now}-${index}`,
          email: acc.email,
          idp,
          credentials: {
            accessToken: acc.accessToken || '',
            csrfToken: '',
            refreshToken: acc.refreshToken,
            expiresAt,
            authMethod,
            provider: idp === 'BuilderId' ? 'BuilderId' : idp === 'Google' ? 'Google' : 'Github'
          },
          subscription: {
            type: subscriptionType,
            title: acc.usageLimits?.subscriptionTitle,
            rawType: acc.usageLimits?.subscriptionType
          },
          usage: {
            current: totalUsed,
            limit: totalLimit,
            percentUsed,
            lastUpdated: now,
            nextResetDate: acc.usageLimits?.nextDateReset ? acc.usageLimits.nextDateReset * 1000 : undefined
          },
          tags: [],
          status: (acc.status === '正常' || acc.status === 'active') ? 'active' : 'unknown' as AccountStatus,
          createdAt,
          lastUsedAt: createdAt,
          version: 1
        }
      })

      normalizedData = {
        version: '1.0.0',
        exportedAt: now,
        accounts: convertedAccounts,
        groups: [],
        tags: []
      }
    } else {
      // 标准格式
      normalizedData = data as AccountExportData
    }

    // 去重：文件内部去重（基于 email + idp 组合）
    const seenEmailIdpPairs = new Set<string>()
    const uniqueAccounts = normalizedData.accounts.filter(acc => {
      const key = `${acc.email}|${acc.idp}`
      if (seenEmailIdpPairs.has(key)) {
        return false
      }
      seenEmailIdpPairs.add(key)
      return true
    })

    // 导入分组（通过 V2 API）
    for (const group of normalizedData.groups) {
      try {
        // 检查分组是否已存在
        const existingGroup = get().groups.get(group.id)
        if (!existingGroup) {
          // 先更新本地状态
          set((state) => {
            const groups = new Map(state.groups)
            groups.set(group.id, group)
            return { groups }
          })
          // 调用 V2 API 创建分组
          const response = await apiV2.groups.create({
            ...group,
            version: group.version || 1
          })
          if (!response.success) {
            console.error('[Import] Failed to create group via V2 API:', group.name)
          }
        }
      } catch (error) {
        console.error('[Import] Error importing group:', error)
      }
    }

    // 导入标签（通过 V2 API）
    for (const tag of normalizedData.tags) {
      try {
        // 检查标签是否已存在
        const existingTag = get().tags.get(tag.id)
        if (!existingTag) {
          // 先更新本地状态
          set((state) => {
            const tags = new Map(state.tags)
            tags.set(tag.id, tag)
            return { tags }
          })
          // 调用 V2 API 创建标签
          const response = await apiV2.tags.create({
            ...tag,
            version: tag.version || 1
          })
          if (!response.success) {
            console.error('[Import] Failed to create tag via V2 API:', tag.name)
          }
        }
      } catch (error) {
        console.error('[Import] Error importing tag:', error)
      }
    }

    // 导入账号（跳过已存在的，通过 V2 API）
    let skipped = 0
    for (const accountData of uniqueAccounts) {
      // 检查本地是否已存在（通过 email + idp 组合）
      if (isAccountExists(accountData.email, accountData.idp)) {
        skipped++
        continue
      }

      try {
        // 先更新本地状态
        set((state) => {
          const accounts = new Map(state.accounts)
          accounts.set(accountData.id, { ...accountData, isActive: false })
          return { accounts }
        })

        // 调用 V2 API 创建账号
        const response = await apiV2.accounts.create({
          ...accountData,
          isActive: false,
          version: accountData.version || 1
        })

        if (response.success && response.data) {
          // 更新本地状态，使用服务器返回的版本号
          set((state) => {
            const accounts = new Map(state.accounts)
            const existingAccount = accounts.get(accountData.id)
            if (existingAccount) {
              accounts.set(accountData.id, {
                ...existingAccount,
                version: response.data!.version
              })
            }
            return { accounts }
          })
          result.success++
        } else {
          // 回滚本地状态
          set((state) => {
            const accounts = new Map(state.accounts)
            accounts.delete(accountData.id)
            return { accounts }
          })
          result.failed++
          result.errors.push({
            id: accountData.id,
            error: 'Failed to create account'
          })
        }
      } catch (error) {
        // 回滚本地状态
        set((state) => {
          const accounts = new Map(state.accounts)
          accounts.delete(accountData.id)
          return { accounts }
        })
        result.failed++
        result.errors.push({
          id: accountData.id,
          error: error instanceof Error ? error.message : 'Unknown error'
        })
      }
    }

    // 记录跳过数量
    if (skipped > 0) {
      result.errors.push({
        id: 'skipped',
        error: `跳过 ${skipped} 个已存在的账号`
      })
    }

    return result
  },

  // ==================== 状态管理 ====================

  updateAccountStatus: (id, status, error) => {
    set((state) => {
      const accounts = new Map(state.accounts)
      const account = accounts.get(id)
      if (account) {
        accounts.set(id, {
          ...account,
          status,
          lastError: error,
          lastCheckedAt: Date.now()
        })
      }
      return { accounts }
    })
    // 不立即保存，依赖定时自动保存
  },

  refreshAccountToken: async (id) => {
    const { accounts, updateAccountStatus, checkAccountStatus } = get()
    const account = accounts.get(id)

    if (!account) {
      console.error('[Account] Token refresh failed: Account not found', { accountId: id })
      return false
    }

    // 刷新token前检查所有必要字段
    const missingFields: string[] = []

    if (!account.userId) missingFields.push('userId')
    if (!account.nickname) missingFields.push('nickname')
    if (!account.credentials?.region) missingFields.push('credentials.region')
    if (!account.usage?.resourceDetail) missingFields.push('usage.resourceDetail')

    // 如果有字段缺失，先补全
    if (missingFields.length > 0) {
      console.log(`[Account] Missing fields for ${account.email}: ${missingFields.join(', ')}. Checking status to complete fields...`)

      // 先调用 checkAccountStatus 来补全所有必要字段
      await checkAccountStatus(id)

      // 重新获取更新后的账号信息
      const updatedAccount = accounts.get(id)
      if (updatedAccount) {
        console.log(`[Account] All required fields completed successfully for ${updatedAccount.email}`)
      }else{
        console.error('[Account] Account not found after status check', { accountId: id, email: account.email })
      }
    }

    updateAccountStatus(id, 'refreshing')

    // 使用 handleApiCall 包装 API 调用
    const result = await handleApiCall(
      () => window.api.refreshAccountToken(account),
      { operation: 'refresh_token', accountId: id, email: account.email, resourceType: 'account' }
    )

    if (result.success && result.data) {
      const apiResult = result.data
      if (apiResult.success && apiResult.data) {
        set((state) => {
          const accounts = new Map(state.accounts)
          const acc = accounts.get(id)
          if (acc) {
            accounts.set(id, {
              ...acc,
              credentials: {
                ...acc.credentials,
                accessToken: apiResult.data!.accessToken,
                // 如果返回了新的 refreshToken，更新它
                refreshToken: apiResult.data!.refreshToken || acc.credentials.refreshToken,
                expiresAt: Date.now() + apiResult.data!.expiresIn * 1000
              },
              status: 'active',
              lastError: undefined,
              lastCheckedAt: Date.now()
            })
          }
          return { accounts }
        })
        // 立即保存到数据库（Token 刷新是关键操作，必须立即同步）
        await get().saveToStorage()
        console.log(`[Account] Token refreshed and saved for ${account.email}`)
        return true
      } else {
        // API 返回失败
        const errorMessage = apiResult.error?.message || 'Token refresh failed'
        console.error('[Account] Token refresh API returned failure:', {
          accountId: id,
          email: account.email,
          error: errorMessage
        })
        updateAccountStatus(id, 'error', errorMessage)
        return false
      }
    } else {
      // 网络或其他错误
      console.error('[Account] Token refresh failed:', {
        accountId: id,
        email: account.email,
        error: result.error,
        errorType: result.errorType
      })
      updateAccountStatus(id, 'error', result.error || 'Unknown error')
      return false
    }
  },

  batchRefreshTokens: async (ids) => {
    // 不再过滤 banned 状态的账号，允许用户手动批量刷新所有选中的账号
    // 这样可以检测被封禁的账号是否已经解封

    // 使用 executeBatchOperations 统一处理批量操作
    const operations = ids.map(id => ({
      id,
      operation: async () => {
        const success = await get().refreshAccountToken(id)
        if (!success) {
          const account = get().accounts.get(id)
          throw new Error(account?.lastError || 'Refresh failed')
        }
      }
    }))

    return executeBatchOperations(operations, 'batchRefreshTokens')
  },

  checkAccountStatus: async (id) => {
    const { accounts, updateAccountStatus } = get()
    let account = accounts.get(id)

    if (!account) {
      console.error('[Account] Status check failed: Account not found', { accountId: id })
      return
    }

    // 检查账号是否需要先同步到服务器
    if (account.needsSync) {
      console.log(`[Account] Account needs sync before status check: ${account.email}`)

      // 先同步账号到服务器
      const syncResult = await handleApiCall(
        () => apiV2.accounts.create({ ...account!, version: 1, needsSync: undefined }),
        { operation: 'sync_account_before_check', accountId: id, email: account.email, resourceType: 'account' }
      )

      if (syncResult.success && syncResult.data) {
        const response = syncResult.data
        if (response.success && response.data) {
          // 更新本地状态，清除 needsSync 标记
          set((state: { accounts: Map<string, Account> }) => ({
            accounts: applyOptimisticUpdate(state.accounts, id, {
              version: response.data!.version,
              needsSync: false
            })
          }))
          console.log(`[Account] Account synced to server before status check: ${account.email}`)
          // 重新获取更新后的账号
          account = get().accounts.get(id)
          if (!account) {
            console.error('[Account] Account not found after sync', { accountId: id })
            return
          }
        } else {
          console.error('[Account] Failed to sync account before status check:', response.error)
          updateAccountStatus(id, 'error', 'Failed to sync account to server')
          return
        }
      } else {
        console.error('[Account] Error syncing account before status check:', syncResult.error)
        updateAccountStatus(id, 'error', syncResult.error || 'Failed to sync account')
        return
      }
    }

    // 使用 handleApiCall 包装 API 调用
    const result = await handleApiCall(
      () => window.api.checkAccountStatus(account),
      { operation: 'check_status', accountId: id, email: account.email, resourceType: 'account' }
    )

    if (result.success && result.data) {
      const apiResult = result.data
      if (apiResult.success && apiResult.data) {
        set((state) => {
          const accounts = new Map(state.accounts)
          const acc = accounts.get(id)
          if (acc) {
            // 如果 token 被刷新，更新凭证
            const updatedCredentials = apiResult.data!.newCredentials
              ? {
                  ...acc.credentials,
                  accessToken: apiResult.data!.newCredentials.accessToken,
                  refreshToken: apiResult.data!.newCredentials.refreshToken ?? acc.credentials.refreshToken,
                  expiresAt: apiResult.data!.newCredentials.expiresAt ?? acc.credentials.expiresAt,
                  // 补全 region 默认值
                  region: acc.credentials.region || 'us-east-1'
                }
              : {
                  ...acc.credentials,
                  // 补全 region 默认值
                  region: acc.credentials.region || 'us-east-1'
                }

            // 合并 usage 数据，确保包含所有必要字段
            const apiUsage = apiResult.data!.usage
            const mergedUsage = apiUsage ? {
              current: apiUsage.current ?? acc.usage.current,
              limit: apiUsage.limit ?? acc.usage.limit,
              percentUsed: apiUsage.limit > 0 ? apiUsage.current / apiUsage.limit : 0,
              lastUpdated: apiUsage.lastUpdated ?? Date.now(),
              baseLimit: apiUsage.baseLimit,
              baseCurrent: apiUsage.baseCurrent,
              freeTrialLimit: apiUsage.freeTrialLimit,
              freeTrialCurrent: apiUsage.freeTrialCurrent,
              // 使用 parseTimestamp 转换时间戳字段
              freeTrialExpiry: parseTimestamp(apiUsage.freeTrialExpiry),
              bonuses: apiUsage.bonuses?.map(bonus => ({
                ...bonus,
                expiresAt: parseTimestamp(bonus.expiresAt)
              })),
              nextResetDate: parseTimestamp(apiUsage.nextResetDate),
              resourceDetail: apiUsage.resourceDetail
            } : acc.usage

            // 合并订阅信息
            const apiSub = apiResult.data!.subscription
            const mergedSubscription = apiSub ? {
              ...acc.subscription,
              ...apiSub
            } : acc.subscription

            // 转换 IDP 类型
            const apiIdp = apiResult.data!.idp
            let idpType = acc.idp
            if (apiIdp) {
              if (apiIdp === 'BuilderId') idpType = 'BuilderId'
              else if (apiIdp === 'Google') idpType = 'Google'
              else if (apiIdp === 'Github') idpType = 'Github'
              else if (apiIdp === 'AWSIdC') idpType = 'AWSIdC'
              else idpType = 'Internal'
            }

            // 补全 nickname 默认值（从邮箱提取）
            const email = apiResult.data!.email ?? acc.email
            const defaultNickname = email.split('@')[0]
            const finalNickname = acc.nickname || defaultNickname

            const updatedAccount = {
              ...acc,
              // 更新邮箱（如果 API 返回了）
              email: email,
              userId: apiResult.data!.userId ?? acc.userId,
              nickname: finalNickname,
              idp: idpType,
              status: apiResult.data!.status as AccountStatus,
              usage: mergedUsage,
              subscription: mergedSubscription as AccountSubscription,
              credentials: updatedCredentials,
              lastCheckedAt: Date.now(),
              lastError: undefined
            }
            accounts.set(id, updatedAccount)
          }
          return { accounts }
        })

        // 立即保存到数据库（调用 updateAccount 同步到数据库）
        const updatedAcc = get().accounts.get(id)
        if (updatedAcc) {
          await get().updateAccount(id, {
            email: updatedAcc.email,
            userId: updatedAcc.userId,
            nickname: updatedAcc.nickname,
            idp: updatedAcc.idp,
            status: updatedAcc.status,
            usage: updatedAcc.usage,
            subscription: updatedAcc.subscription,
            credentials: updatedAcc.credentials,
            lastCheckedAt: updatedAcc.lastCheckedAt,
            lastError: updatedAcc.lastError
          })

          // 如果刷新了 token，打印日志
          if (apiResult.data.newCredentials) {
            console.log(`[Account] Token refreshed and saved to database for ${account?.email}`)
          } else {
            console.log(`[Account] Status checked and saved to database for ${account?.email}`)
          }
        }
      } else {
        // API 返回失败，检查是否是 BANNED 错误
        const errorMessage = apiResult.error?.message || ''
        const isBanned = errorMessage.includes('BANNED:') ||
                         errorMessage.includes('UnauthorizedException') ||
                         errorMessage.includes('AccountSuspendedException')

        if (isBanned) {
          // 设置为 banned 状态
          console.log(`[Account] Account ${account.email} is BANNED: ${errorMessage}`)

          // 更新本地状态
          set((state) => {
            const accounts = new Map(state.accounts)
            const acc = accounts.get(id)
            if (acc) {
              accounts.set(id, {
                ...acc,
                status: 'banned',
                lastError: errorMessage,
                lastCheckedAt: Date.now()
              })
            }
            return { accounts }
          })

          // 调用 updateAccount 更新数据库中的账号状态
          await get().updateAccount(id, {
            status: 'banned',
            lastError: errorMessage,
            lastCheckedAt: Date.now()
          })
          console.log(`[Account] Banned status persisted to database for ${account.email}`)
        } else {
          // 普通错误
          console.error('[Account] Status check API returned failure:', {
            accountId: id,
            email: account.email,
            error: errorMessage
          })
          updateAccountStatus(id, 'error', errorMessage)
        }
      }
    } else {
      // 网络或其他错误
      console.error('[Account] Status check failed:', {
        accountId: id,
        email: account.email,
        error: result.error,
        errorType: result.errorType
      })
      updateAccountStatus(id, 'error', result.error || 'Unknown error')
    }
  },

  batchCheckStatus: async (ids) => {
    // 使用 executeBatchOperations 统一处理批量操作
    const operations = ids.map(id => ({
      id,
      operation: async () => {
        await get().checkAccountStatus(id)
        // 检查状态是否为 active，如果不是则抛出错误
        const account = get().accounts.get(id)
        if (account?.status !== 'active' && account?.status !== 'unknown') {
          throw new Error(account?.lastError || 'Check failed')
        }
      }
    }))

    return executeBatchOperations(operations, 'batchCheckStatus')
  },

  // ==================== 统计 ====================

  getStats: () => {
    const { accounts } = get()
    // 过滤掉软删除的账号，只统计未删除的账号
    const accountList = Array.from(accounts.values()).filter(account => !account.isDel)

    const stats: AccountStats = {
      total: accountList.length,
      byStatus: {
        active: 0,
        expired: 0,
        error: 0,
        refreshing: 0,
        unknown: 0,
        banned: 0
      },
      bySubscription: {
        Free: 0,
        Pro: 0,
        Enterprise: 0,
        Teams: 0
      },
      byIdp: {
        Google: 0,
        Github: 0,
        BuilderId: 0,
        AWSIdC: 0,
        Internal: 0
      },
      activeCount: 0,
      expiringSoonCount: 0
    }

    for (const account of accountList) {
      stats.byStatus[account.status]++
      stats.bySubscription[account.subscription.type]++
      stats.byIdp[account.idp]++

      // 正常账号 = 非封禁状态的账号
      if (account.status !== 'banned') stats.activeCount++
      if (account.subscription.daysRemaining !== undefined &&
          account.subscription.daysRemaining <= 7) {
        stats.expiringSoonCount++
      }
    }

    return stats
  },

  // ==================== 持久化 ====================

  loadFromStorage: async () => {
    // 防重入检查：如果正在加载，直接返回
    const { isLoading } = get()
    if (isLoading) {
      console.log('[Store] loadFromStorage skipped - already loading')
      return
    }

    console.log('[Store] loadFromStorage called')
    set({ isLoading: true })

    // 检测是否是 Electron 环境
    const isElectronEnv = typeof window !== 'undefined' &&
      window.api &&
      typeof window.api.getAppVersion === 'function' &&
      !(window.api as { __isWebAdapter?: boolean }).__isWebAdapter

    console.log('[Store] Environment:', isElectronEnv ? 'Electron' : 'Web')

    try {
      // 获取应用版本号
      const appVersion = await window.api.getAppVersion()
      console.log('[Store] App version:', appVersion)
      set({ appVersion })

      // 1. 从服务器加载账号数据（不包含本地设置）
      // Electron 和 Web 统一使用 HTTP 请求（通过 webAdapter）
      // webAdapter 会自动携带 cookie 进行认证
      console.log('[Store] Loading accounts from server via HTTP...')
      const { webAdapter } = await import('../lib/web-adapter')
      const data = await webAdapter.loadAccounts()
      console.log('[Store] Loaded data:', {
        accountCount: Object.keys(data?.accounts || {}).length,
        groupCount: Object.keys(data?.groups || {}).length,
        tagCount: Object.keys(data?.tags || {}).length
      })

      // 2. 如果是 Electron 环境，从本地加载客户端独立设置
      //    如果是 Web 环境，从 localStorage 加载设置
      let localSettings: LocalSettingsData = {}

      if (isElectronEnv && window.api.loadLocalSettings) {
        try {
          // 使用类型断言确保类型兼容性
          // preload/index.ts 和 accounts.ts 中的 LocalSettingsData 结构相同
          localSettings = await window.api.loadLocalSettings() as LocalSettingsData
          console.log('[Store] Loaded local settings from client')
        } catch (e) {
          console.warn('[Store] Failed to load local settings:', e)
        }
      } else if (!isElectronEnv) {
        // Web 环境：从 localStorage 读取
        try {
          const savedSettings = localStorage.getItem(WEB_SETTINGS_STORAGE_KEY)
          if (savedSettings) {
            localSettings = JSON.parse(savedSettings)
            console.log('[Store] Loaded local settings from localStorage')
          }
        } catch (e) {
          console.warn('[Store] Failed to load settings from localStorage:', e)
        }
      }

      if (data) {
        const accounts = new Map(Object.entries(data.accounts ?? {}) as [string, Account][])
        let activeAccountId = data.activeAccountId ?? null

        // 同步本地 SSO 缓存中的账号状态
        // 注意：只有当 autoSyncToServer = true 时才自动导入本地账号
        // 否则本地账号需要用户手动点击"检测"按钮才会同步
        try {
          const localResult = await window.api.getLocalActiveAccount()
          if (localResult.success && localResult.data?.refreshToken) {
            const localRefreshToken = localResult.data.refreshToken
            // 查找匹配的账号
            let foundAccountId: string | null = null
            for (const [id, account] of accounts) {
              if (account.credentials.refreshToken === localRefreshToken) {
                foundAccountId = id
                break
              }
            }
            // 如果找到匹配的账号，设为当前使用
            if (foundAccountId) {
              activeAccountId = foundAccountId
              console.log('[Store] Synced active account from local SSO cache:', foundAccountId)
            } else {
              // 如果没有找到匹配的账号，检查是否允许自动导入
              // 只有当 autoSyncToServer = true 时才自动导入
              if (getAutoSyncToServer()) {
                console.log('[Store] Local account not found in app, importing...')
                const importResult = await window.api.loadKiroCredentials()
                if (importResult.success && importResult.data) {
                  // 验证并获取账号信息
                  const verifyResult = await window.api.verifyAccountCredentials({
                    refreshToken: importResult.data.refreshToken,
                    clientId: importResult.data.clientId || '',
                    clientSecret: importResult.data.clientSecret || '',
                    region: importResult.data.region,
                    authMethod: importResult.data.authMethod,
                    provider: importResult.data.provider
                  })
                  if (verifyResult.success && verifyResult.data) {
                    const now = Date.now()
                    const newId = `${verifyResult.data.email}-${now}`
                    const newAccount: Account = {
                      id: newId,
                      email: verifyResult.data.email,
                      userId: verifyResult.data.userId,
                      nickname: verifyResult.data.email ? verifyResult.data.email.split('@')[0] : undefined,
                      idp: (importResult.data.provider || 'BuilderId') as 'BuilderId' | 'Google' | 'Github',
                      credentials: {
                        accessToken: verifyResult.data.accessToken,
                        csrfToken: '',
                        refreshToken: verifyResult.data.refreshToken,
                        clientId: importResult.data.clientId || '',
                        clientSecret: importResult.data.clientSecret || '',
                        region: importResult.data.region || 'us-east-1',
                        expiresAt: verifyResult.data.expiresIn ? now + verifyResult.data.expiresIn * 1000 : now + 3600 * 1000,
                        authMethod: importResult.data.authMethod as 'IdC' | 'social',
                        provider: (importResult.data.provider || 'BuilderId') as 'BuilderId' | 'Github' | 'Google'
                      },
                      subscription: {
                        type: verifyResult.data.subscriptionType as SubscriptionType,
                        title: verifyResult.data.subscriptionTitle,
                        rawType: verifyResult.data.subscription?.rawType,
                        daysRemaining: verifyResult.data.daysRemaining,
                        expiresAt: verifyResult.data.expiresAt,
                        managementTarget: verifyResult.data.subscription?.managementTarget,
                        upgradeCapability: verifyResult.data.subscription?.upgradeCapability,
                        overageCapability: verifyResult.data.subscription?.overageCapability
                      },
                      usage: {
                        current: verifyResult.data.usage.current,
                        limit: verifyResult.data.usage.limit,
                        percentUsed: verifyResult.data.usage.limit > 0
                          ? verifyResult.data.usage.current / verifyResult.data.usage.limit
                          : 0,
                        lastUpdated: now,
                        baseLimit: verifyResult.data.usage.baseLimit,
                        baseCurrent: verifyResult.data.usage.baseCurrent,
                        freeTrialLimit: verifyResult.data.usage.freeTrialLimit,
                        freeTrialCurrent: verifyResult.data.usage.freeTrialCurrent,
                        // 使用 parseTimestamp 转换时间戳字段
                        freeTrialExpiry: parseTimestamp(verifyResult.data.usage.freeTrialExpiry),
                        bonuses: verifyResult.data.usage.bonuses?.map(bonus => ({
                          ...bonus,
                          expiresAt: parseTimestamp(bonus.expiresAt)
                        })),
                        nextResetDate: parseTimestamp(verifyResult.data.usage.nextResetDate),
                        resourceDetail: verifyResult.data.usage.resourceDetail
                      },
                      status: 'active',
                      createdAt: now,
                      lastUsedAt: now,
                      tags: [],
                      isActive: true
                    }
                    accounts.set(newId, newAccount)
                    activeAccountId = newId
                    console.log('[Store] Auto-imported account from local SSO cache:', verifyResult.data.email)
                  }
                }
              } else {
                console.log('[Store] Local account not found in app, but autoSyncToServer is disabled. Skipping auto-import.')
              }
            }
          }
        } catch (e) {
          console.warn('[Store] Failed to sync local active account:', e)
        }

        // 设置服务器数据（账号、分组、标签）
        set({
          accounts,
          groups: new Map(Object.entries(data.groups ?? {}) as [string, AccountGroup][]),
          tags: new Map(Object.entries(data.tags ?? {}) as [string, AccountTag][]),
          activeAccountId
        })

        // 设置本地设置（优先使用本地存储的值）
        // 如果有本地设置（Electron 文件或 Web localStorage），则优先使用
        // 否则回退到服务器数据（向后兼容）
        const settingsSource = Object.keys(localSettings).length > 0 ? localSettings : data

        // 强制合并本地设置（因为 settingsSource 可能是 data，而 data 可能缺少某些字段）
        // 这样确保 localSettings 中的值总是生效
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mergedSettings: any = { ...data, ...localSettings }

        if(isElectronEnv){
          // Electron 环境下的特定覆盖
          mergedSettings.autoRefreshEnabled = false;
          mergedSettings.statusCheckInterval = false;
        }
        set({
          autoRefreshEnabled: (mergedSettings.autoRefreshEnabled as boolean) ?? true,
          autoRefreshInterval: (mergedSettings.autoRefreshInterval as number) ?? 5,
          statusCheckInterval: (mergedSettings.statusCheckInterval as number) ?? 60,
          privacyMode: (mergedSettings.privacyMode as boolean) ?? false,
          proxyEnabled: (mergedSettings.proxyEnabled as boolean) ?? false,
          proxyUrl: (mergedSettings.proxyUrl as string) ?? '',
          autoSwitchEnabled: (mergedSettings.autoSwitchEnabled as boolean) ?? false,
          autoSwitchThreshold: (mergedSettings.autoSwitchThreshold as number) ?? 0,
          autoSwitchInterval: (mergedSettings.autoSwitchInterval as number) ?? 5,
          theme: (mergedSettings.theme as string) ?? 'default',
          darkMode: (mergedSettings.darkMode as boolean) ?? false,
          localActiveAccountId: (mergedSettings.localActiveAccountId as string | null) ?? null,
          machineIdConfig: (mergedSettings.machineIdConfig as {
            autoSwitchOnAccountChange: boolean
            bindMachineIdToAccount: boolean
            useBindedMachineId: boolean
          }) ?? {
            autoSwitchOnAccountChange: true,
            bindMachineIdToAccount: false,
            useBindedMachineId: false
          },
          accountMachineIds: (mergedSettings.accountMachineIds as Record<string, string>) ?? {},
          machineIdHistory: (mergedSettings.machineIdHistory as Array<{
            id: string
            machineId: string
            timestamp: number
            action: 'initial' | 'manual' | 'auto_switch' | 'restore' | 'bind'
            accountId?: string
            accountEmail?: string
          }>) ?? [],
          bitBrowserConfig: (mergedSettings.bitBrowserConfig as {
            enabled: boolean
            port: number
            browserId: string
          }) ?? {
            enabled: false,
            port: 54345,
            browserId: ''
          }
        })

        // 应用主题
        get().applyTheme()

        // 如果代理已启用，通知主进程
        const proxyEnabled = (mergedSettings.proxyEnabled as boolean) ?? false
        const proxyUrl = (mergedSettings.proxyUrl as string) ?? ''
        if (proxyEnabled && proxyUrl) {
          window.api.setProxy?.(true, proxyUrl)
        }

        // 如果自动换号已启用，启动定时器
        if ((mergedSettings.autoSwitchEnabled as boolean) ?? false) {
          get().startAutoSwitch()
        }

        // 启动定时自动保存（防止数据丢失）
        get().startAutoSave()

        // 启动 Electron 客户端后台同步（仅 Electron 环境）
        get().startBackgroundSync()

        console.log('[Store] Data loaded successfully')
      }
    } catch (error) {
      console.error('[Store] Failed to load accounts:', error)
      console.error('[Store] Error details:', error)
    } finally {
      set({ isLoading: false })
      console.log('[Store] loadFromStorage completed')
    }
  },

  saveToStorage: async () => {
    const {
      autoRefreshEnabled,
      autoRefreshInterval,
      statusCheckInterval,
      privacyMode,
      proxyEnabled,
      proxyUrl,
      autoSwitchEnabled,
      autoSwitchThreshold,
      autoSwitchInterval,
      theme,
      darkMode,
      localActiveAccountId,
      machineIdConfig,
      accountMachineIds,
      machineIdHistory,
      bitBrowserConfig
    } = get()

    // 检测是否是 Electron 环境
    const isElectronEnv = typeof window !== 'undefined' &&
      window.api &&
      typeof window.api.getAppVersion === 'function' &&
      !(window.api as { __isWebAdapter?: boolean }).__isWebAdapter

    set({ isSyncing: true })

    try {
      // 注意：账号/分组/标签数据已经通过 V2 API 单独保存（在 addAccount, updateAccount, deleteAccount 等方法中）
      // saveToStorage 现在只负责保存本地设置

      // 如果是 Electron 环境，保存本地设置到客户端本地
      if (isElectronEnv && window.api.saveLocalSettings) {
        try {
          await window.api.saveLocalSettings({
            privacyMode,
            theme,
            darkMode,
            autoRefreshEnabled,
            autoRefreshInterval,
            statusCheckInterval,
            autoSwitchEnabled,
            autoSwitchThreshold,
            autoSwitchInterval,
            proxyEnabled,
            proxyUrl,
            localActiveAccountId,
            machineIdConfig,
            accountMachineIds,
            machineIdHistory,
            bitBrowserConfig
          })
          console.log('[Store] Saved local settings to client')
        } catch (e) {
          console.error('[Store] Failed to save local settings:', e)
        }
      } else if (!isElectronEnv) {
        // Web 环境：保存到 localStorage
        // 注意：比特浏览器功能仅在 Electron 端可用，Web 端不保存此配置
        try {
          const settingsToSave = {
            privacyMode,
            theme,
            darkMode,
            autoRefreshEnabled,
            autoRefreshInterval,
            statusCheckInterval,
            autoSwitchEnabled,
            autoSwitchThreshold,
            autoSwitchInterval,
            // Web 端通常不需要保存机器码相关配置，但也一并保存以保持一致性
            machineIdConfig
          }
          localStorage.setItem(WEB_SETTINGS_STORAGE_KEY, JSON.stringify(settingsToSave))
          console.log('[Store] Saved local settings to localStorage')
        } catch (e) {
          console.error('[Store] Failed to save settings to localStorage:', e)
        }
      }
    } catch (error) {
      console.error('Failed to save settings:', error)
    } finally {
      set({ isSyncing: false })
    }
  },

  // ==================== 设置 ====================

  setAutoRefresh: (enabled, interval) => {
    set({
      autoRefreshEnabled: enabled,
      autoRefreshInterval: interval ?? get().autoRefreshInterval
    })
    get().saveToStorage()
    // 注意：已移除自动刷新定时器，数据刷新改为手动触发或通过 list 接口查询
  },

  setStatusCheckInterval: (interval) => {
    set({ statusCheckInterval: interval })
    get().saveToStorage()
  },

  // ==================== 隐私模式 ====================

  setPrivacyMode: (enabled) => {
    set({ privacyMode: enabled })
    get().saveToStorage()
  },

  maskEmail: (email) => {
    if (!get().privacyMode || !email) return email
    return maskEmailUtil(email)
  },

  maskNickname: (nickname) => {
    if (!get().privacyMode || !nickname) return nickname || ''
    return maskNicknameUtil(nickname)
  },

  // ==================== 代理设置 ====================

  setProxy: (enabled, url) => {
    set({
      proxyEnabled: enabled,
      proxyUrl: url ?? get().proxyUrl
    })
    get().saveToStorage()
    // 通知主进程更新代理设置
    window.api.setProxy?.(enabled, url ?? get().proxyUrl)
  },

  // ==================== 主题设置 ====================

  setTheme: (theme) => {
    set({ theme })
    get().saveToStorage()
    get().applyTheme()
  },

  setDarkMode: (enabled) => {
    set({ darkMode: enabled })
    get().saveToStorage()
    get().applyTheme()
  },

  applyTheme: () => {
    const { theme, darkMode } = get()
    const root = document.documentElement

    // 移除所有主题类（包含所有 21 个主题）
    root.classList.remove(
      'dark',
      // 蓝色系
      'theme-indigo', 'theme-cyan', 'theme-sky', 'theme-teal',
      // 紫红系
      'theme-purple', 'theme-violet', 'theme-fuchsia', 'theme-pink', 'theme-rose',
      // 暖色系
      'theme-red', 'theme-orange', 'theme-amber', 'theme-yellow',
      // 绿色系
      'theme-emerald', 'theme-green', 'theme-lime',
      // 中性色
      'theme-slate', 'theme-zinc', 'theme-stone', 'theme-neutral'
    )

    // 应用深色模式
    if (darkMode) {
      root.classList.add('dark')
    }

    // 应用主题颜色
    if (theme !== 'default') {
      root.classList.add(`theme-${theme}`)
    }
  },

  // ==================== 自动换号 ====================

  setAutoSwitch: (enabled, threshold, interval) => {
    set({
      autoSwitchEnabled: enabled,
      autoSwitchThreshold: threshold ?? get().autoSwitchThreshold,
      autoSwitchInterval: interval ?? get().autoSwitchInterval
    })
    get().saveToStorage()

    // 重新启动定时器
    if (enabled) {
      get().startAutoSwitch()
    } else {
      get().stopAutoSwitch()
    }
  },

  startAutoSwitch: () => {
    const { autoSwitchEnabled, autoSwitchInterval, checkAndAutoSwitch } = get()

    if (!autoSwitchEnabled) return

    // 清除现有定时器
    if (autoSwitchTimer) {
      clearInterval(autoSwitchTimer)
    }

    // 立即检查一次
    checkAndAutoSwitch()

    // 设置定时检查
    autoSwitchTimer = setInterval(() => {
      checkAndAutoSwitch()
    }, autoSwitchInterval * 60 * 1000)

    console.log(`[AutoSwitch] Started with interval: ${autoSwitchInterval} minutes`)
  },

  stopAutoSwitch: () => {
    if (autoSwitchTimer) {
      clearInterval(autoSwitchTimer)
      autoSwitchTimer = null
      console.log('[AutoSwitch] Stopped')
    }
  },

  checkAndAutoSwitch: async () => {
    // 暂时不用，但是代码不能删。
    // 注意：以下代码已禁用，return 语句后的代码不会执行
    // 保留代码是为了将来可能重新启用此功能
    //
    // 实现逻辑说明：
    // 1. 获取当前激活账号
    // 2. 刷新账号状态获取最新余额
    // 3. 检查余额是否低于阈值
    // 4. 如果低于阈值，查找可用账号并切换
    //
    // 要启用此功能，请删除下面的 return 语句

    // 功能已禁用
    return

    /*
    // 以下代码已注释，避免 TypeScript 类型检查错误
    // 如需启用，请取消注释并删除上面的 return 语句

    const { accounts, autoSwitchThreshold, checkAccountStatus, setActiveAccount } = get()
    const activeAccount = get().getActiveAccount()

    if (!activeAccount) {
      console.log('[AutoSwitch] No active account')
      return
    }

    console.log(`[AutoSwitch] Checking active account: ${activeAccount.email}`)

    // 刷新当前账号状态获取最新余额
    await checkAccountStatus(activeAccount.id)

    // 重新获取更新后的账号信息
    const updatedAccount = get().accounts.get(activeAccount.id)
    if (!updatedAccount) {
      console.log('[AutoSwitch] Updated account not found')
      return
    }

    const remaining = updatedAccount.usage.limit - updatedAccount.usage.current
    console.log(`[AutoSwitch] Remaining: ${remaining}, Threshold: ${autoSwitchThreshold}`)

    // 检查是否需要切换
    if (remaining <= autoSwitchThreshold) {
      console.log(`[AutoSwitch] Account ${updatedAccount.email} reached threshold, switching...`)

      // 查找可用的账号
      const availableAccount = Array.from(accounts.values()).find(acc => {
        // 排除当前账号
        if (acc.id === activeAccount.id) return false
        // 排除已删除的账号
        if (acc.isDel) return false
        // 排除 banned 状态的账号
        if (acc.status === 'banned') return false
        // 排除被封禁的账号（通过错误信息判断，向后兼容）
        if (acc.lastError?.includes('UnauthorizedException') ||
            acc.lastError?.includes('AccountSuspendedException') ||
            acc.lastError?.includes('BANNED:')) return false
        // 排除余额不足的账号
        const accRemaining = acc.usage.limit - acc.usage.current
        if (accRemaining <= autoSwitchThreshold) return false
        return true
      })

      if (availableAccount) {
        console.log(`[AutoSwitch] Switching to: ${availableAccount.email}`)
        setActiveAccount(availableAccount.id)
        // 通知主进程切换账号
        await window.api.switchAccount({
          accessToken: availableAccount.credentials.accessToken || '',
          refreshToken: availableAccount.credentials.refreshToken || '',
          clientId: availableAccount.credentials.clientId || '',
          clientSecret: availableAccount.credentials.clientSecret || '',
          region: availableAccount.credentials.region || 'us-east-1',
          authMethod: availableAccount.credentials.authMethod,
          provider: availableAccount.credentials.provider
        })
      } else {
        console.log('[AutoSwitch] No available account to switch to')
      }
    }
    */
  },


  // ==================== 定时自动保存 ====================

  startAutoSave: () => {
    // 如果已有定时器，先停止
    if (autoSaveTimer) {
      clearInterval(autoSaveTimer)
    }

    // 计算当前数据的哈希值
    const computeHash = () => {
      const { accounts, groups, tags, activeAccountId } = get()
      return JSON.stringify({
        accounts: Object.fromEntries(accounts),
        groups: Object.fromEntries(groups),
        tags: Object.fromEntries(tags),
        activeAccountId
      })
    }

    // 初始化哈希值
    lastSaveHash = computeHash()

    // 设置定时保存
    autoSaveTimer = setInterval(async () => {
      const currentHash = computeHash()

      // 只有数据变化时才保存
      if (currentHash !== lastSaveHash) {
        console.log('[AutoSave] Data changed, saving...')
        await get().saveToStorage()
        lastSaveHash = currentHash
        console.log('[AutoSave] Data saved successfully')
      }
    }, AUTO_SAVE_INTERVAL)

    console.log(`[AutoSave] Auto-save started with interval: ${AUTO_SAVE_INTERVAL / 1000}s`)
  },

  stopAutoSave: () => {
    if (autoSaveTimer) {
      clearInterval(autoSaveTimer)
      autoSaveTimer = null
      console.log('[AutoSave] Auto-save stopped')
    }
  },

  // ==================== Electron 客户端后台同步 ====================

  startBackgroundSync: () => {
    // 检测是否是 Electron 环境
    const isElectronEnv = typeof window !== 'undefined' &&
      window.api &&
      typeof window.api.getAppVersion === 'function' &&
      !(window.api as { __isWebAdapter?: boolean }).__isWebAdapter

    // 仅在 Electron 环境下启用后台同步
    if (!isElectronEnv) {
      console.log('[BackgroundSync] Not in Electron environment, skipping')
      return
    }

    // 如果已有定时器，先停止
    if (backgroundSyncTimer) {
      clearInterval(backgroundSyncTimer)
      backgroundSyncTimer = null
    }

    // 启动定时同步
    backgroundSyncTimer = setInterval(() => {
      get().syncAccountsFromServer()
    }, BACKGROUND_SYNC_INTERVAL)

    console.log(`[BackgroundSync] Started with interval: ${BACKGROUND_SYNC_INTERVAL / 1000}s`)
  },

  stopBackgroundSync: () => {
    if (backgroundSyncTimer) {
      clearInterval(backgroundSyncTimer)
      backgroundSyncTimer = null
      console.log('[BackgroundSync] Stopped')
    }
  },

  syncAccountsFromServer: async () => {
    // 使用 AbortController 实现超时控制
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), BACKGROUND_SYNC_TIMEOUT)

    try {
      // 从服务器获取最新数据（带超时）
      // Electron 和 Web 统一使用 HTTP 请求（通过 webAdapter）
      const { webAdapter } = await import('../lib/web-adapter')
      const response = await Promise.race([
        webAdapter.loadAccounts(),
        new Promise<null>((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(new Error('Sync timeout'))
          })
        })
      ])

      clearTimeout(timeoutId)

      if (!response) {
        return // 超时或无数据，静默忽略
      }

      // 更新本地账号数据（仅更新账号信息，不影响本地设置）
      const serverAccounts = new Map(Object.entries(response.accounts ?? {}) as [string, Account][])
      const { accounts: localAccounts } = get()

      // 合并更新：保留本地账号结构，更新服务器返回的字段
      let hasChanges = false
      const updatedAccounts = new Map(localAccounts)

      for (const [id, serverAccount] of serverAccounts) {
        const localAccount = localAccounts.get(id)
        if (localAccount) {
          // 深度合并 usage 对象，保留本地已有的字段
          const serverUsage = serverAccount.usage
          const mergedUsage = serverUsage ? {
            current: serverUsage.current ?? localAccount.usage.current,
            limit: serverUsage.limit ?? localAccount.usage.limit,
            percentUsed: serverUsage.percentUsed ?? localAccount.usage.percentUsed,
            lastUpdated: serverUsage.lastUpdated ?? localAccount.usage.lastUpdated,
            baseLimit: serverUsage.baseLimit ?? localAccount.usage.baseLimit,
            baseCurrent: serverUsage.baseCurrent ?? localAccount.usage.baseCurrent,
            freeTrialLimit: serverUsage.freeTrialLimit ?? localAccount.usage.freeTrialLimit,
            freeTrialCurrent: serverUsage.freeTrialCurrent ?? localAccount.usage.freeTrialCurrent,
            freeTrialExpiry: serverUsage.freeTrialExpiry ?? localAccount.usage.freeTrialExpiry,
            bonuses: serverUsage.bonuses ?? localAccount.usage.bonuses,
            nextResetDate: serverUsage.nextResetDate ?? localAccount.usage.nextResetDate,
            resourceDetail: serverUsage.resourceDetail ?? localAccount.usage.resourceDetail
          } : localAccount.usage

          // 深度合并 subscription 对象，保留本地已有的字段
          const serverSub = serverAccount.subscription
          const mergedSubscription = serverSub ? {
            type: serverSub.type ?? localAccount.subscription.type,
            title: serverSub.title ?? localAccount.subscription.title,
            rawType: serverSub.rawType ?? localAccount.subscription.rawType,
            expiresAt: serverSub.expiresAt ?? localAccount.subscription.expiresAt,
            daysRemaining: serverSub.daysRemaining ?? localAccount.subscription.daysRemaining,
            upgradeCapability: serverSub.upgradeCapability ?? localAccount.subscription.upgradeCapability,
            overageCapability: serverSub.overageCapability ?? localAccount.subscription.overageCapability,
            managementTarget: serverSub.managementTarget ?? localAccount.subscription.managementTarget
          } : localAccount.subscription

          // 更新已存在账号的动态信息
          const updated = {
            ...localAccount,
            usage: mergedUsage,
            subscription: mergedSubscription,
            status: serverAccount.status ?? localAccount.status,
            lastCheckedAt: serverAccount.lastCheckedAt ?? localAccount.lastCheckedAt,
            credentials: {
              ...localAccount.credentials,
              // 更新 token 相关信息
              accessToken: serverAccount.credentials?.accessToken ?? localAccount.credentials.accessToken,
              expiresAt: serverAccount.credentials?.expiresAt ?? localAccount.credentials.expiresAt
            }
          }
          updatedAccounts.set(id, updated)
          hasChanges = true
        } else {
          // 新账号，直接添加
          updatedAccounts.set(id, serverAccount as Account)
          hasChanges = true
        }
      }

      // 检查是否有账号被删除（服务器上不存在但本地存在）
      for (const id of localAccounts.keys()) {
        if (!serverAccounts.has(id)) {
          updatedAccounts.delete(id)
          hasChanges = true
        }
      }

      if (hasChanges) {
        set({ accounts: updatedAccounts })
        console.log('[BackgroundSync] Accounts updated from server')
      }
    } catch (error) {
      // 超时或请求失败，静默忽略，不影响用户操作
      if ((error as Error).message === 'Sync timeout') {
        console.log('[BackgroundSync] Request timeout, skipping')
      } else {
        console.log('[BackgroundSync] Sync failed, skipping:', (error as Error).message)
      }
    }
  },

  // ==================== 机器码管理 ====================

  setMachineIdConfig: (config) => {
    set((state) => ({
      machineIdConfig: { ...state.machineIdConfig, ...config }
    }))
    get().saveToStorage()
  },

  refreshCurrentMachineId: async () => {
    try {
      const result = await window.api.machineIdGetCurrent()
      if (result.success && result.machineId) {
        set({ currentMachineId: result.machineId })

        // 首次获取时自动备份原始机器码
        const { originalMachineId } = get()
        if (!originalMachineId) {
          get().backupOriginalMachineId()
        }
      }
    } catch (error) {
      console.error('[MachineId] Failed to refresh current machine ID:', error)
    }
  },

  changeMachineId: async (newMachineId) => {
    const state = get()

    // 首次更改时备份原始机器码
    if (!state.originalMachineId) {
      state.backupOriginalMachineId()
    }

    // 生成新机器码（如果未提供）
    const machineIdToSet = newMachineId || await window.api.machineIdGenerateRandom()

    try {
      const result = await window.api.machineIdSet(machineIdToSet)

      if (result.success) {
        // 更新状态
        set((s) => ({
          currentMachineId: machineIdToSet,
          machineIdHistory: [
            ...s.machineIdHistory,
            {
              id: crypto.randomUUID(),
              machineId: machineIdToSet,
              timestamp: Date.now(),
              action: 'manual'
            }
          ]
        }))
        get().saveToStorage()
        return true
      } else if (result.requiresAdmin) {
        // 需要管理员权限，主进程会处理弹窗
        return false
      } else {
        console.error('[MachineId] Failed to change:', result.error)
        return false
      }
    } catch (error) {
      console.error('[MachineId] Error changing machine ID:', error)
      return false
    }
  },

  restoreOriginalMachineId: async () => {
    const { originalMachineId } = get()

    if (!originalMachineId) {
      console.warn('[MachineId] No original machine ID to restore')
      return false
    }

    try {
      const result = await window.api.machineIdSet(originalMachineId)

      if (result.success) {
        set((s) => ({
          currentMachineId: originalMachineId,
          machineIdHistory: [
            ...s.machineIdHistory,
            {
              id: crypto.randomUUID(),
              machineId: originalMachineId,
              timestamp: Date.now(),
              action: 'restore'
            }
          ]
        }))
        get().saveToStorage()
        return true
      }
      return false
    } catch (error) {
      console.error('[MachineId] Error restoring original machine ID:', error)
      return false
    }
  },

  bindMachineIdToAccount: (accountId, machineId) => {
    const account = get().accounts.get(accountId)
    if (!account) return

    // 生成或使用提供的机器码
    const boundMachineId = machineId || crypto.randomUUID()

    set((state) => ({
      accountMachineIds: {
        ...state.accountMachineIds,
        [accountId]: boundMachineId
      },
      machineIdHistory: [
        ...state.machineIdHistory,
        {
          id: crypto.randomUUID(),
          machineId: boundMachineId,
          timestamp: Date.now(),
          action: 'bind',
          accountId,
          accountEmail: account.email
        }
      ]
    }))
    get().saveToStorage()
  },

  getMachineIdForAccount: (accountId) => {
    return get().accountMachineIds[accountId] || null
  },

  backupOriginalMachineId: () => {
    const { currentMachineId, originalMachineId } = get()

    // 只有在没有备份且有当前机器码时才备份
    if (!originalMachineId && currentMachineId) {
      set({
        originalMachineId: currentMachineId,
        originalBackupTime: Date.now()
      })

      // 添加历史记录
      set((s) => ({
        machineIdHistory: [
          ...s.machineIdHistory,
          {
            id: crypto.randomUUID(),
            machineId: currentMachineId,
            timestamp: Date.now(),
            action: 'initial'
          }
        ]
      }))

      get().saveToStorage()
      console.log('[MachineId] Original machine ID backed up:', currentMachineId)
    }
  },

  clearMachineIdHistory: () => {
    set({ machineIdHistory: [] })
    get().saveToStorage()
  },

  // ==================== 比特浏览器配置 ====================

  setBitBrowserConfig: (config) => {
    set((state) => ({
      bitBrowserConfig: { ...state.bitBrowserConfig, ...config }
    }))
    get().saveToStorage()
  }
}))
