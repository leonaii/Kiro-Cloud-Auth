/**
 * 账号池管理器
 * 从数据库获取可用账号，支持轮询负载均衡
 *
 * 增强功能：
 * - 内存缓存机制：减少数据库查询
 * - 降级处理：数据库连接失败时使用缓存
 * - 连接恢复检测：定期检测数据库连接状态
 * - 查询结果验证：确保返回数据完整性
 * - 数据修复机制：尝试修复不完整的数据
 * - 健康监控：提供账号池健康状态
 * - 分布式轮询索引：使用数据库原子操作实现跨进程/服务器的负载均衡
 * - 性能监控：记录查询耗时和缓存命中率
 * - 告警机制：账号池状态异常时触发告警
 */

import { rowToAccount } from '../models/account.js'
import { AlertType, AlertSeverity } from './system-logger.js'

// 缓存配置
const CACHE_EXPIRY_MS = 60000 // 缓存有效期 60 秒
const DB_CHECK_INTERVAL_MS = 30000 // 数据库连接检测间隔 30 秒
const HEALTH_MONITOR_INTERVAL_MS = 5 * 60 * 1000 // 健康监控间隔 5 分钟

// 告警阈值配置（可通过环境变量覆盖）
const ALERT_THRESHOLDS = {
  minAvailableAccounts: parseInt(process.env.ALERT_MIN_AVAILABLE_ACCOUNTS) || 2,
  warningAvailableAccounts: parseInt(process.env.ALERT_WARNING_AVAILABLE_ACCOUNTS) || 5,
  maxErrorAccountRate: parseFloat(process.env.ALERT_MAX_ERROR_ACCOUNT_RATE) || 0.3,
  maxDbConnectionFailures: parseInt(process.env.ALERT_MAX_DB_CONNECTION_FAILURES) || 3
}

// 数据验证配置
const VALIDATION_CONFIG = {
  // 必需字段
  REQUIRED_FIELDS: ['id', 'email', 'cred_access_token'],
  // 数值字段范围
  NUMERIC_RANGES: {
    usage_percent_used: { min: 0, max: 100 },
    usage_current: { min: 0 },
    usage_limit: { min: 0 }
  },
  // 过期时间合理范围（当前时间 - 1天 到 当前时间 + 1年）
  EXPIRES_AT_RANGE: {
    minOffset: -24 * 60 * 60 * 1000,  // 允许过期1天内的token（可能正在刷新）
    maxOffset: 365 * 24 * 60 * 60 * 1000  // 最多1年后过期
  }
}

class AccountPool {
  constructor(pool, systemLogger = null) {
    this.dbPool = pool
    this.systemLogger = systemLogger

    // 账号缓存：key: groupId|'__all__', value: { accounts: [], timestamp: number }
    this.accountsCache = new Map()
    this.cacheExpiry = CACHE_EXPIRY_MS

    // 数据库连接状态
    this.dbConnectionFailed = false
    this.lastDbCheckTime = 0
    this.dbCheckInterval = DB_CHECK_INTERVAL_MS

    // 统计信息
    this.stats = {
      cacheHits: 0,
      cacheMisses: 0,
      dbErrors: 0,
      staleCacheUsed: 0,
      // 数据验证统计
      validationErrors: 0,
      dataRepairs: 0,
      incompleteAccounts: 0,
      // 健康监控统计
      lastHealthCheck: null,
      healthScore: 100,
      // 并发控制统计
      roundRobinLockWaitTime: 0,
      roundRobinLockWaitCount: 0,
      indexResetCount: 0,
      // 性能监控统计
      queryDurations: [],
      dbConnectionFailureCount: 0,
      lastDbConnectionFailure: null
    }

    // 健康监控定时器
    this.healthMonitorInterval = null

    // 查询耗时滑动窗口
    this.maxQueryDurations = 100
  }

  /**
   * 启动健康监控定时任务
   */
  startHealthMonitor() {
    if (this.healthMonitorInterval) {
      return
    }

    this.healthMonitorInterval = setInterval(async () => {
      await this.monitorPoolHealth()
    }, HEALTH_MONITOR_INTERVAL_MS)

    console.log('[AccountPool] Health monitor started')
  }

  /**
   * 停止健康监控定时任务
   */
  stopHealthMonitor() {
    if (this.healthMonitorInterval) {
      clearInterval(this.healthMonitorInterval)
      this.healthMonitorInterval = null
      console.log('[AccountPool] Health monitor stopped')
    }
  }

