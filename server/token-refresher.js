
/**
 * Token 自动刷新服务
 * 定时检查并刷新即将过期的 token
 *
 * 重要：刷新操作必须串行执行，避免机器码乱序
 *
 * 刷新逻辑完全照抄 Electron 主进程 (src/main/index.ts)
 *
 * 增强功能：
 * - 数据库死锁自动重试
 * - 动态并发控制
 * - 详细的数据库操作统计
 * - 分布式锁：防止多实例同时刷新同一账号
 * - 工作时段控制：非工作时段暂停刷新
 */

import { randomUUID } from 'crypto'

// 引用共享的 Kiro API 工具函数
import { getUsageLimits, parseUsageResponse } from './utils/kiro-api.js'

// 引用重试工具
import { withRetry, isRetryableError as isDbRetryableError, RETRY_CONFIG } from './utils/error-handler.js'

// 引用分布式锁工具
import { withLock, LockNames, getLockStats } from './utils/distributed-lock.js'

// 引用告警类型
import { AlertType, AlertSeverity } from './openai-compat/system-logger.js'

// 引用工作时段检查工具
import { getWorkingStatus } from './utils/working-hours.js'

const TOKEN_REFRESH_MIN_BEFORE_EXPIRY = 10 * 60 * 1000 // 最少提前 10 分钟刷新
const TOKEN_REFRESH_MAX_BEFORE_EXPIRY = 16 * 60 * 1000 // 最多提前 16 分钟刷新
const CHECK_INTERVAL = 1 * 60 * 1000 // 每 5 分钟检查一次
const BATCH_SIZE = 3 // 每批最多刷新 5 个账号
const DEFAULT_EXPIRES_IN = 50 * 60 // 默认过期时间 50 分钟（秒）
const MIN_EXPIRES_IN = 5 * 60 // 最小合理过期时间 5 分钟（秒）- 降低阈值避免不必要的重试
const MAX_EXPIRES_IN = 2 * 60 * 60 // 最大合理过期时间 2 小时（秒）

const MIN_DELAY_MS = 1000 // 最小延迟 1 秒
const MAX_DELAY_MS = 5000 // 最大延迟 5 秒

// 使用量刷新最小间隔（5分钟）
const USAGE_REFRESH_MIN_INTERVAL = 5 * 60 * 1000 // 5分钟

// 重试配置
const MAX_RETRY_ATTEMPTS = 3 // 最大重试次数
const RETRY_DELAYS = {
  network_error: 5000,      // 网络错误延迟 5 秒
  rate_limit: 60000,        // 速率限制延迟 60 秒
  server_error: 10000,      // 服务器错误延迟 10 秒
  token_expired: 1000,      // Token过期立即重试
  database_deadlock: 200    // 数据库死锁短暂延迟后重试
}

// 是否在刷新 Token 时自动绑定机器码（默认 false）
const AUTO_BIND_MACHINE_ID = process.env.AUTO_BIND_MACHINE_ID === 'true'

// 是否在刷新 Token 后自动刷新使用量（默认 false）
const AUTO_REFRESH_USAGE_AFTER_TOKEN = process.env.AUTO_REFRESH_USAGE_AFTER_TOKEN === 'true'

// Kiro Auth API 配置 - 严格匹配 Rust 实现 (kiro_auth_client.rs)
const KIRO_AUTH_ENDPOINT = 'https://prod.us-east-1.auth.desktop.kiro.dev'

/**
 * 刷新错误类型枚举
 */
const RefreshErrorType = {
  CREDENTIAL_INVALID: 'credential_invalid',      // 凭证无效（401, invalid_grant）- 不重试
  TOKEN_EXPIRED: 'token_expired',                // Token过期但可重试
  NETWORK_ERROR: 'network_error',                // 网络错误（可重试）
  RATE_LIMIT: 'rate_limit',                      // 速率限制（需延迟重试）
  SERVER_ERROR: 'server_error',                  // 服务器错误（可重试）
  DATABASE_DEADLOCK: 'database_deadlock',        // 数据库死锁（可重试）
  UNKNOWN: 'unknown'                             // 未知错误
}

class TokenRefresher {
  constructor(pool, systemLogger = null, accountPool = null) {
    this.pool = pool
    this.systemLogger = systemLogger
    this.accountPool = accountPool // 账号池引用，用于获取活跃池账号
    this.timer = null
    this.isRefreshing = false // 锁：防止并发刷新
    this.isShuttingDown = false // 关闭标志
    this.nextCheckTime = null // 下次检测时间
    this.lastCheckTime = null // 上次检测时间

    // 重试队列：Map<accountId, { attempts: number, nextRetryTime: number, errorType: string, lastError: string }>
    this.retryQueue = new Map()

    // 动态批量大小（根据死锁频率调整）
    this.adaptiveBatchSize = BATCH_SIZE
    this.deadlockWindow = [] // 记录最近的死锁时间戳

    // 是否只刷新活跃池账号（默认启用，当 accountPool 可用时）
    this.activePoolOnlyMode = process.env.TOKEN_REFRESH_ACTIVE_POOL_ONLY !== 'false'

    // 性能统计
    this.stats = {
      totalRefreshes: 0,
      successfulRefreshes: 0,
      failedRefreshes: 0,
      totalDurationMs: 0,
      errorsByType: {},
      // 数据库操作统计
      databaseRetries: 0,
      deadlockCount: 0,
      deadlockRecovered: 0,
      dbOperationErrors: 0,
      // 分布式锁统计
      lockSkipped: 0,
      lockAcquireTime: 0,
      lockAcquireCount: 0,
      concurrentRefreshAttempts: 0,
      // 活跃池模式统计
      activePoolRefreshes: 0,
      skippedNonActivePool: 0
    }

    // 性能指标滑动窗口（用于计算P95等）
    this.refreshDurations = []
    this.maxDurationsWindow = 100

    // 最近失败记录（用于计算失败率）
    this.recentResults = [] // { success: boolean, timestamp: number }
    this.maxRecentResults = 100

    // 最慢刷新记录
    this.slowestRefreshes = [] // { accountId, email, durationMs, timestamp }
    this.maxSlowestRefreshes = 10
  }

  /**
   * 设置账号池引用
   * @param {AccountPool} accountPool - 账号池实例
   */
  setAccountPool(accountPool) {
    this.accountPool = accountPool
    console.log(`[TokenRefresher] AccountPool reference set, activePoolOnlyMode: ${this.activePoolOnlyMode}`)
  }

  /**
   * 获取下次检测时间信息
   * @returns {Object} 包含下次检测时间、上次检测时间、检测间隔等信息
   */
  getNextCheckInfo() {
    const now = Date.now()
    return {
      nextCheckTime: this.nextCheckTime,
      lastCheckTime: this.lastCheckTime,
      checkInterval: CHECK_INTERVAL,
      isRefreshing: this.isRefreshing,
      isRunning: this.timer !== null,
      // 计算距离下次检测的剩余时间（毫秒）
      timeUntilNextCheck: this.nextCheckTime ? Math.max(0, this.nextCheckTime - now) : null,
      // 重试队列信息
      retryQueueSize: this.retryQueue.size,
      // 活跃池模式信息
      activePoolOnlyMode: this.activePoolOnlyMode,
      activePoolAvailable: this.accountPool?.activePoolConfig?.enabled && this.accountPool?.activePoolInitialized,
      // 性能统计
      stats: { ...this.stats }
    }
  }

  /**
   * 生成随机的提前刷新时间（1-20分钟之间）
   */
  getRandomRefreshThreshold() {
    const range = TOKEN_REFRESH_MAX_BEFORE_EXPIRY - TOKEN_REFRESH_MIN_BEFORE_EXPIRY
    return TOKEN_REFRESH_MIN_BEFORE_EXPIRY + Math.floor(Math.random() * range)
  }