  /**
   * 监控账号池健康状态并触发告警
   */
  async monitorPoolHealth() {
    try {
      const health = await this.getPoolHealth()

      // 检查可用账号数量
      if (health.accounts.active < ALERT_THRESHOLDS.minAvailableAccounts) {
        await this.triggerAlert({
          alertType: AlertType.POOL_EXHAUSTED,
          severity: AlertSeverity.CRITICAL,
          message: `可用账号数量严重不足: ${health.accounts.active}个`,
          details: {
            availableAccounts: health.accounts.active,
            totalAccounts: health.accounts.total,
            errorAccounts: health.accounts.error
          },
          threshold: ALERT_THRESHOLDS.minAvailableAccounts,
          currentValue: health.accounts.active
        })
      } else if (health.accounts.active < ALERT_THRESHOLDS.warningAvailableAccounts) {
        await this.triggerAlert({
          alertType: AlertType.POOL_EXHAUSTED,
          severity: AlertSeverity.WARNING,
          message: `可用账号数量较低: ${health.accounts.active}个`,
          details: {
            availableAccounts: health.accounts.active,
            totalAccounts: health.accounts.total
          },
          threshold: ALERT_THRESHOLDS.warningAvailableAccounts,
          currentValue: health.accounts.active
        })
      }

      // 检查错误账号比例
      if (health.accounts.total > 0) {
        const errorRate = health.accounts.error / health.accounts.total
        if (errorRate > ALERT_THRESHOLDS.maxErrorAccountRate) {
          await this.triggerAlert({
            alertType: AlertType.HIGH_ERROR_RATE,
            severity: errorRate > 0.5 ? AlertSeverity.CRITICAL : AlertSeverity.WARNING,
            message: `错误账号比例过高: ${(errorRate * 100).toFixed(1)}%`,
            details: {
              errorAccounts: health.accounts.error,
              totalAccounts: health.accounts.total,
              errorRate: (errorRate * 100).toFixed(1)
            },
            threshold: ALERT_THRESHOLDS.maxErrorAccountRate * 100,
            currentValue: errorRate * 100
          })
        }
      }

      // 检查数据库连接失败次数
      if (this.stats.dbConnectionFailureCount >= ALERT_THRESHOLDS.maxDbConnectionFailures) {
        await this.triggerAlert({
          alertType: AlertType.DATABASE_CONNECTION_FAILURE,
          severity: AlertSeverity.CRITICAL,
          message: `数据库连接频繁失败: ${this.stats.dbConnectionFailureCount}次`,
          details: {
            failureCount: this.stats.dbConnectionFailureCount,
            lastFailure: this.stats.lastDbConnectionFailure
          },
          threshold: ALERT_THRESHOLDS.maxDbConnectionFailures,
          currentValue: this.stats.dbConnectionFailureCount
        })
        // 重置计数器
        this.stats.dbConnectionFailureCount = 0
      }

      // 记录健康检查日志
      if (this.systemLogger) {
        await this.systemLogger.logPerformance({
          operation: 'account_pool_health_check',
          durationMs: 0,
          success: health.healthy,
          details: {
            healthScore: health.score,
            availableAccounts: health.accounts.active,
            errorAccounts: health.accounts.error,
            cacheHitRate: health.cache.hitRate
          }
        }).catch(() => {})
      }
    } catch (error) {
      console.error('[AccountPool] Health monitor error:', error.message)
    }
  }

  /**
   * 触发告警
   */
  async triggerAlert({ alertType, severity, message, details, threshold, currentValue }) {
    if (!this.systemLogger) {
      console.warn(`[AccountPool] Alert: ${message}`)
      return
    }

    await this.systemLogger.logAlert({
      alertType,
      severity,
      message,
      details,
      threshold,
      currentValue
    }).catch((error) => {
      console.error('[AccountPool] Failed to log alert:', error.message)
    })
  }

  /**
   * 记录查询耗时
   */
  recordQueryDuration(durationMs, operation, success) {
    this.stats.queryDurations.push({
      durationMs,
      operation,
      success,
      timestamp: Date.now()
    })

    // 保持滑动窗口大小
    if (this.stats.queryDurations.length > this.maxQueryDurations) {
      this.stats.queryDurations.shift()
    }

    // 记录性能日志
    if (this.systemLogger) {
      this.systemLogger.logPerformance({
        operation: `account_pool_${operation}`,
        durationMs,
        success,
        details: { operation }
      }).catch(() => {})
    }
  }

  /**
   * 检查缓存是否有效
   * @param {string} cacheKey - 缓存键
   * @returns {boolean}
   */
  isCacheValid(cacheKey) {
    const cached = this.accountsCache.get(cacheKey)
    if (!cached) return false

    const now = Date.now()
    return (now - cached.timestamp) < this.cacheExpiry
  }

  /**
   * 从缓存获取账号
   * @param {string} cacheKey - 缓存键
   * @param {boolean} allowStale - 是否允许使用过期缓存
   * @returns {Array|null}
   */
  getFromCache(cacheKey, allowStale = false) {
    const cached = this.accountsCache.get(cacheKey)
    if (!cached) return null

    const now = Date.now()
    const isValid = (now - cached.timestamp) < this.cacheExpiry

    if (isValid) {
      this.stats.cacheHits++
      return cached.accounts
    }

    if (allowStale) {
      this.stats.staleCacheUsed++
      console.warn(`[AccountPool] Using stale cache for ${cacheKey} (age: ${Math.round((now - cached.timestamp) / 1000)}s)`)
      return cached.accounts
    }

    return null
  }

  /**
   * 更新缓存
   * @param {string} cacheKey - 缓存键
   * @param {Array} accounts - 账号列表
   */
  updateCache(cacheKey, accounts) {
    this.accountsCache.set(cacheKey, {
      accounts: accounts,
      timestamp: Date.now()
    })
  }

  /**
   * 检测数据库连接状态
   * @returns {Promise<boolean>} 连接是否正常
   */
  async checkDatabaseConnection() {
    const now = Date.now()

    // 限制检测频率
    if (now - this.lastDbCheckTime < this.dbCheckInterval) {
      return !this.dbConnectionFailed
    }

    this.lastDbCheckTime = now

    try {
      // 执行简单查询测试连接
      await this.dbPool.query('SELECT 1')

      if (this.dbConnectionFailed) {
        console.log('[AccountPool] Database connection restored')
        if (this.systemLogger) {
          await this.systemLogger.logAccountPool({
            action: 'db_connection_restored',
            message: '数据库连接已恢复',
            level: 'info'
          }).catch(() => {})
        }
      }

      this.dbConnectionFailed = false
      return true
    } catch (error) {
      console.error('[AccountPool] Database connection check failed:', error.message)
      this.dbConnectionFailed = true
      return false
    }
  }

  /**
   * 验证账号数据完整性（增强版）
   * @param {object} row - 数据库行
   * @returns {{valid: boolean, errors: string[], warnings: string[]}}
   */
  validateAccountRow(row) {
    const errors = []
    const warnings = []

    // 1. 必需字段检查
    for (const field of VALIDATION_CONFIG.REQUIRED_FIELDS) {
      if (!row[field]) {
        errors.push(`缺少必需字段: ${field}`)
      }
    }

    // 2. 数据类型验证
    if (row.cred_expires_at !== null && row.cred_expires_at !== undefined) {
      if (typeof row.cred_expires_at !== 'number' || !Number.isFinite(row.cred_expires_at)) {
        warnings.push(`expiresAt 类型无效: ${typeof row.cred_expires_at}`)
      } else {
        // 检查过期时间范围
        const now = Date.now()
        const { minOffset, maxOffset } = VALIDATION_CONFIG.EXPIRES_AT_RANGE
        if (row.cred_expires_at < now + minOffset) {
          warnings.push(`token 已过期超过1天: ${new Date(row.cred_expires_at).toISOString()}`)
        } else if (row.cred_expires_at > now + maxOffset) {
          warnings.push(`expiresAt 超出合理范围: ${new Date(row.cred_expires_at).toISOString()}`)
        }
      }
    }

    // 3. 数值范围验证
    for (const [field, range] of Object.entries(VALIDATION_CONFIG.NUMERIC_RANGES)) {
      const value = row[field]
      if (value !== null && value !== undefined) {
        const numValue = parseFloat(value)
        if (isNaN(numValue)) {
          warnings.push(`${field} 不是有效数字: ${value}`)
        } else {
          if (range.min !== undefined && numValue < range.min) {
            warnings.push(`${field} 低于最小值 ${range.min}: ${numValue}`)
          }
          if (range.max !== undefined && numValue > range.max) {
            warnings.push(`${field} 超过最大值 ${range.max}: ${numValue}`)
          }
        }
      }
    }

    // 4. 关联数据验证（如果有 groupId，检查格式）
    if (row.group_id && typeof row.group_id !== 'string') {
      warnings.push(`groupId 类型无效: ${typeof row.group_id}`)
    }

    // 5. 状态字段验证
    const validStatuses = ['active', 'error', 'banned', 'expired']
    if (row.status && !validStatuses.includes(row.status)) {
      warnings.push(`未知状态: ${row.status}`)
    }

    // 记录统计
    if (errors.length > 0) {
      this.stats.validationErrors++
    }
    if (warnings.length > 0) {
      this.stats.incompleteAccounts++
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings
    }
  }

  /**
   * 尝试修复不完整的账号数据
   * @param {object} row - 数据库行
   * @returns {{repaired: boolean, row: object, repairs: string[]}}
   */
  repairAccountData(row) {
    const repairs = []
    const repairedRow = { ...row }

    // 1. 修复 usage 字段的默认值
    if (repairedRow.usage_current === null || repairedRow.usage_current === undefined) {
      repairedRow.usage_current = 0
      repairs.push('usage_current 设为默认值 0')
    }

    if (repairedRow.usage_limit === null || repairedRow.usage_limit === undefined) {
      repairedRow.usage_limit = 0
      repairs.push('usage_limit 设为默认值 0')
    }

    if (repairedRow.usage_percent_used === null || repairedRow.usage_percent_used === undefined) {
      // 计算使用百分比
      if (repairedRow.usage_limit > 0) {
        repairedRow.usage_percent_used = (repairedRow.usage_current / repairedRow.usage_limit) * 100
        repairs.push('usage_percent_used 已计算')
      } else {
        repairedRow.usage_percent_used = 0
        repairs.push('usage_percent_used 设为默认值 0')
      }
    }

    // 2. 修复 region 默认值
    if (!repairedRow.cred_region) {
      repairedRow.cred_region = 'us-east-1'
      repairs.push('cred_region 设为默认值 us-east-1')
    }

    // 3. 修复 API 统计字段
    if (repairedRow.api_call_count === null || repairedRow.api_call_count === undefined) {
      repairedRow.api_call_count = 0
      repairs.push('api_call_count 设为默认值 0')
    }

    if (repairedRow.api_total_tokens === null || repairedRow.api_total_tokens === undefined) {
      repairedRow.api_total_tokens = 0
      repairs.push('api_total_tokens 设为默认值 0')
    }

    // 4. 修复 usage_percent_used 范围
    const percentUsed = parseFloat(repairedRow.usage_percent_used)
    if (!isNaN(percentUsed)) {
      if (percentUsed < 0) {
        repairedRow.usage_percent_used = 0
        repairs.push('usage_percent_used 修正为 0（原值为负）')
      } else if (percentUsed > 100) {
        repairedRow.usage_percent_used = 100
        repairs.push('usage_percent_used 修正为 100（原值超过100）')
      }
    }

    if (repairs.length > 0) {
      this.stats.dataRepairs++
    }

    return {
      repaired: repairs.length > 0,
      row: repairedRow,
      repairs
    }
  }

  /**
   * 验证查询结果完整性
   * @param {Array} rows - 查询结果行
   * @param {string[]} expectedFields - 期望的字段列表
   * @returns {{valid: boolean, report: object}}
   */
  validateQueryResult(rows, expectedFields = []) {
    const report = {
      totalRows: rows?.length || 0,
      validRows: 0,
      invalidRows: 0,
      missingFields: {},
      nullFields: {},
      warnings: []
    }

    if (!rows || !Array.isArray(rows)) {
      report.warnings.push('查询结果不是数组')
      return { valid: false, report }
    }

    if (rows.length === 0) {
      return { valid: true, report }
    }

    // 检查第一行的字段
    const firstRow = rows[0]
    for (const field of expectedFields) {
      if (!(field in firstRow)) {
        report.missingFields[field] = rows.length
      }
    }

    // 统计每行的数据质量
    for (const row of rows) {
      const validation = this.validateAccountRow(row)
      if (validation.valid) {
        report.validRows++
      } else {
        report.invalidRows++
      }

      // 统计 NULL 值
      for (const [key, value] of Object.entries(row)) {
        if (value === null) {
          report.nullFields[key] = (report.nullFields[key] || 0) + 1
        }
      }
    }

    // 计算数据完整性得分
    const integrityScore = rows.length > 0
      ? Math.round((report.validRows / rows.length) * 100)
      : 100
    report.integrityScore = integrityScore

    return {
      valid: report.invalidRows === 0,
      report
    }
  }