  /**
   * 校验 expiresIn 值并返回处理结果
   *
   * 返回值：
   * - { status: 'valid', value: number } - 值合理，直接使用（包括短过期时间）
   * - { status: 'use_default', value: number } - 值超出最大范围，使用默认值
   * - { status: 'invalid' } - 值非数字或 ≤0，标记账号异常
   *
   * 注意：之前的 'need_retry' 状态已移除，短过期时间现在直接使用返回值
   */
  validateExpiresIn(expiresIn, email) {
    // 检查是否为有效数字
    if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn)) {
      console.warn(`[TokenRefresher] Invalid expiresIn for ${email}: ${expiresIn} (not a valid number)`)
      return { status: 'invalid' }
    }

    // 检查是否 ≤0
    if (expiresIn <= 0) {
      console.warn(`[TokenRefresher] Invalid expiresIn for ${email}: ${expiresIn}s (must be > 0)`)
      return { status: 'invalid' }
    }

    // 检查是否小于最小合理时间（但大于0）- 使用返回值但记录警告
    // 注意：之前这里会触发 need_retry 导致双重刷新，现在改为直接使用返回值
    if (expiresIn < MIN_EXPIRES_IN) {
      console.warn(`[TokenRefresher] expiresIn short for ${email}: ${expiresIn}s (min recommended: ${MIN_EXPIRES_IN}s), using returned value`)
      return { status: 'valid', value: expiresIn }
    }

    // 检查是否超出最大范围 - 使用默认值
    if (expiresIn > MAX_EXPIRES_IN) {
      console.warn(`[TokenRefresher] expiresIn too long for ${email}: ${expiresIn}s (max: ${MAX_EXPIRES_IN}s), using default ${DEFAULT_EXPIRES_IN}s`)
      return { status: 'use_default', value: DEFAULT_EXPIRES_IN }
    }

    // 值合理
    return { status: 'valid', value: expiresIn }
  }

  // 生成随机 UUID 格式的机器码
  generateMachineId() {
    return randomUUID()
  }

  // 仅查询账号的机器码（不自动创建）
  async getMachineId(conn, accountId, email) {
    try {
      const [rows] = await conn.query(
        'SELECT machine_id FROM account_machine_ids WHERE account_id = ?',
        [accountId]
      )

      if (rows.length > 0) {
        return { found: true, machineId: rows[0].machine_id }
      }

      return { found: false, machineId: null }
    } catch (error) {
      console.error(
        `[TokenRefresher] Failed to get machine ID for ${email}:`,
        error.message
      )
      return { found: false, machineId: null, error: error.message }
    }
  }

  // 获取或创建账号的机器码（使用 INSERT ... ON DUPLICATE KEY 避免竞态条件）
  async getOrCreateMachineId(conn, accountId, email) {
    try {
      const newMachineId = this.generateMachineId()

      // 使用 INSERT ... ON DUPLICATE KEY UPDATE 避免竞态条件
      // 如果 account_id 已存在，不更新任何内容（保持原有机器码）
      await conn.query(
        `INSERT INTO account_machine_ids (account_id, machine_id)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE account_id = account_id`,
        [accountId, newMachineId]
      )

      // 查询实际使用的机器码（可能是新插入的，也可能是已存在的）
      const [rows] = await conn.query(
        'SELECT machine_id FROM account_machine_ids WHERE account_id = ?',
        [accountId]
      )

      if (rows.length > 0) {
        return rows[0].machine_id
      }

      // 理论上不会到这里，但作为兜底
      console.warn(`[TokenRefresher] Unexpected: no machine_id found after upsert for ${email}`)
      return newMachineId
    } catch (error) {
      console.error(
        `[TokenRefresher] Failed to get/create machine ID for ${email}:`,
        error.message
      )
      // 出错时返回一个临时机器码，不影响刷新流程
      return this.generateMachineId()
    }
  }

  /**
   * 检查是否为数据库死锁错误
   * @param {Error} error - 错误对象
   * @returns {boolean}
   */
  isDatabaseDeadlockError(error) {
    if (!error) return false
    const code = error.code || error.errno
    return code === 'ER_LOCK_DEADLOCK' || code === 1213 ||
           code === 'ER_LOCK_WAIT_TIMEOUT' || code === 1205
  }

  /**
   * 记录死锁事件并调整批量大小
   */
  recordDeadlock() {
    const now = Date.now()
    this.stats.deadlockCount++
    this.deadlockWindow.push(now)

    // 清理5分钟前的记录
    this.deadlockWindow = this.deadlockWindow.filter(t => now - t < 5 * 60 * 1000)

    // 如果5分钟内死锁超过3次，降低并发度
    if (this.deadlockWindow.length >= 3 && this.adaptiveBatchSize > 1) {
      this.adaptiveBatchSize = Math.max(1, Math.floor(this.adaptiveBatchSize / 2))
      console.warn(`[TokenRefresher] 检测到频繁死锁，降低批量大小至 ${this.adaptiveBatchSize}`)

      if (this.systemLogger) {
        this.systemLogger.logSystem({
          action: 'adaptive_batch_size',
          message: `检测到频繁死锁，批量大小从 ${BATCH_SIZE} 降至 ${this.adaptiveBatchSize}`,
          level: 'warn',
          details: {
            deadlockCount: this.deadlockWindow.length,
            newBatchSize: this.adaptiveBatchSize
          }
        }).catch(() => {})
      }
    }
  }

  /**
   * 尝试恢复批量大小（如果一段时间没有死锁）
   */
  tryRecoverBatchSize() {
    const now = Date.now()
    // 清理过期记录
    this.deadlockWindow = this.deadlockWindow.filter(t => now - t < 5 * 60 * 1000)

    // 如果5分钟内没有死锁，逐步恢复批量大小
    if (this.deadlockWindow.length === 0 && this.adaptiveBatchSize < BATCH_SIZE) {
      this.adaptiveBatchSize = Math.min(BATCH_SIZE, this.adaptiveBatchSize + 1)
      console.log(`[TokenRefresher] 死锁频率降低，恢复批量大小至 ${this.adaptiveBatchSize}`)
    }
  }

  /**
   * 带死锁重试的数据库更新操作
   * @param {object} conn - 数据库连接
   * @param {string} sql - SQL语句
   * @param {Array} params - 参数
   * @param {string} operationName - 操作名称（用于日志）
   * @returns {Promise<any>} 查询结果
   */
  async executeWithRetry(conn, sql, params, operationName = 'db_operation') {
    const operation = async () => {
      return await conn.query(sql, params)
    }

    try {
      return await withRetry(operation, {
        maxRetries: RETRY_CONFIG.MAX_RETRIES,
        operationName: `token_refresher:${operationName}`,
        logger: this.systemLogger ? (log) => this.systemLogger.logSystem(log).catch(() => {}) : null,
        shouldRetry: (error) => {
          if (this.isDatabaseDeadlockError(error)) {
            this.recordDeadlock()
            this.stats.databaseRetries++
            return true
          }
          return isDbRetryableError(error)
        }
      })
    } catch (error) {
      // 如果重试后仍然失败，记录统计
      if (this.isDatabaseDeadlockError(error)) {
        this.stats.dbOperationErrors++
      }
      throw error
    }
  }

  /**
   * 分类刷新错误
   * @param {string} errorMessage - 错误消息
   * @returns {string} 错误类型
   */
  classifyRefreshError(errorMessage) {
    if (!errorMessage) return RefreshErrorType.UNKNOWN

    const errorLower = errorMessage.toLowerCase()

    // 数据库死锁错误（可重试）
    if (errorLower.includes('deadlock') || errorLower.includes('lock wait timeout') ||
        errorLower.includes('er_lock_deadlock') || errorLower.includes('1213') ||
        errorLower.includes('er_lock_wait_timeout') || errorLower.includes('1205')) {
      return RefreshErrorType.DATABASE_DEADLOCK
    }

    // 凭证无效错误（不重试）
    const credentialErrors = [
      'invalid_grant',
      'invalid_token',
      'invalid_client',
      'unauthorized_client',
      'access_denied',
      'bad credentials',
      'authentication failed',
      'token revoked',
      'refresh token is invalid',
      'refresh token has expired'
    ]
    if (credentialErrors.some(err => errorLower.includes(err))) {
      return RefreshErrorType.CREDENTIAL_INVALID
    }

    // HTTP 401 - 凭证无效
    if (/\b401\b/.test(errorMessage)) {
      return RefreshErrorType.CREDENTIAL_INVALID
    }

    // 速率限制错误
    const rateLimitErrors = ['429', 'rate_limit', 'too many requests', 'rate limit exceeded', 'throttl']
    if (rateLimitErrors.some(err => errorLower.includes(err))) {
      return RefreshErrorType.RATE_LIMIT
    }

    // 网络错误
    const networkErrors = ['econnrefused', 'etimedout', 'enotfound', 'enetunreach', 'econnreset', 'socket hang up', 'network', 'dns']
    if (networkErrors.some(err => errorLower.includes(err))) {
      return RefreshErrorType.NETWORK_ERROR
    }

    // 服务器错误 (5xx)
    if (/\b5\d{2}\b/.test(errorMessage)) {
      return RefreshErrorType.SERVER_ERROR
    }

    // Token过期但可重试
    const tokenExpiredErrors = ['expired_token', 'token expired', 'token has expired']
    if (tokenExpiredErrors.some(err => errorLower.includes(err))) {
      return RefreshErrorType.TOKEN_EXPIRED
    }

    return RefreshErrorType.UNKNOWN
  }

  /**
   * 判断错误是否可重试
   * @param {string} errorType - 错误类型
   * @returns {boolean}
   */
  isRetryableError(errorType) {
    return [
      RefreshErrorType.TOKEN_EXPIRED,
      RefreshErrorType.NETWORK_ERROR,
      RefreshErrorType.RATE_LIMIT,
      RefreshErrorType.SERVER_ERROR,
      RefreshErrorType.DATABASE_DEADLOCK
    ].includes(errorType)
  }

  /**
   * 获取重试延迟时间
   * @param {string} errorType - 错误类型
   * @returns {number} 延迟毫秒数
   */
  getRetryDelay(errorType) {
    return RETRY_DELAYS[errorType] || 5000
  }

  /**
   * 添加到重试队列
   * @param {string} accountId - 账号ID
   * @param {string} errorType - 错误类型
   * @param {string} lastError - 最后的错误消息
   */
  addToRetryQueue(accountId, errorType, lastError) {
    const existing = this.retryQueue.get(accountId)
    const attempts = existing ? existing.attempts + 1 : 1

    if (attempts > MAX_RETRY_ATTEMPTS) {
      console.log(`[TokenRefresher] Account ${accountId} exceeded max retry attempts (${MAX_RETRY_ATTEMPTS}), removing from retry queue`)
      this.retryQueue.delete(accountId)
      return false
    }

    const delay = this.getRetryDelay(errorType)
    const nextRetryTime = Date.now() + delay

    this.retryQueue.set(accountId, {
      attempts,
      nextRetryTime,
      errorType,
      lastError
    })

    console.log(`[TokenRefresher] Added ${accountId} to retry queue: attempt ${attempts}/${MAX_RETRY_ATTEMPTS}, next retry at ${new Date(nextRetryTime).toISOString()}`)
    return true
  }

  /**
   * 处理重试队列中到期的账号
   * @param {object} conn - 数据库连接
   * @returns {Promise<Array>} 需要重试的账号列表
   */
  async processRetryQueue(conn) {
    const now = Date.now()
    const accountsToRetry = []

    for (const [accountId, retryInfo] of this.retryQueue.entries()) {
      if (retryInfo.nextRetryTime <= now) {
        // 查询账号信息
        const [rows] = await conn.query(
          `SELECT id, email, idp, cred_access_token, cred_refresh_token,
                  cred_client_id, cred_client_secret, cred_region,
                  cred_expires_at, cred_auth_method, cred_provider
           FROM accounts WHERE id = ? AND (is_del = FALSE OR is_del IS NULL)`,
          [accountId]
        )

        if (rows.length > 0) {
          accountsToRetry.push({
            ...rows[0],
            retryAttempt: retryInfo.attempts,
            previousErrorType: retryInfo.errorType
          })
        }

        // 从队列中移除（无论是否找到账号）
        this.retryQueue.delete(accountId)
      }
    }

    if (accountsToRetry.length > 0) {
      console.log(`[TokenRefresher] Processing ${accountsToRetry.length} accounts from retry queue`)
    }

    return accountsToRetry
  }

  /**
   * 刷新 IdC (BuilderId) 的 OIDC Token
   * 完全照抄 Electron 主进程的 refreshOidcToken 函数
   */
  async refreshOidcToken(refreshToken, clientId, clientSecret, region, machineId, accountId = null, accountEmail = null) {
    console.log(`[TokenRefresher] [OIDC] Refreshing token with clientId: ${clientId.substring(0, 20)}...`)

    const url = `https://oidc.${region || 'us-east-1'}.amazonaws.com/token`

    // 请求体格式与 Electron 一致：JSON 格式
    const payload = {
      clientId,
      clientSecret,
      refreshToken,
      grantType: 'refresh_token'
    }

    try {
      // 严格匹配 Rust 实现 (Kiro_New/src-tauri/src/aws_sso_client.rs)
      // 1. 只保留 Content-Type
      // 2. 移除自定义 User-Agent (使用 fetch 默认值或 reqwest 默认值)
      // 3. 移除 x-amzn-sessionid 和 x-device-id (Rust 客户端未发送这些头)
      const headers = {
        'Content-Type': 'application/json'
        // 注意：Rust 端使用的是 reqwest 默认 UA，这里不设置 User-Agent 让 fetch 使用默认值
        // 绝对不要发送 Mozilla/5.0 等浏览器 UA，否则会被识别为异常流量
      }

      const requestStartTime = Date.now()
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      })

      const requestDuration = Date.now() - requestStartTime

      // 记录API调用日志
      if (this.systemLogger && accountId) {
        await this.systemLogger.logApiCall({
          accountId,
          accountEmail,
          endpoint: url,
          method: 'POST',
          statusCode: response.status,
          durationMs: requestDuration,
          errorType: response.ok ? null : 'oidc_token_refresh_failed',
          requestHeaders: headers
        }).catch(() => {})
      }

      if (!response.ok) {
        const errorText = await response.text()
        console.error(`[TokenRefresher] [OIDC] Refresh failed: ${response.status} - ${errorText}`)
        return { success: false, error: `HTTP ${response.status}: ${errorText}` }
      }

      const data = await response.json()
      console.log(`[TokenRefresher] [OIDC] Token refreshed successfully, expires in ${data.expiresIn}s`)

      return {
        success: true,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || refreshToken, // 可能不返回新的 refreshToken
        expiresIn: data.expiresIn
      }
    } catch (error) {
      console.error(`[TokenRefresher] [OIDC] Refresh error:`, error)
      return { success: false, error: error.message || 'Unknown error' }
    }
  }

  /**
   * 刷新社交登录 (GitHub/Google) 的 Token
   * 完全照抄 Electron 主进程的 refreshSocialToken 函数
   */
  async refreshSocialToken(refreshToken, provider, machineId, accountId = null, accountEmail = null) {
    console.log(`[TokenRefresher] [Social] Refreshing ${provider} token...`)

    const url = `${KIRO_AUTH_ENDPOINT}/refreshToken`

    try {
      // 严格匹配 Rust 实现 (Kiro_New/src-tauri/src/kiro_auth_client.rs)
      // 1. 保留 User-Agent: KiroBatchLoginCLI/1.0.0
      // 2. 移除 x-amzn-sessionid 和 x-device-id (Rust 客户端未发送这些头)
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'KiroBatchLoginCLI/1.0.0'
      }

      const requestStartTime = Date.now()
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ refreshToken })
      })

      const requestDuration = Date.now() - requestStartTime

      // 记录API调用日志
      if (this.systemLogger && accountId) {
        await this.systemLogger.logApiCall({
          accountId,
          accountEmail,
          endpoint: url,
          method: 'POST',
          statusCode: response.status,
          durationMs: requestDuration,
          errorType: response.ok ? null : 'social_token_refresh_failed',
          requestHeaders: headers
        }).catch(() => {})
      }

      if (!response.ok) {
        const errorText = await response.text()
        console.error(`[TokenRefresher] [Social] Refresh failed: ${response.status} - ${errorText}`)
        return { success: false, error: `HTTP ${response.status}: ${errorText}` }
      }

      const data = await response.json()
      console.log(`[TokenRefresher] [Social] Token refreshed successfully, expires in ${data.expiresIn}s`)

      return {
        success: true,
        accessToken: data.accessToken,
        refreshToken: data.refreshToken || refreshToken,
        expiresIn: data.expiresIn
      }
    } catch (error) {
      console.error(`[TokenRefresher] [Social] Refresh error:`, error)
      return { success: false, error: error.message || 'Unknown error' }
    }
  }

  /**
   * 刷新单个账号的 token（带分布式锁保护）
   *
   * 流程：
   * 0. 获取分布式锁，防止多实例同时刷新同一账号
   * 1. 根据 AUTO_BIND_MACHINE_ID 环境变量决定机器码获取方式：
   *    - true: 获取或创建机器码（如果不存在则自动绑定到数据库）
   *    - false（默认）: 仅查询已有机器码，如果不存在则跳过该账号
   * 2. 根据 authMethod 选择刷新方式（与 Electron 的 refreshTokenByMethod 一致）
   * 3. 更新数据库中的 token
   * 4. 调用 Kiro API 获取最新使用量和订阅信息
   */
  async refreshSingleAccount(conn, account, retryAttempt = 0) {
    const { id, email, idp: accountIdp } = account

    // 使用分布式锁保护刷新操作
    const lockName = LockNames.tokenRefresh(id)
    const lockStartTime = Date.now()

    const lockResult = await withLock(lockName, 60, async () => {
      // 锁获取成功，执行实际的刷新逻辑
      return await this._doRefreshSingleAccount(conn, account, retryAttempt)
    })

    // 记录锁获取时间
    if (lockResult.lockAcquired) {
      const lockTime = lockResult.lockAcquireTime || (Date.now() - lockStartTime)
      this.stats.lockAcquireTime += lockTime
      this.stats.lockAcquireCount++
    }

    if (!lockResult.lockAcquired) {
      // 无法获取锁，说明其他实例正在刷新该账号
      this.stats.lockSkipped++
      this.stats.concurrentRefreshAttempts++
      console.log(`[TokenRefresher] Skipping ${email}: another instance is refreshing this account`)

      if (this.systemLogger) {
        await this.systemLogger.logTokenRefresh({
          accountId: id,
          accountEmail: email,
          accountIdp,
          success: false,
          message: `跳过刷新: 其他实例正在刷新该账号`,
          details: { reason: 'lock_conflict', lockName }
        }).catch(() => {})
      }

      return { success: false, error: 'Lock conflict - another instance is refreshing', skipped: true }
    }

    if (!lockResult.success) {
      // 锁获取成功但执行失败
      return { success: false, error: lockResult.error?.message || 'Unknown error during refresh' }
    }

    return lockResult.result
  }

  /**
   * 实际执行刷新的内部方法（在分布式锁保护下执行）
   */
  async _doRefreshSingleAccount(conn, account, retryAttempt = 0) {
    const startTime = Date.now()
    const stepTimings = {} // 记录各步骤耗时

    const {
      id,
      email,
      idp: accountIdp,
      cred_refresh_token,
      cred_client_id,
      cred_client_secret,
      cred_region,
      cred_auth_method,
      cred_provider
    } = account

    // 更新统计
    this.stats.totalRefreshes++

    // 1. 根据环境变量决定机器码获取方式
    const machineIdStartTime = Date.now()
    let machineId
    if (AUTO_BIND_MACHINE_ID) {
      // 自动绑定模式：获取或创建机器码
      machineId = await this.getOrCreateMachineId(conn, id, email)
      console.log(
        `[TokenRefresher] Processing ${email} (authMethod: ${cred_auth_method}, provider: ${cred_provider}) with machineId: ${machineId.substring(0, 8)}... (auto-bind enabled)${retryAttempt > 0 ? ` [retry ${retryAttempt}]` : ''}`
      )
    } else {
      // 默认模式：仅查询已有机器码
      const result = await this.getMachineId(conn, id, email)
      if (!result.found) {
        const durationMs = Date.now() - startTime
        // 账号没有绑定机器码，跳过刷新
        console.log(
          `[TokenRefresher] Skipping ${email}: no machine ID bound (AUTO_BIND_MACHINE_ID=false)`
        )

        if (this.systemLogger) {
          await this.systemLogger.logTokenRefresh({
            accountId: id,
            accountEmail: email,
            accountIdp,
            success: false,
            message: `跳过刷新: 账号未绑定机器码 (AUTO_BIND_MACHINE_ID=false)`,
            details: { authMethod: cred_auth_method, reason: 'no_machine_id' }
          })

          // 记录跳过的性能日志
          await this.systemLogger.logPerformance({
            operation: 'token_refresh',
            durationMs,
            success: false,
            details: {
              accountId: id,
              accountEmail: email,
              authMethod: cred_auth_method,
              errorType: 'no_machine_id',
              reason: 'No machine ID bound (AUTO_BIND_MACHINE_ID=false)'
            }
          }).catch(() => {})
        }

        return { success: false, error: 'No machine ID bound', skipped: true }
      }
      machineId = result.machineId
      console.log(
        `[TokenRefresher] Processing ${email} (authMethod: ${cred_auth_method}, provider: ${cred_provider}) with machineId: ${machineId.substring(0, 8)}...${retryAttempt > 0 ? ` [retry ${retryAttempt}]` : ''}`
      )
    }
    stepTimings.getMachineId = Date.now() - machineIdStartTime

    // 2. 根据认证方式刷新 token（与 Electron 的 refreshTokenByMethod 逻辑一致）
    const tokenRefreshStartTime = Date.now()
    let result
    if (cred_auth_method === 'social') {
      // 社交登录：使用 Kiro Auth Service 刷新
      result = await this.refreshSocialToken(cred_refresh_token, cred_provider, machineId, id, email)
    } else if (cred_auth_method === 'oidc' || cred_auth_method === 'IdC') {
      // IdC/BuilderId：使用 AWS OIDC 刷新
      result = await this.refreshOidcToken(
        cred_refresh_token,
        cred_client_id,
        cred_client_secret,
        cred_region,
        machineId,
        id,
        email
      )
    } else {
      const durationMs = Date.now() - startTime
      console.log(`[TokenRefresher] Unknown auth method for ${email}: ${cred_auth_method}`)

      // 记录失败的性能日志
      if (this.systemLogger) {
        await this.systemLogger.logPerformance({
          operation: 'token_refresh',
          durationMs,
          success: false,
          details: {
            accountId: id,
            accountEmail: email,
            authMethod: cred_auth_method,
            errorType: 'unknown_auth_method',
            reason: `Unknown auth method: ${cred_auth_method}`
          }
        }).catch(() => {})
      }

      return { success: false, error: 'Unknown auth method' }
    }
    stepTimings.tokenRefresh = Date.now() - tokenRefreshStartTime

    // 计算耗时
    const durationMs = Date.now() - startTime
    this.stats.totalDurationMs += durationMs

    // 记录到性能滑动窗口
    this.recordRefreshDuration(durationMs)

    // 记录最慢刷新
    this.recordSlowestRefresh(id, email, durationMs)

    // 3. 更新数据库中的 token
    const dbUpdateStartTime = Date.now()
    if (result.success) {
      this.stats.successfulRefreshes++
      this.recordRecentResult(true)

      // 定义 now 变量，确保在所有分支中都能使用
      const now = Date.now()

      // 校验 expiresIn 值
      const expiresValidation = this.validateExpiresIn(result.expiresIn, email)

      // 处理 expiresIn 异常情况
      if (expiresValidation.status === 'invalid') {
        // 非数字或 ≤0：标记账号异常，等待下次自动刷新
        console.error(`[TokenRefresher] ✗ Invalid expiresIn for ${email}, marking account as error`)
        await conn.query(
          'UPDATE accounts SET status = ?, last_error = ?, last_checked_at = ? WHERE id = ?',
          ['error', `Invalid expiresIn: ${result.expiresIn}`, Date.now(), id]
        )

        // 记录失败的性能日志
        if (this.systemLogger) {
          await this.systemLogger.logTokenRefresh({
            accountId: id,
            accountEmail: email,
            accountIdp,
            success: false,
            message: `Token 刷新返回无效的过期时间: ${result.expiresIn}，账号已标记为异常`,
            details: { expiresIn: result.expiresIn, authMethod: cred_auth_method, durationMs }
          })

          await this.systemLogger.logPerformance({
            operation: 'token_refresh',
            durationMs,
            success: false,
            details: {
              accountId: id,
              accountEmail: email,
              authMethod: cred_auth_method,
              errorType: 'invalid_expires_in',
              reason: `Invalid expiresIn: ${result.expiresIn}`
            }
          }).catch(() => {})
        }

        return { success: false, error: `Invalid expiresIn: ${result.expiresIn}` }
      }

      // 正常情况：valid 或 use_default（注：need_retry 逻辑已移除，短过期时间直接使用返回值）
      const finalExpiresIn = expiresValidation.value
      const newExpiresAt = now + finalExpiresIn * 1000

      // 使用带重试的数据库更新
      const [updateResult] = await this.executeWithRetry(
        conn,
        'UPDATE accounts SET cred_access_token = ?, cred_refresh_token = ?, cred_expires_at = ?, status = ?, last_checked_at = ? WHERE id = ?',
        [result.accessToken, result.refreshToken || cred_refresh_token, newExpiresAt, 'active', now, id],
        `update_token_${email}`
      )
      stepTimings.dbUpdate = Date.now() - dbUpdateStartTime

      // 如果有死锁重试成功，记录统计
      if (this.stats.databaseRetries > 0) {
        this.stats.deadlockRecovered++
      }

      console.log(`[TokenRefresher] ✓ Refreshed token for ${email}, expires at ${new Date(newExpiresAt).toISOString()}, affectedRows: ${updateResult.affectedRows}`)

      // 记录成功日志和性能指标
      if (this.systemLogger) {
        await this.systemLogger.logTokenRefresh({
          accountId: id,
          accountEmail: email,
          accountIdp,
          success: true,
          message: `Token 刷新成功，有效期至 ${new Date(newExpiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
          durationMs,
          details: {
            expiresAt: newExpiresAt,
            authMethod: cred_auth_method,
            usedDefault: expiresValidation.status === 'use_default',
            stepTimings
          }
        })

        // 记录性能指标
        await this.systemLogger.logPerformance({
          operation: 'token_refresh',
          durationMs,
          success: true,
          details: {
            accountId: id,
            accountEmail: email,
            authMethod: cred_auth_method,
            stepTimings
          }
        }).catch(() => {})
      }

      // 刷新活跃池中的账号信息
      if (this.accountPool?.activePoolConfig?.enabled) {
        await this.accountPool.refreshActivePoolAccount(id)
      }

      // 如果启用了自动刷新使用量，在 token 刷新成功后获取使用量
      if (AUTO_REFRESH_USAGE_AFTER_TOKEN) {
        // 检查上次刷新时间，如果距离上次刷新 < 5 分钟，则跳过
        const [usageRows] = await conn.query(
          'SELECT usage_last_updated FROM accounts WHERE id = ?',
          [id]
        )

        const lastUpdated = usageRows[0]?.usage_last_updated || 0
        const timeSinceLastUpdate = Date.now() - lastUpdated

        if (timeSinceLastUpdate < USAGE_REFRESH_MIN_INTERVAL) {
          const remainingTime = Math.ceil((USAGE_REFRESH_MIN_INTERVAL - timeSinceLastUpdate) / 1000)
          console.log(`[TokenRefresher] ⏭ Skipping usage refresh for ${email}: last updated ${Math.floor(timeSinceLastUpdate / 1000)}s ago (min interval: ${USAGE_REFRESH_MIN_INTERVAL / 1000}s, remaining: ${remainingTime}s)`)

          if (this.systemLogger) {
            await this.systemLogger.logSystem({
              action: 'usage_refresh',
              accountId: id,
              accountEmail: email,
              accountIdp,
              message: `使用量刷新跳过: 距上次刷新仅 ${Math.floor(timeSinceLastUpdate / 1000)}s (最小间隔: ${USAGE_REFRESH_MIN_INTERVAL / 1000}s)`,
              details: {
                timeSinceLastUpdate: Math.floor(timeSinceLastUpdate / 1000),
                minInterval: USAGE_REFRESH_MIN_INTERVAL / 1000,
                skipped: true
              },
              level: 'info'
            }).catch(() => {})
          }
        } else {
          // 等待 1-3 秒后获取使用量
          const delayMs = Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS
          console.log(`[TokenRefresher] Waiting ${delayMs}ms before fetching usage for ${email}...`)
          await this.sleep(delayMs)

          try {
            const usageResult = await getUsageLimits(result.accessToken, machineId)
            const parsed = parseUsageResponse(usageResult)
            const now = Date.now()

            // 更新数据库中的使用量和订阅信息（包含完整的资源包明细）
            // 注意：parseUsageResponse 返回的数据在 data 属性中
            const usageData = parsed.data
            await conn.query(
              `UPDATE accounts SET
                usage_current = ?, usage_limit = ?, usage_percent_used = ?, usage_last_updated = ?,
                usage_base_limit = ?, usage_base_current = ?,
                usage_free_trial_limit = ?, usage_free_trial_current = ?, usage_free_trial_expiry = ?,
                usage_bonuses = ?, usage_next_reset_date = ?,
                sub_type = ?, sub_title = ?, sub_days_remaining = ?, sub_expires_at = ?,
                sub_raw_type = ?, sub_upgrade_capability = ?, sub_overage_capability = ?, sub_management_target = ?
               WHERE id = ?`,
              [
                usageData.usage.current, usageData.usage.limit, usageData.usage.percentUsed, now,
                usageData.usage.baseLimit, usageData.usage.baseCurrent,
                usageData.usage.freeTrialLimit, usageData.usage.freeTrialCurrent, usageData.usage.freeTrialExpiry,
                JSON.stringify(usageData.usage.bonuses || []), usageData.usage.nextResetDate,
                usageData.subscription.type, usageData.subscription.title, usageData.subscription.daysRemaining, usageData.subscription.expiresAt,
                usageData.subscription.rawType, usageData.subscription.upgradeCapability, usageData.subscription.overageCapability, usageData.subscription.managementTarget,
                id
              ]
            )

            console.log(`[TokenRefresher] ✓ Usage updated for ${email}: ${usageData.usage.current}/${usageData.usage.limit}`)

            if (this.systemLogger) {
              await this.systemLogger.logSystem({
                action: 'usage_refresh',
                accountId: id,
                accountEmail: email,
                accountIdp,
                message: `使用量刷新成功: ${usageData.usage.current}/${usageData.usage.limit}`,
                details: { usage: usageData.usage },
                level: 'info'
              }).catch(() => {})
            }
          } catch (usageError) {
            const usageErrorMsg = usageError instanceof Error ? usageError.message : String(usageError)
            console.warn(`[TokenRefresher] ⚠ Failed to fetch usage for ${email}: ${usageErrorMsg}`)

            // 检查是否被封禁
            if (usageErrorMsg.startsWith('BANNED:')) {
              console.error(`[TokenRefresher] Account ${email} is BANNED: ${usageErrorMsg}`)

              // 更新数据库状态
              await conn.query(
                `UPDATE accounts SET status = 'banned', last_error = ?, last_checked_at = ? WHERE id = ?`,
                [usageErrorMsg, Date.now(), id]
              )

              // 从账号池中永久移除（如果启用了活跃池）
              if (this.accountPool) {
                await this.accountPool.banAccount(id, usageErrorMsg)
              }
            }

            if (this.systemLogger) {
              await this.systemLogger.logSystem({
                action: 'usage_refresh',
                accountId: id,
                accountEmail: email,
                accountIdp,
                message: `使用量刷新失败: ${usageErrorMsg}`,
                details: { error: usageErrorMsg },
                level: usageErrorMsg.startsWith('BANNED:') ? 'error' : 'warn'
              }).catch(() => {})
            }
          }
        }
      }
    } else {
      // 刷新失败
      this.stats.failedRefreshes++
      this.recordRecentResult(false)
      stepTimings.dbUpdate = Date.now() - dbUpdateStartTime

      // 分类错误
      const errorType = this.classifyRefreshError(result.error)
      this.stats.errorsByType[errorType] = (this.stats.errorsByType[errorType] || 0) + 1

      console.error(`[TokenRefresher] ✗ Failed to refresh token for ${email}: ${result.error} (type: ${errorType})`)

      // 记录失败的性能指标
      if (this.systemLogger) {
        await this.systemLogger.logPerformance({
          operation: 'token_refresh',
          durationMs,
          success: false,
          details: {
            accountId: id,
            accountEmail: email,
            authMethod: cred_auth_method,
            errorType,
            error: result.error,
            stepTimings
          }
        }).catch(() => {})
      }

      // 检查是否需要触发告警
      await this.checkAndTriggerAlerts()

      // 根据错误类型决定是否重试
      if (this.isRetryableError(errorType) && retryAttempt < MAX_RETRY_ATTEMPTS) {
        // 添加到重试队列
        const willRetry = this.addToRetryQueue(id, errorType, result.error)

        if (this.systemLogger) {
          await this.systemLogger.logTokenRefresh({
            accountId: id,
            accountEmail: email,
            accountIdp,
            success: false,
            message: `Token 刷新失败: ${result.error}${willRetry ? ` (将在稍后重试, 尝试 ${retryAttempt + 1}/${MAX_RETRY_ATTEMPTS})` : ' (已达最大重试次数)'}`,
            details: {
              error: result.error,
              errorType,
              authMethod: cred_auth_method,
              retryAttempt,
              willRetry,
              durationMs
            }
          })
        }
      } else {
        // 凭证无效或已达最大重试次数，标记账号为error状态
        if (errorType === RefreshErrorType.CREDENTIAL_INVALID) {
          await conn.query(
            'UPDATE accounts SET status = ?, last_error = ?, last_checked_at = ? WHERE id = ?',
            ['error', result.error, Date.now(), id]
          )
          console.log(`[TokenRefresher] ⚠ Marked account ${email} as error due to credential invalid`)
        }

        // 记录失败日志
        if (this.systemLogger) {
          await this.systemLogger.logTokenRefresh({
            accountId: id,
            accountEmail: email,
            accountIdp,
            success: false,
            message: `Token 刷新失败: ${result.error}${errorType === RefreshErrorType.CREDENTIAL_INVALID ? ' (账号已标记为异常)' : ''}`,
            details: {
              error: result.error,
              errorType,
              authMethod: cred_auth_method,
              markedAsError: errorType === RefreshErrorType.CREDENTIAL_INVALID,
              durationMs
            }
          })
        }
      }
    }

    return result
  }

  /**
   * 检查并刷新即将过期的 token（串行处理，每批最多 BATCH_SIZE 个）
   *
   * 重要：必须串行处理，不能并发！
   * 原因：每个账号需要先切换到对应的机器码，再刷新 token
   */
  async checkAndRefresh() {
    // 防止并发执行或正在关闭
    if (this.isRefreshing) {
      console.log('[TokenRefresher] Already refreshing, skipping...')
      return
    }
    if (this.isShuttingDown) {
      console.log('[TokenRefresher] Shutting down, skipping refresh...')
      return
    }

    // 获取完整的工作状态
    const status = getWorkingStatus()

    // 检查是否在工作时段内
    if (!status.isInWorkingHours) {
      console.log(`[TokenRefresher] ${status.message}，跳过 Token 刷新`)
      return
    }

    // 检查是否为非工作日且配置了跳过
    if (!status.isWorkday && status.skipOnHoliday) {
      console.log(`[TokenRefresher] 今天是非工作日（${status.date}），跳过 Token 刷新`)
      return
    }

    this.isRefreshing = true
    this.lastCheckTime = Date.now()
    let conn = null
    const batchStartTime = Date.now()

    try {
      conn = await this.pool.getConnection()
      const now = Date.now()
      // 使用随机的提前刷新时间（1-20分钟之间）
      const randomThreshold = this.getRandomRefreshThreshold()
      const threshold = now + randomThreshold

      console.log(`[TokenRefresher] Using refresh threshold: ${Math.round(randomThreshold / 60000)} minutes before expiry`)

      // 先处理重试队列中到期的账号
      const retryAccounts = await this.processRetryQueue(conn)

      // 尝试恢复批量大小
      this.tryRecoverBatchSize()

      // 使用自适应批量大小
      const effectiveBatchSize = this.adaptiveBatchSize

      // 检查是否启用活跃池模式
      const useActivePoolMode = this.activePoolOnlyMode &&
        this.accountPool?.activePoolConfig?.enabled &&
        this.accountPool?.activePoolInitialized

      let rows = []

      if (useActivePoolMode) {
        // 活跃池模式：只刷新活跃池中的账号
        const activePoolAccountIds = this.accountPool.getActivePoolAccountIds()

        if (activePoolAccountIds.length === 0) {
          console.log('[TokenRefresher] Active pool is empty, no accounts to refresh')
        } else {
          // 构建 IN 子句的占位符
          const placeholders = activePoolAccountIds.map(() => '?').join(',')

          // 查询活跃池中需要刷新的账号
          // 只要 cred_expires_at < threshold（即将过期或已过期）就刷新
          // 因为 cred_refresh_token 有效期很长（至少2个月），不需要下限检查
          const [activeRows] = await this.executeWithRetry(
            conn,
            `SELECT id, email, idp, cred_access_token, cred_refresh_token,
                    cred_client_id, cred_client_secret, cred_region,
                    cred_expires_at, cred_auth_method, cred_provider
             FROM accounts
             WHERE id IN (${placeholders})
               AND cred_expires_at IS NOT NULL
               AND cred_refresh_token IS NOT NULL
               AND cred_refresh_token != ''
               AND cred_expires_at < ?
               AND status != 'error'
               AND status != 'banned'
               AND (is_del = FALSE OR is_del IS NULL)
             ORDER BY cred_expires_at ASC
             LIMIT ?`,
            [...activePoolAccountIds, threshold, effectiveBatchSize - retryAccounts.length],
            'query_expiring_accounts_active_pool'
          )

          rows = activeRows
          this.stats.activePoolRefreshes += rows.length

          console.log(`[TokenRefresher] Active pool mode: found ${rows.length} accounts to refresh (pool size: ${activePoolAccountIds.length})`)
        }
      } else {
        // 传统模式：查找所有即将过期或已过期的账号
        // 只要 cred_expires_at < threshold（即将过期或已过期）就刷新
        // 因为 cred_refresh_token 有效期很长（至少2个月），不需要下限检查
        // 排除已删除的账号（is_del = TRUE）
        const [allRows] = await this.executeWithRetry(
          conn,
          `SELECT id, email, idp, cred_access_token, cred_refresh_token,
                  cred_client_id, cred_client_secret, cred_region,
                  cred_expires_at, cred_auth_method, cred_provider
           FROM accounts
           WHERE cred_expires_at IS NOT NULL
             AND cred_refresh_token IS NOT NULL
             AND cred_refresh_token != ''
             AND cred_expires_at < ?
             AND status != 'error'
             AND status != 'banned'
             AND (is_del = FALSE OR is_del IS NULL)
           ORDER BY cred_expires_at ASC
           LIMIT ?`,
          [threshold, effectiveBatchSize - retryAccounts.length],
          'query_expiring_accounts'
        )

        rows = allRows
      }

      // 合并重试账号和新账号
      const allAccounts = [...retryAccounts, ...rows]

      if (allAccounts.length === 0) {
        console.log('[TokenRefresher] No tokens need refreshing')
        return
      }

      console.log(
        `[TokenRefresher] Found ${allAccounts.length} tokens to refresh (${retryAccounts.length} from retry queue, ${rows.length} new, batch limit: ${effectiveBatchSize}/${BATCH_SIZE})`
      )

      // 串行处理每个账号（重要：不能并发！）
      let successCount = 0
      let failCount = 0
      const durations = []
      let totalSleepTime = 0 // 记录总等待时间

      const totalAccounts = allAccounts.length

      for (let index = 0; index < totalAccounts; index++) {
        // 检查是否正在关闭
        if (this.isShuttingDown) {
          console.log('[TokenRefresher] Shutdown requested, stopping batch processing...')
          break
        }

        const account = allAccounts[index]
        const progress = `[${index + 1}/${totalAccounts}]`
        const accountStartTime = Date.now()

        try {
          const retryAttempt = account.retryAttempt || 0
          const result = await this.refreshSingleAccount(conn, account, retryAttempt)
          const accountDuration = Date.now() - accountStartTime
          durations.push(accountDuration)

          if (result.success) {
            successCount++
            console.log(`[TokenRefresher] ${progress} ✓ ${account.email} refreshed successfully (${accountDuration}ms)`)
          } else {
            failCount++
            const errorReason = result.error || 'Unknown error'
            console.warn(`[TokenRefresher] ${progress} ✗ ${account.email} failed: ${errorReason} (${accountDuration}ms)`)
          }
        } catch (error) {
          failCount++
          const accountDuration = Date.now() - accountStartTime
          durations.push(accountDuration)
          const errorMessage = error instanceof Error ? error.message : String(error)
          console.error(`[TokenRefresher] ${progress} ✗ ${account.email} threw exception: ${errorMessage} (${accountDuration}ms)`)

          // 记录单个账号的异常日志
          if (this.systemLogger) {
            await this.systemLogger.logTokenRefresh({
              accountId: account.id,
              accountEmail: account.email,
              accountIdp: account.idp,
              success: false,
              message: `Token 刷新异常: ${errorMessage}`,
              details: { error: errorMessage, authMethod: account.cred_auth_method, durationMs: accountDuration }
            }).catch((logErr) => {
              console.warn(`[TokenRefresher] Failed to log token refresh error: ${logErr.message}`)
            })
          }
        }

        // 最后一个账号处理完后不需要延迟
        const isLastAccount = index === totalAccounts - 1
        if (!isLastAccount && !this.isShuttingDown) {
          // 随机延迟 1-5 秒，避免请求模式被识别
          const randomDelay = Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS + 1)) + MIN_DELAY_MS
          totalSleepTime += randomDelay
          await this.sleep(randomDelay)
        }
      }

      // 计算批次统计
      const batchDuration = Date.now() - batchStartTime
      const netBatchDuration = batchDuration - totalSleepTime // 排除等待时间的净耗时
      const avgDuration = durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0

      console.log(`[TokenRefresher] Completed: ${successCount} success, ${failCount} failed, avg ${avgDuration}ms/account, total ${batchDuration}ms (net: ${netBatchDuration}ms, sleep: ${totalSleepTime}ms)`)
      console.log(`[TokenRefresher] Error stats:`, this.stats.errorsByType)

      // 记录批量刷新完成日志（每次检查都输出，无论是否有账号需要刷新）
      if (this.systemLogger) {
        await this.systemLogger.logSystem({
          action: 'batch_token_refresh',
          message: allAccounts.length > 0
            ? `批量 Token 刷新完成: ${successCount} 成功, ${failCount} 失败`
            : `批量 Token 检查完成: 无需刷新的账号`,
          details: {
            total: allAccounts.length,
            success: successCount,
            failed: failCount,
            batchLimit: effectiveBatchSize,
            maxBatchLimit: BATCH_SIZE,
            retryQueueSize: this.retryQueue.size,
            avgDurationMs: avgDuration,
            totalDurationMs: batchDuration,
            netDurationMs: netBatchDuration, // 净耗时（排除sleep）
            sleepTimeMs: totalSleepTime, // 总等待时间
            errorsByType: this.stats.errorsByType,
            // 新增：数据库操作统计
            databaseStats: {
              retries: this.stats.databaseRetries,
              deadlocks: this.stats.deadlockCount,
              recovered: this.stats.deadlockRecovered
            }
          },
          level: failCount > 0 ? 'warn' : (allAccounts.length > 0 ? 'success' : 'info')
        }).catch((logErr) => {
          console.warn(`[TokenRefresher] Failed to log batch completion: ${logErr.message}`)
        })
      }
    } catch (error) {
      console.error('[TokenRefresher] Check and refresh failed:', error)

      // 记录错误日志
      if (this.systemLogger) {
        await this.systemLogger.logSystem({
          action: 'batch_token_refresh',
          message: `批量 Token 刷新出错: ${error.message}`,
          details: { error: error.message },
          level: 'error'
        }).catch((logErr) => {
          console.warn(`[TokenRefresher] Failed to log batch error: ${logErr.message}`)
        })
      }
    } finally {
      if (conn) {
        conn.release()
      }
      this.isRefreshing = false
    }
  }

  // 延迟函数
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * 检测是否为凭证无效的错误（保留向后兼容）
   * @deprecated 使用 classifyRefreshError 代替
   */
  isCredentialInvalidError(errorMessage) {
    return this.classifyRefreshError(errorMessage) === RefreshErrorType.CREDENTIAL_INVALID
  }

  // 启动定时刷新
  start() {
    if (this.timer) {
      console.log('[TokenRefresher] Already running')
      return
    }

    // 重置关闭标志
    this.isShuttingDown = false

    console.log(
      `[TokenRefresher] Starting (check interval: ${CHECK_INTERVAL / 1000}s, batch size: ${BATCH_SIZE}, refresh window: 1-20 min)`
    )

    // 计算下一个整点时间（对齐到 CHECK_INTERVAL 的倍数，如 5、10、15、20 分钟）
    // 这样执行时间点是固定的，类似 cron 表达式
    const now = Date.now()
    const nextRun = Math.ceil(now / CHECK_INTERVAL) * CHECK_INTERVAL
    const delay = nextRun - now

    console.log(
      `[TokenRefresher] Next run scheduled at ${new Date(nextRun).toISOString()} (in ${Math.round(delay / 1000)}s)`
    )

    // 记录下次检测时间
    this.nextCheckTime = nextRun

    // 先等待到下一个整点时间，然后开始固定间隔执行
    this.timer = setTimeout(() => {
      // 执行第一次检查（checkAndRefresh 内部会检查工作时段）
      this.checkAndRefresh().catch(err => {
        console.error('[TokenRefresher] Check and refresh error:', err)
      })

      // 第一次执行后，更新下次检测时间
      this.nextCheckTime = Date.now() + CHECK_INTERVAL

      // 使用 setInterval 进行后续的固定间隔执行
      // 注意：setInterval 的间隔是固定的，不受 checkAndRefresh() 执行时间影响
      this.timer = setInterval(() => {
        // 更新下次检测时间
        this.nextCheckTime = Date.now() + CHECK_INTERVAL
        this.checkAndRefresh().catch(err => {
          console.error('[TokenRefresher] Check and refresh error:', err)
        })
      }, CHECK_INTERVAL)
    }, delay)
  }

  // 停止定时刷新
  stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.isShuttingDown = true
    this.nextCheckTime = null
    console.log('[TokenRefresher] Stopped')
  }

  /**
   * 优雅关闭：等待当前刷新完成后停止
   */
  async shutdown() {
    console.log('[TokenRefresher] Initiating graceful shutdown...')
    this.isShuttingDown = true

    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }

    // 等待当前刷新完成（最多等待 60 秒）
    const maxWait = 60000
    const startTime = Date.now()

    while (this.isRefreshing && Date.now() - startTime < maxWait) {
      await this.sleep(500)
    }

    if (this.isRefreshing) {
      console.warn('[TokenRefresher] Shutdown timeout, force stopping')
    } else {
      console.log('[TokenRefresher] Graceful shutdown completed')
    }
  }

  /**
   * 记录刷新耗时到滑动窗口
   */
  recordRefreshDuration(durationMs) {
    this.refreshDurations.push(durationMs)
    if (this.refreshDurations.length > this.maxDurationsWindow) {
      this.refreshDurations.shift()
    }
  }

  /**
   * 记录最近刷新结果
   */
  recordRecentResult(success) {
    this.recentResults.push({ success, timestamp: Date.now() })
    if (this.recentResults.length > this.maxRecentResults) {
      this.recentResults.shift()
    }
  }

  /**
   * 记录最慢刷新
   */
  recordSlowestRefresh(accountId, email, durationMs) {
    this.slowestRefreshes.push({ accountId, email, durationMs, timestamp: Date.now() })
    // 按耗时降序排序
    this.slowestRefreshes.sort((a, b) => b.durationMs - a.durationMs)
    // 只保留最慢的N个
    if (this.slowestRefreshes.length > this.maxSlowestRefreshes) {
      this.slowestRefreshes.pop()
    }
  }

  /**
   * 计算百分位数
   */
  calculatePercentile(sortedArray, percentile) {
    if (sortedArray.length === 0) return 0
    const index = Math.floor(sortedArray.length * percentile / 100)
    return sortedArray[Math.min(index, sortedArray.length - 1)]
  }

  /**
   * 获取最近失败率
   */
  getRecentFailureRate() {
    if (this.recentResults.length === 0) return 0
    const failures = this.recentResults.filter(r => !r.success).length
    return (failures / this.recentResults.length) * 100
  }

  /**
   * 检查并触发告警
   */
  async checkAndTriggerAlerts() {
    if (!this.systemLogger) return

    // 检查失败率告警
    const failureRate = this.getRecentFailureRate()
    if (failureRate > 20 && this.recentResults.length >= 10) {
      await this.systemLogger.logAlert({
        alertType: AlertType.TOKEN_REFRESH_FAILURE_RATE,
        severity: failureRate > 40 ? AlertSeverity.CRITICAL : AlertSeverity.WARNING,
        message: `Token刷新失败率过高: ${failureRate.toFixed(1)}%`,
        details: {
          recentResultsCount: this.recentResults.length,
          failureCount: this.recentResults.filter(r => !r.success).length
        },
        threshold: 20,
        currentValue: failureRate
      }).catch(() => {})
    }

    // 检查平均延迟告警
    if (this.refreshDurations.length >= 10) {
      const avgDuration = this.refreshDurations.reduce((a, b) => a + b, 0) / this.refreshDurations.length
      if (avgDuration > 5000) {
        await this.systemLogger.logAlert({
          alertType: AlertType.HIGH_LATENCY,
          severity: avgDuration > 10000 ? AlertSeverity.CRITICAL : AlertSeverity.WARNING,
          message: `Token刷新平均延迟过高: ${Math.round(avgDuration)}ms`,
          details: {
            sampleCount: this.refreshDurations.length,
            avgDuration: Math.round(avgDuration)
          },
          threshold: 5000,
          currentValue: avgDuration
        }).catch(() => {})
      }
    }

    // 检查重试队列积压告警
    if (this.retryQueue.size > 50) {
      await this.systemLogger.logAlert({
        alertType: AlertType.QUEUE_BACKLOG,
        severity: this.retryQueue.size > 100 ? AlertSeverity.CRITICAL : AlertSeverity.WARNING,
        message: `Token刷新重试队列积压: ${this.retryQueue.size}个账号`,
        details: {
          queueSize: this.retryQueue.size
        },
        threshold: 50,
        currentValue: this.retryQueue.size
      }).catch(() => {})
    }
  }

  /**
   * 获取性能统计信息
   */
  getStats() {
    const avgDuration = this.stats.totalRefreshes > 0
      ? Math.round(this.stats.totalDurationMs / this.stats.totalRefreshes)
      : 0

    // 计算P50/P95/P99延迟
    const sortedDurations = [...this.refreshDurations].sort((a, b) => a - b)
    const p50 = this.calculatePercentile(sortedDurations, 50)
    const p95 = this.calculatePercentile(sortedDurations, 95)
    const p99 = this.calculatePercentile(sortedDurations, 99)

    // 计算最近1小时的成功率趋势
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    const recentHourResults = this.recentResults.filter(r => r.timestamp > oneHourAgo)
    const recentHourSuccessRate = recentHourResults.length > 0
      ? Math.round((recentHourResults.filter(r => r.success).length / recentHourResults.length) * 100)
      : 100

    return {
      ...this.stats,
      avgDurationMs: avgDuration,
      successRate: this.stats.totalRefreshes > 0
        ? Math.round((this.stats.successfulRefreshes / this.stats.totalRefreshes) * 100)
        : 0,
      retryQueueSize: this.retryQueue.size,
      // 数据库操作统计
      adaptiveBatchSize: this.adaptiveBatchSize,
      maxBatchSize: BATCH_SIZE,
      deadlockRecoveryRate: this.stats.deadlockCount > 0
        ? Math.round((this.stats.deadlockRecovered / this.stats.deadlockCount) * 100)
        : 100,
      // 分布式锁统计
      concurrency: {
        lockSkipped: this.stats.lockSkipped,
        avgLockAcquireTime: this.stats.lockAcquireCount > 0
          ? Math.round(this.stats.lockAcquireTime / this.stats.lockAcquireCount)
          : 0,
        concurrentRefreshAttempts: this.stats.concurrentRefreshAttempts,
        distributedLockStats: getLockStats()
      },
      // 新增：性能指标
      performance: {
        p50DurationMs: p50,
        p95DurationMs: p95,
        p99DurationMs: p99,
        minDurationMs: sortedDurations.length > 0 ? sortedDurations[0] : 0,
        maxDurationMs: sortedDurations.length > 0 ? sortedDurations[sortedDurations.length - 1] : 0,
        sampleCount: this.refreshDurations.length
      },
      // 新增：最近失败率
      recentFailureRate: this.getRecentFailureRate().toFixed(1),
      recentHourSuccessRate,
      // 新增：最慢刷新记录
      slowestRefreshes: this.slowestRefreshes.slice(0, 10),
      // 新增：错误分类统计
      errorBreakdown: { ...this.stats.errorsByType }
    }
  }

  /**
   * 重置性能统计
   */
  resetStats() {
    this.stats = {
      totalRefreshes: 0,
      successfulRefreshes: 0,
      failedRefreshes: 0,
      totalDurationMs: 0,
      errorsByType: {},
      databaseRetries: 0,
      deadlockCount: 0,
      deadlockRecovered: 0,
      dbOperationErrors: 0,
      // 分布式锁统计
      lockSkipped: 0,
      lockAcquireTime: 0,
      lockAcquireCount: 0,
      concurrentRefreshAttempts: 0
    }
    this.adaptiveBatchSize = BATCH_SIZE
    this.deadlockWindow = []
    this.refreshDurations = []
    this.recentResults = []
    this.slowestRefreshes = []
    console.log('[TokenRefresher] Stats reset')
  }
}

export { RefreshErrorType }
export default TokenRefresher