  /**
   * 获取所有可用账号（直接从数据库获取）
   * 排除已删除的账号（is_del = TRUE）
   * @param {string|null} groupId - 分组 ID，如果为 null 则获取所有账号
   */
  async getAvailableAccounts(groupId = null) {
    const cacheKey = groupId || '__all__'
    const startTime = Date.now()
    let cacheHit = false

    // 如果数据库连接正常，先检查缓存
    if (!this.dbConnectionFailed && this.isCacheValid(cacheKey)) {
      const cached = this.getFromCache(cacheKey)
      if (cached) {
        cacheHit = true
        this.recordQueryDuration(Date.now() - startTime, 'get_available_accounts', true)
        return cached
      }
    }

    try {
      let query = `
        SELECT id, email, user_id, nickname, idp, status, group_id,
               cred_access_token, cred_refresh_token, cred_client_id,
               cred_client_secret, cred_region, cred_expires_at,
               cred_auth_method, cred_provider,
               usage_current, usage_limit, usage_percent_used,
               api_call_count, api_last_call_at, api_total_tokens, last_error,
               header_version, amz_invocation_id, kiro_device_hash,
               sdk_js_version, ide_version
        FROM accounts
        WHERE status = 'active'
          AND cred_access_token IS NOT NULL
          AND cred_access_token != ''
          AND (is_del = FALSE OR is_del IS NULL)
          AND (COALESCE(usage_limit, 0) - COALESCE(usage_current, 0)) > 5
      `

      const params = []

      // 如果指定了分组 ID，只获取该分组内的账号
      if (groupId) {
        query += ' AND group_id = ?'
        params.push(groupId)
      }

      // 按 ID 排序，确保账号顺序稳定，配合轮询索引实现均匀分配
      query += ' ORDER BY id ASC'

      const [rows] = await this.dbPool.query(query, params)

      // 验证返回结果
      if (!rows || !Array.isArray(rows)) {
        console.error('[AccountPool] Invalid query result: rows is not an array')
        throw new Error('Invalid database response')
      }

      // 验证查询结果完整性
      const queryValidation = this.validateQueryResult(rows, [
        'id', 'email', 'cred_access_token', 'status'
      ])

      if (!queryValidation.valid) {
        console.warn('[AccountPool] Query result validation warnings:', queryValidation.report)
      }

      // 过滤并转换账号数据（带修复）
      const accounts = []
      let filteredCount = 0
      let repairedCount = 0

      for (const row of rows) {
        const validation = this.validateAccountRow(row)

        if (validation.valid) {
          // 尝试修复数据
          const repairResult = this.repairAccountData(row)
          if (repairResult.repaired) {
            repairedCount++
            if (repairResult.repairs.length > 0) {
              console.log(`[AccountPool] Repaired account ${row.email}:`, repairResult.repairs.join(', '))
            }
          }
          accounts.push(rowToAccount(repairResult.row))
        } else {
          filteredCount++
          console.warn(`[AccountPool] Filtered account ${row.id || 'unknown'}:`, validation.errors.join(', '))
        }

        // 记录警告（即使账号有效）
        if (validation.warnings.length > 0) {
          console.log(`[AccountPool] Account ${row.email} warnings:`, validation.warnings.join(', '))
        }
      }

      if (filteredCount > 0) {
        console.warn(`[AccountPool] Filtered ${filteredCount} incomplete accounts, repaired ${repairedCount}`)
      }

      // 更新缓存
      this.updateCache(cacheKey, accounts)
      this.stats.cacheMisses++

      // 重置数据库连接失败标志
      if (this.dbConnectionFailed) {
        console.log('[AccountPool] Database connection restored')
        this.dbConnectionFailed = false
        this.stats.dbConnectionFailureCount = 0
      }

      // 记录查询耗时
      this.recordQueryDuration(Date.now() - startTime, 'get_available_accounts', true)

      // 检查可用账号数量并触发告警
      if (accounts.length < ALERT_THRESHOLDS.minAvailableAccounts) {
        await this.triggerAlert({
          alertType: AlertType.POOL_EXHAUSTED,
          severity: accounts.length === 0 ? AlertSeverity.CRITICAL : AlertSeverity.WARNING,
          message: `可用账号数量不足: ${accounts.length}个 (分组: ${groupId || '全部'})`,
          details: {
            availableAccounts: accounts.length,
            groupId: groupId || 'all',
            cacheHit
          },
          threshold: ALERT_THRESHOLDS.minAvailableAccounts,
          currentValue: accounts.length
        })
      }

      return accounts
    } catch (error) {
      this.stats.dbErrors++
      this.stats.dbConnectionFailureCount++
      this.stats.lastDbConnectionFailure = Date.now()
      console.error('[AccountPool] Failed to load accounts:', error.message)

      // 标记数据库连接失败
      this.dbConnectionFailed = true

      // 记录查询耗时（失败）
      this.recordQueryDuration(Date.now() - startTime, 'get_available_accounts', false)

      // 记录错误日志
      if (this.systemLogger) {
        await this.systemLogger.logAccountPool({
          action: 'db_connection_failed',
          message: `数据库查询失败: ${error.message}`,
          details: { error: error.message, code: error.code, groupId },
          level: 'error'
        }).catch(() => {})
      }

      // 尝试使用过期缓存（降级处理）
      const staleCache = this.getFromCache(cacheKey, true)
      if (staleCache && staleCache.length > 0) {
        console.warn(`[AccountPool] Using stale cache due to DB failure (${staleCache.length} accounts)`)
        return staleCache
      }

      // 缓存也没有，返回空数组
      console.error('[AccountPool] No cache available, returning empty array')
      return []
    }
  }

  /**
   * 获取并更新轮询索引（数据库原子操作）- 带账号数量变化检测
   * 使用 SELECT ... FOR UPDATE 实现分布式环境下的原子操作
   *
   * @param {string} groupId - 分组 ID
   * @param {number} accountCount - 当前有效账号数量
   * @returns {Promise<{currentIdx: number, accountCountChanged: boolean}>} 当前应该使用的索引和账号数量是否变化
   */
  async getAndUpdateRoundRobinIndexWithCheck(groupId, accountCount) {
    const indexKey = groupId || '__global__'
    const startTime = Date.now()
    let connection = null
    let accountCountChanged = false

    try {
      // 获取独立连接用于事务
      connection = await this.dbPool.getConnection()
      await connection.beginTransaction()

      // 使用 FOR UPDATE 锁定行，确保原子操作
      const [rows] = await connection.query(
        'SELECT current_index, account_count FROM pool_round_robin WHERE group_id = ? FOR UPDATE',
        [indexKey]
      )

      let currentIndex = 0

      if (rows.length === 0) {
        // 首次使用该分组，插入初始记录
        await connection.query(
          'INSERT INTO pool_round_robin (group_id, current_index, account_count, updated_at) VALUES (?, 0, ?, ?)',
          [indexKey, accountCount, Date.now()]
        )
        currentIndex = 0
      } else {
        currentIndex = rows[0].current_index
        const storedAccountCount = rows[0].account_count

        // 检查账号数量是否变化
        if (storedAccountCount !== accountCount) {
          console.log(`[AccountPool] Account count changed for group ${indexKey}: ${storedAccountCount} -> ${accountCount}`)
          accountCountChanged = true
          // 不重置索引，让调用者决定是否重试
          // 但仍然更新 account_count
        }

        // 确保索引在有效范围内
        if (currentIndex >= accountCount) {
          currentIndex = 0
        }
      }

      // 计算下一个索引
      const nextIndex = (currentIndex + 1) % accountCount

      // 更新索引和账号数量
      if (rows.length > 0) {
        await connection.query(
          'UPDATE pool_round_robin SET current_index = ?, account_count = ?, updated_at = ? WHERE group_id = ?',
          [nextIndex, accountCount, Date.now(), indexKey]
        )
      }

      await connection.commit()

      // 记录锁等待时间
      const waitTime = Date.now() - startTime
      this.stats.roundRobinLockWaitTime += waitTime
      this.stats.roundRobinLockWaitCount++

      if (waitTime > 100) {
        console.warn(`[AccountPool] Round-robin lock wait time: ${waitTime}ms for group ${indexKey}`)
      }

      return { currentIdx: currentIndex, accountCountChanged }
    } catch (error) {
      if (connection) {
        await connection.rollback().catch(() => {})
      }
      console.error(`[AccountPool] Failed to get/update round-robin index for ${indexKey}:`, error.message)

      // 降级：返回随机索引
      console.warn(`[AccountPool] Falling back to random index for group ${indexKey}`)
      return { currentIdx: Math.floor(Math.random() * accountCount), accountCountChanged: false }
    } finally {
      if (connection) {
        connection.release()
      }
    }
  }

  /**
   * 获取并更新轮询索引（数据库原子操作）
   * 使用 SELECT ... FOR UPDATE 实现分布式环境下的原子操作
   *
   * @param {string} groupId - 分组 ID
   * @param {number} accountCount - 当前有效账号数量
   * @returns {Promise<number>} 当前应该使用的索引
   * @deprecated 使用 getAndUpdateRoundRobinIndexWithCheck 代替
   */
  async getAndUpdateRoundRobinIndex(groupId, accountCount) {
    const result = await this.getAndUpdateRoundRobinIndexWithCheck(groupId, accountCount)
    return result.currentIdx
  }

  /**
   * 获取下一个可用账号（分布式轮询负载均衡）
   *
   * 轮询策略：使用数据库原子操作确保跨进程/服务器的均匀分配
   * - 按账号 ID 顺序依次选择，确保所有账号均匀使用
   * - 新加入的账号会按 ID 顺序插入到轮询队列中
   * - 每个分组维护独立的轮询索引（存储在数据库中）
   *
   * @param {string|null} groupId - 分组 ID，如果为 null 则从所有账号中选择
   */
  async getNextAccount(groupId = null) {
    const startTime = Date.now()
    const cacheKey = groupId || '__all__'
    let accounts
    let retryCount = 0
    const maxRetries = 1

    while (retryCount <= maxRetries) {
      try {
        accounts = await this.getAvailableAccounts(groupId)
      } catch (error) {
        console.error('[AccountPool] getNextAccount failed to get accounts:', error.message)
        this.recordQueryDuration(Date.now() - startTime, 'get_next_account', false)
        throw new Error('Account pool temporarily unavailable, please try again later')
      }

      if (accounts.length === 0) {
        const groupInfo = groupId ? ` in group ${groupId}` : ''
        this.recordQueryDuration(Date.now() - startTime, 'get_next_account', false)
        throw new Error(`No available accounts${groupInfo} in pool`)
      }

      const now = Date.now()
      const validAccounts = accounts.filter((acc) => {
        if (!acc.credentials.expiresAt) return true
        // 预留 15 分钟缓冲，避免临界过期（与 Token 刷新器的 10-30 分钟窗口匹配）
        return acc.credentials.expiresAt > now + 15 * 60 * 1000
      })

      if (validAccounts.length === 0) {
        throw new Error('All accounts have expired tokens')
      }

      // 使用数据库原子操作获取轮询索引，同时检测账号数量是否变化
      const { currentIdx, accountCountChanged } = await this.getAndUpdateRoundRobinIndexWithCheck(groupId, validAccounts.length)

      // 如果账号数量变化，清除缓存并重试一次
      if (accountCountChanged && retryCount < maxRetries) {
        console.log(`[AccountPool] Account count changed, invalidating cache and retrying...`)
        this.accountsCache.delete(cacheKey)
        retryCount++
        continue
      }

      // 选择当前索引的账号
      const account = validAccounts[currentIdx]

      // 更新最后调用时间（用于统计，不阻塞）
      account.apiLastCallAt = now

      // 日志记录轮询状态（调试用）
      console.log(`[AccountPool] Round-robin: selected account ${account.email} (index: ${currentIdx}/${validAccounts.length}, group: ${groupId || 'all'})`)

      // 记录查询耗时
      this.recordQueryDuration(Date.now() - startTime, 'get_next_account', true)

      return account
    }

    // 不应该到达这里
    throw new Error('Unexpected error in getNextAccount')
  }

  /**
   * 获取使用率最低的账号
   * @param {string|null} groupId - 分组 ID，如果为 null 则从所有账号中选择
   */
  async getLeastUsedAccount(groupId = null) {
    let accounts
    try {
      accounts = await this.getAvailableAccounts(groupId)
    } catch (error) {
      console.error('[AccountPool] getLeastUsedAccount failed to get accounts:', error.message)
      throw new Error('Account pool temporarily unavailable, please try again later')
    }

    if (accounts.length === 0) {
      const groupInfo = groupId ? ` in group ${groupId}` : ''
      throw new Error(`No available accounts${groupInfo} in pool`)
    }

    const now = Date.now()
    const validAccounts = accounts.filter((acc) => {
      if (!acc.credentials.expiresAt) return true
      // 预留 15 分钟缓冲，避免临界过期（与 getNextAccount 保持一致）
      return acc.credentials.expiresAt > now + 15 * 60 * 1000
    })

    if (validAccounts.length === 0) {
      throw new Error('All accounts have expired tokens')
    }

    return validAccounts.sort((a, b) => a.usage.percentUsed - b.usage.percentUsed)[0]
  }

  /**
   * 根据 ID 获取指定账号
   * 排除已删除的账号（is_del = TRUE）
   */
  async getAccountById(accountId) {
    try {
      const [rows] = await this.dbPool.query(
        `
        SELECT id, email, user_id, nickname, idp, status,
               cred_access_token, cred_refresh_token, cred_client_id,
               cred_client_secret, cred_region, cred_expires_at,
               cred_auth_method, cred_provider,
               usage_current, usage_limit, usage_percent_used,
               header_version, amz_invocation_id, kiro_device_hash,
               sdk_js_version, ide_version
        FROM accounts
        WHERE id = ?
          AND cred_access_token IS NOT NULL
          AND cred_access_token != ''
          AND (is_del = FALSE OR is_del IS NULL)
        LIMIT 1
      `,
        [accountId]
      )

      if (rows.length === 0) return null

      const row = rows[0]

      // 验证数据完整性
      if (!this.validateAccountRow(row)) {
        console.warn(`[AccountPool] Account ${accountId} has incomplete data`)
        return null
      }

      // 如果账号状态为 error，返回 null（除非是指定账号测试）
      if (row.status === 'error') {
        console.log(`[AccountPool] Account ${row.email} is in error state, skipping`)
        return null
      }

      // 重置数据库连接失败标志
      if (this.dbConnectionFailed) {
        this.dbConnectionFailed = false
      }

      return {
        id: row.id,
        email: row.email,
        userId: row.user_id,
        nickname: row.nickname,
        idp: row.idp,
        status: row.status,
        headerVersion: row.header_version || 1,
        amzInvocationId: row.amz_invocation_id,
        kiroDeviceHash: row.kiro_device_hash,
        sdkJsVersion: row.sdk_js_version,
        ideVersion: row.ide_version,
        credentials: {
          accessToken: row.cred_access_token,
          refreshToken: row.cred_refresh_token,
          clientId: row.cred_client_id,
          clientSecret: row.cred_client_secret,
          region: row.cred_region || 'us-east-1',
          expiresAt: row.cred_expires_at,
          authMethod: row.cred_auth_method,
          provider: row.cred_provider
        },
        usage: {
          current: row.usage_current || 0,
          limit: row.usage_limit || 0,
          percentUsed: parseFloat(row.usage_percent_used) || 0
        }
      }
    } catch (error) {
      console.error(`[AccountPool] Failed to get account ${accountId}:`, error.message)
      this.stats.dbErrors++
      return null
    }
  }

  /**
   * 标记账号出错
   */
  async markAccountError(accountId) {
    try {
      await this.dbPool.query("UPDATE accounts SET status = 'error' WHERE id = ?", [accountId])
      console.log(`[AccountPool] Marked account ${accountId} as error`)

      // 清除相关缓存
      this.invalidateCache()

      if (this.systemLogger) {
        await this.systemLogger.logAccountPool({
          action: 'mark_account_error',
          message: `账号 ${accountId} 标记为错误`,
          details: { accountId },
          level: 'warn'
        })
      }
    } catch (error) {
      console.error(`[AccountPool] Failed to mark account ${accountId} as error:`, error.message)
      this.stats.dbErrors++
    }
  }

  /**
   * 更新账号的 token
   */
  async updateAccountToken(accountId, accessToken, refreshToken, expiresAt) {
    try {
      await this.dbPool.query(
        'UPDATE accounts SET cred_access_token = ?, cred_refresh_token = ?, cred_expires_at = ? WHERE id = ?',
        [accessToken, refreshToken, expiresAt, accountId]
      )
      console.log(`[AccountPool] Updated token for account ${accountId}`)

      // 清除相关缓存
      this.invalidateCache()
    } catch (error) {
      console.error(`[AccountPool] Failed to update token for ${accountId}:`, error.message)
      this.stats.dbErrors++
    }
  }

  /**
   * 记录 API 调用（异步批量更新，不阻塞请求）
   */
  async incrementApiCall(accountId, tokens = 0) {
    const now = Date.now()

    // 异步更新数据库（不等待）
    this.dbPool
      .query(
        'UPDATE accounts SET api_call_count = api_call_count + 1, api_last_call_at = ?, api_total_tokens = api_total_tokens + ? WHERE id = ?',
        [now, tokens, accountId]
      )
      .catch((error) => {
        console.error(`[AccountPool] Failed to increment API call for ${accountId}:`, error.message)
        this.stats.dbErrors++
      })
  }

  /**
   * 清除所有缓存
   */
  invalidateCache() {
    this.accountsCache.clear()
    console.log('[AccountPool] Cache invalidated')
  }

  /**
   * 获取池状态
   * @param {string|null} groupId - 分组 ID，如果为 null 则获取所有账号的状态
   */
  async getPoolStatus(groupId = null) {
    const accounts = await this.getAvailableAccounts(groupId)
    const now = Date.now()

    // 从数据库获取当前轮询索引
    const indexKey = groupId || '__global__'
    let currentIndex = 0
    try {
      const [rows] = await this.dbPool.query(
        'SELECT current_index FROM pool_round_robin WHERE group_id = ?',
        [indexKey]
      )
      if (rows.length > 0) {
        currentIndex = rows[0].current_index
      }
    } catch (error) {
      console.warn(`[AccountPool] Failed to get round-robin index for status: ${error.message}`)
    }

    return {
      total: accounts.length,
      groupId: groupId || null,
      // 数据库连接状态
      dbStatus: {
        connected: !this.dbConnectionFailed,
        lastCheckTime: this.lastDbCheckTime
      },
      // 缓存状态
      cacheStatus: {
        size: this.accountsCache.size,
        stats: { ...this.stats }
      },
      // 轮询状态信息
      roundRobin: {
        currentIndex,
        nextAccount: accounts[currentIndex]?.email || null,
        // 并发控制统计
        avgLockWaitTime: this.stats.roundRobinLockWaitCount > 0
          ? Math.round(this.stats.roundRobinLockWaitTime / this.stats.roundRobinLockWaitCount)
          : 0,
        indexResetCount: this.stats.indexResetCount
      },
      valid: accounts.filter(
        (acc) => !acc.credentials.expiresAt || acc.credentials.expiresAt > now
      ).length,
      expired: accounts.filter(
        (acc) => acc.credentials.expiresAt && acc.credentials.expiresAt <= now
      ).length,
      accounts: accounts.map((acc, idx) => ({
        id: acc.id,
        email: acc.email,
        groupId: acc.groupId,
        // 标记当前轮询位置
        isNextInQueue: idx === currentIndex,
        usagePercent: acc.usage.percentUsed,
        expiresAt: acc.credentials.expiresAt,
        isValid: !acc.credentials.expiresAt || acc.credentials.expiresAt > now,
        apiCallCount: acc.apiCallCount || 0,
        apiLastCallAt: acc.apiLastCallAt,
        apiTotalTokens: acc.apiTotalTokens || 0
      }))
    }
  }

  /**
   * 获取账号池健康状态
   * @returns {Promise<object>} 健康状态报告
   */
  async getPoolHealth() {
    const now = Date.now()

    try {
      // 1. 检查数据库连接
      const dbHealthy = await this.checkDatabaseConnection()

      // 2. 获取账号统计
      let accountStats = {
        total: 0,
        active: 0,
        error: 0,
        expired: 0,
        lowUsage: 0
      }

      if (dbHealthy) {
        try {
          const [countRows] = await this.dbPool.query(`
            SELECT
              COUNT(*) as total,
              SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
              SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error,
              SUM(CASE WHEN cred_expires_at < ? THEN 1 ELSE 0 END) as expired,
              SUM(CASE WHEN (COALESCE(usage_limit, 0) - COALESCE(usage_current, 0)) <= 5 THEN 1 ELSE 0 END) as low_usage
            FROM accounts
            WHERE is_del = FALSE OR is_del IS NULL
          `, [now])

          if (countRows.length > 0) {
            accountStats = {
              total: countRows[0].total || 0,
              active: countRows[0].active || 0,
              error: countRows[0].error || 0,
              expired: countRows[0].expired || 0,
              lowUsage: countRows[0].low_usage || 0
            }
          }
        } catch (error) {
          console.error('[AccountPool] Failed to get account stats:', error.message)
        }
      }

      // 3. 计算健康得分
      let healthScore = 100

      // 数据库连接失败扣50分
      if (!dbHealthy) {
        healthScore -= 50
      }

      // 没有可用账号扣30分
      if (accountStats.active === 0) {
        healthScore -= 30
      }

      // 错误账号比例过高扣分
      if (accountStats.total > 0) {
        const errorRate = accountStats.error / accountStats.total
        if (errorRate > 0.5) {
          healthScore -= 20
        } else if (errorRate > 0.2) {
          healthScore -= 10
        }
      }

      // 过期账号比例过高扣分
      if (accountStats.active > 0) {
        const expiredRate = accountStats.expired / accountStats.active
        if (expiredRate > 0.3) {
          healthScore -= 10
        }
      }

      // 缓存命中率过低扣分
      const totalCacheOps = this.stats.cacheHits + this.stats.cacheMisses
      if (totalCacheOps > 100) {
        const hitRate = this.stats.cacheHits / totalCacheOps
        if (hitRate < 0.5) {
          healthScore -= 5
        }
      }

      healthScore = Math.max(0, healthScore)
      this.stats.healthScore = healthScore
      this.stats.lastHealthCheck = now

      return {
        healthy: healthScore >= 50,
        score: healthScore,
        timestamp: now,
        database: {
          connected: dbHealthy,
          lastCheckTime: this.lastDbCheckTime
        },
        accounts: accountStats,
        cache: {
          size: this.accountsCache.size,
          hitRate: totalCacheOps > 0
            ? Math.round((this.stats.cacheHits / totalCacheOps) * 100)
            : 100,
          staleCacheUsed: this.stats.staleCacheUsed
        },
        validation: {
          errors: this.stats.validationErrors,
          repairs: this.stats.dataRepairs,
          incompleteAccounts: this.stats.incompleteAccounts
        },
        recommendations: this.generateHealthRecommendations(healthScore, dbHealthy, accountStats)
      }
    } catch (error) {
      console.error('[AccountPool] Health check failed:', error.message)
      return {
        healthy: false,
        score: 0,
        error: error.message,
        timestamp: now
      }
    }
  }

  /**
   * 生成健康建议
   * @param {number} score - 健康得分
   * @param {boolean} dbHealthy - 数据库是否健康
   * @param {object} accountStats - 账号统计
   * @returns {string[]} 建议列表
   */
  generateHealthRecommendations(score, dbHealthy, accountStats) {
    const recommendations = []

    if (!dbHealthy) {
      recommendations.push('数据库连接异常，请检查数据库服务状态')
    }

    if (accountStats.active === 0) {
      recommendations.push('没有可用账号，请添加或激活账号')
    }

    if (accountStats.error > 0) {
      recommendations.push(`有 ${accountStats.error} 个账号处于错误状态，请检查并修复`)
    }

    if (accountStats.expired > 0) {
      recommendations.push(`有 ${accountStats.expired} 个账号 token 已过期，请刷新 token`)
    }

    if (accountStats.lowUsage > 0) {
      recommendations.push(`有 ${accountStats.lowUsage} 个账号使用量接近上限`)
    }

    if (this.stats.validationErrors > 10) {
      recommendations.push('数据验证错误较多，建议检查数据完整性')
    }

    return recommendations
  }

  /**
   * 获取详细的健康报告
   * @returns {Promise<object>} 详细健康报告
   */
  async getHealthReport() {
    const health = await this.getPoolHealth()

    // 计算查询性能统计
    const queryStats = this.calculateQueryStats()

    // 获取各分组的账号分布
    let groupDistribution = {}
    try {
      const [rows] = await this.dbPool.query(`
        SELECT
          COALESCE(group_id, '__ungrouped__') as group_id,
          COUNT(*) as total,
          SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error
        FROM accounts
        WHERE is_del = FALSE OR is_del IS NULL
        GROUP BY group_id
      `)

      for (const row of rows) {
        groupDistribution[row.group_id] = {
          total: row.total,
          active: row.active,
          error: row.error
        }
      }
    } catch (error) {
      console.error('[AccountPool] Failed to get group distribution:', error.message)
    }

    // 计算使用率分布
    let usageDistribution = { low: 0, medium: 0, high: 0 }
    try {
      const [rows] = await this.dbPool.query(`
        SELECT
          SUM(CASE WHEN usage_percent_used < 50 THEN 1 ELSE 0 END) as low,
          SUM(CASE WHEN usage_percent_used >= 50 AND usage_percent_used < 80 THEN 1 ELSE 0 END) as medium,
          SUM(CASE WHEN usage_percent_used >= 80 THEN 1 ELSE 0 END) as high
        FROM accounts
        WHERE status = 'active' AND (is_del = FALSE OR is_del IS NULL)
      `)

      if (rows.length > 0) {
        usageDistribution = {
          low: rows[0].low || 0,
          medium: rows[0].medium || 0,
          high: rows[0].high || 0
        }
      }
    } catch (error) {
      console.error('[AccountPool] Failed to get usage distribution:', error.message)
    }

    return {
      ...health,
      queryPerformance: queryStats,
      groupDistribution,
      usageDistribution,
      dbConnectionStats: {
        failureCount: this.stats.dbConnectionFailureCount,
        lastFailure: this.stats.lastDbConnectionFailure,
        currentStatus: this.dbConnectionFailed ? 'disconnected' : 'connected'
      }
    }
  }

  /**
   * 计算查询性能统计
   */
  calculateQueryStats() {
    if (this.stats.queryDurations.length === 0) {
      return {
        avgDuration: 0,
        p50Duration: 0,
        p95Duration: 0,
        successRate: 100,
        sampleCount: 0
      }
    }

    const durations = this.stats.queryDurations.map(q => q.durationMs)
    const sorted = [...durations].sort((a, b) => a - b)
    const successCount = this.stats.queryDurations.filter(q => q.success).length

    return {
      avgDuration: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
      p50Duration: sorted[Math.floor(sorted.length * 0.5)],
      p95Duration: sorted[Math.floor(sorted.length * 0.95)],
      successRate: Math.round((successCount / this.stats.queryDurations.length) * 100),
      sampleCount: this.stats.queryDurations.length
    }
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const queryStats = this.calculateQueryStats()

    return {
      ...this.stats,
      cacheSize: this.accountsCache.size,
      dbConnectionFailed: this.dbConnectionFailed,
      // 计算缓存命中率
      cacheHitRate: (this.stats.cacheHits + this.stats.cacheMisses) > 0
        ? Math.round((this.stats.cacheHits / (this.stats.cacheHits + this.stats.cacheMisses)) * 100)
        : 100,
      // 并发控制统计
      concurrency: {
        roundRobinAvgLockWaitTime: this.stats.roundRobinLockWaitCount > 0
          ? Math.round(this.stats.roundRobinLockWaitTime / this.stats.roundRobinLockWaitCount)
          : 0,
        roundRobinLockWaitCount: this.stats.roundRobinLockWaitCount,
        indexResetCount: this.stats.indexResetCount
      },
      // 查询性能统计
      queryPerformance: queryStats,
      // 数据库连接统计
      dbConnection: {
        failureCount: this.stats.dbConnectionFailureCount,
        lastFailure: this.stats.lastDbConnectionFailure
      }
    }
  }

  /**
   * 重置统计信息
   */
  resetStats() {
    this.stats = {
      cacheHits: 0,
      cacheMisses: 0,
      dbErrors: 0,
      staleCacheUsed: 0,
      validationErrors: 0,
      dataRepairs: 0,
      incompleteAccounts: 0,
      lastHealthCheck: null,
      healthScore: 100,
      // 并发控制统计
      roundRobinLockWaitTime: 0,
      roundRobinLockWaitCount: 0,
      indexResetCount: 0,
      // 性能监控统计
      queryDurations: [],
      dbConnectionFailureCount: 0,
      lastDbConnectionFailure: null
    }
    console.log('[AccountPool] Stats reset')
  }
}

export default AccountPool
