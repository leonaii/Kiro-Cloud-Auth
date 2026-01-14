
/**
 * 系统日志记录器
 * 记录系统定时任务的执行日志，如 Token 刷新、账号池更新等
 * 自动清理 24 小时前的数据
 * 
 * 增强功能：
 * - 性能监控和指标收集
 * - 告警机制
 * - API调用追踪
 * - 日志分级和采样
 */

import { v4 as uuidv4 } from 'uuid'

// 日志级别
export const LogLevel = {
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  SUCCESS: 'success'
}

// 日志级别优先级
const LOG_LEVEL_PRIORITY = {
  TRACE: 0,
  DEBUG: 1,
  INFO: 2,
  WARN: 3,
  ERROR: 4,
  SUCCESS: 2
}

// 日志类型
export const LogType = {
  TOKEN_REFRESH: 'token_refresh',
  ACCOUNT_POOL: 'account_pool',
  CLEANUP: 'cleanup',
  SYSTEM: 'system',
  CONCURRENCY: 'concurrency',
  DISTRIBUTED_LOCK: 'distributed_lock',
  VERSION_CONFLICT: 'version_conflict',
  PERFORMANCE: 'performance',
  ALERT: 'alert',
  API_CALL: 'api_call'
}

// 告警类型
export const AlertType = {
  HIGH_LATENCY: 'high_latency',
  HIGH_ERROR_RATE: 'high_error_rate',
  POOL_EXHAUSTED: 'pool_exhausted',
  TOKEN_REFRESH_FAILURE_RATE: 'token_refresh_failure_rate',
  DATABASE_CONNECTION_FAILURE: 'database_connection_failure',
  QUEUE_BACKLOG: 'queue_backlog'
}

// 告警严重级别
export const AlertSeverity = {
  WARNING: 'warning',
  CRITICAL: 'critical'
}

// 默认告警阈值（可通过环境变量覆盖）
const DEFAULT_ALERT_THRESHOLDS = {
  highLatencyMs: parseInt(process.env.ALERT_HIGH_LATENCY_MS) || 5000,
  highErrorRatePercent: parseInt(process.env.ALERT_HIGH_ERROR_RATE_PERCENT) || 20,
  poolExhaustedMinAccounts: parseInt(process.env.ALERT_POOL_MIN_ACCOUNTS) || 3,
  tokenRefreshFailureRatePercent: parseInt(process.env.ALERT_TOKEN_REFRESH_FAILURE_RATE) || 20,
  queueBacklogSize: parseInt(process.env.ALERT_QUEUE_BACKLOG_SIZE) || 50
}

class SystemLogger {
  constructor(pool) {
    this.dbPool = pool
    this.cleanupInterval = null
    this.serverId = process.env.SERVER_ID || 'default'
    this.logLevel = (process.env.LOG_LEVEL || 'INFO').toUpperCase()
    this.logFormat = process.env.LOG_FORMAT || 'plain' // 'json' or 'plain'
    
    // 性能指标滑动窗口（最近1000条记录）
    this.performanceMetrics = new Map() // operation -> { durations: [], successCount, failCount, lastUpdated }
    this.maxMetricsWindow = 1000
    
    // 告警历史（最近24小时）
    this.alertHistory = []
    this.maxAlertHistory = 1000
    
    // 告警阈值
    this.alertThresholds = { ...DEFAULT_ALERT_THRESHOLDS }
    
    // API调用统计
    this.apiCallStats = new Map() // endpoint -> { calls: [], errorCount, totalDuration }
    
    // 采样率配置
    this.samplingRates = {
      [LogType.API_CALL]: parseFloat(process.env.LOG_SAMPLING_API_CALL) || 0.1,
      [LogType.PERFORMANCE]: parseFloat(process.env.LOG_SAMPLING_PERFORMANCE) || 0.1
    }
  }

  /**
   * 检查是否应该记录此日志（基于日志级别）
   */
  shouldLog(level) {
    const levelUpper = level.toUpperCase()
    const currentPriority = LOG_LEVEL_PRIORITY[this.logLevel] || LOG_LEVEL_PRIORITY.INFO
    const logPriority = LOG_LEVEL_PRIORITY[levelUpper] || LOG_LEVEL_PRIORITY.INFO
    return logPriority >= currentPriority
  }

  /**
   * 检查是否应该采样此日志
   */
  shouldSample(type, level) {
    // ERROR和WARN级别始终记录
    if (level === LogLevel.ERROR || level === LogLevel.WARN) {
      return true
    }
    
    // 检查采样率
    const samplingRate = this.samplingRates[type]
    if (samplingRate !== undefined && samplingRate < 1) {
      return Math.random() < samplingRate
    }
    
    return true
  }

  /**
   * 格式化日志输出
   */
  formatLog(logEntry) {
    if (this.logFormat === 'json') {
      return JSON.stringify(logEntry)
    }
    // Plain text格式
    const timestamp = new Date().toISOString()
    const level = logEntry.level?.toUpperCase() || 'INFO'
    return `[${level}] ${timestamp} - [${logEntry.type}] ${logEntry.message}`
  }

  /**
   * 脱敏请求头中的敏感信息
   */
  sanitizeHeaders(headers) {
    if (!headers || typeof headers !== 'object') return null
    
    const sanitized = { ...headers }
    
    // 脱敏Authorization字段（只保留前10个字符）
    if (sanitized.authorization) {
      const auth = sanitized.authorization
      sanitized.authorization = auth.length > 10 ? auth.substring(0, 10) + '...[已脱敏]' : auth
    }
    if (sanitized.Authorization) {
      const auth = sanitized.Authorization
      sanitized.Authorization = auth.length > 10 ? auth.substring(0, 10) + '...[已脱敏]' : auth
    }
    
    return sanitized
  }

  /**
   * 记录系统日志
   */
  async log({
    type,
    level = LogLevel.INFO,
    action,
    message,
    details = null,
    accountId = null,
    accountEmail = null,
    accountIdp = null,
    durationMs = null,
    requestId = null,
    requestHeaders = null
  }) {
    // 检查日志级别
    if (!this.shouldLog(level)) {
      return
    }
    
    // 检查采样
    if (!this.shouldSample(type, level)) {
      return
    }
    
    try {
      const logEntry = {
        id: uuidv4(),
        serverId: this.serverId,
        type,
        level,
        action,
        message,
        details,
        accountId,
        accountEmail,
        accountIdp,
        durationMs,
        requestId,
        requestHeaders,
        timestamp: Date.now()
      }
      
      // 控制台输出（格式化）
      if (level === LogLevel.ERROR || level === LogLevel.WARN) {
        console.log(this.formatLog(logEntry))
      }
      
      // 脱敏并序列化请求头
      const sanitizedHeaders = this.sanitizeHeaders(requestHeaders)
      const headersJson = sanitizedHeaders ? JSON.stringify(sanitizedHeaders) : null
      
      await this.dbPool.query(
        `INSERT INTO system_logs
         (id, server_id, type, level, action, message, details, account_id, account_email, account_idp, duration_ms, request_headers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          logEntry.id,
          this.serverId,
          type,
          level,
          action,
          message,
          details ? JSON.stringify(details) : null,
          accountId,
          accountEmail,
          accountIdp,
          durationMs,
          headersJson
        ]
      )
    } catch (error) {
      console.error('[SystemLogger] Failed to log:', error.message)
    }
  }

  /**
   * 记录 Token 刷新日志
   */
  async logTokenRefresh({ accountId, accountEmail, accountIdp, success, message, durationMs, details, requestHeaders = null }) {
    await this.log({
      type: LogType.TOKEN_REFRESH,
      level: success ? LogLevel.SUCCESS : LogLevel.ERROR,
      action: 'refresh_token',
      message,
      details,
      accountId,
      accountEmail,
      accountIdp,
      durationMs,
      requestHeaders
    })
  }

  /**
   * 记录账号池更新日志
   */
  async logAccountPool({ action, message, details, level = LogLevel.INFO }) {
    await this.log({
      type: LogType.ACCOUNT_POOL,
      level,
      action,
      message,
      details
    })
  }

  /**
   * 记录清理任务日志
   */
  async logCleanup({ action, message, details, level = LogLevel.INFO }) {
    await this.log({
      type: LogType.CLEANUP,
      level,
      action,
      message,
      details
    })
  }

  /**
   * 记录通用系统日志
   */
  async logSystem({ action, message, details, level = LogLevel.INFO, accountId = null, accountEmail = null, accountIdp = null }) {
    await this.log({
      type: LogType.SYSTEM,
      level,
      action,
      message,
      details,
      accountId,
      accountEmail,
      accountIdp
    })
  }

  /**
   * 记录并发控制日志
   */
  async logConcurrency({ action, message, details, level = LogLevel.INFO }) {
    await this.log({
      type: LogType.CONCURRENCY,
      level,
      action,
      message,
      details
    })
  }

  /**
   * 记录分布式锁日志
   */
  async logDistributedLock({ action, lockName, success, waitTimeMs = null, details = null }) {
    await this.log({
      type: LogType.DISTRIBUTED_LOCK,
      level: success ? LogLevel.INFO : LogLevel.WARN,
      action,
      message: `分布式锁 ${action}: ${lockName} - ${success ? '成功' : '失败'}`,
      details: {
        lockName,
        success,
        waitTimeMs,
        ...details
      }
    })
  }

  /**
   * 记录版本冲突日志
   */
  async logVersionConflict({ resourceType, resourceId, clientVersion, serverVersion, retried = false, retrySuccess = false, details = null }) {
    const level = retried && retrySuccess ? LogLevel.INFO : LogLevel.WARN
    const action = retried ? (retrySuccess ? 'conflict_resolved' : 'conflict_retry_failed') : 'conflict_detected'
    
    await this.log({
      type: LogType.VERSION_CONFLICT,
      level,
      action,
      message: `版本冲突 [${resourceType}:${resourceId}]: 客户端版本=${clientVersion}, 服务器版本=${serverVersion}`,
      details: {
        resourceType,
        resourceId,
        clientVersion,
        serverVersion,
        retried,
        retrySuccess,
        ...details
      }
    })
  }

  /**
   * 记录轮询索引更新日志
   */
  async logRoundRobinUpdate({ groupId, oldIndex, newIndex, accountCount, lockWaitTimeMs = 0 }) {
    await this.log({
      type: LogType.CONCURRENCY,
      level: LogLevel.INFO,
      action: 'round_robin_update',
      message: `轮询索引更新 [${groupId}]: ${oldIndex} -> ${newIndex} (共${accountCount}个账号)`,
      details: {
        groupId,
        oldIndex,
        newIndex,
        accountCount,
        lockWaitTimeMs
      },
      durationMs: lockWaitTimeMs
    })
  }

  /**
   * 记录锁跳过日志
   */
  async logLockSkipped({ lockName, reason, accountId = null, accountEmail = null }) {
    await this.log({
      type: LogType.DISTRIBUTED_LOCK,
      level: LogLevel.INFO,
      action: 'lock_skipped',
      message: `跳过操作（锁被占用）: ${lockName} - ${reason}`,
      details: {
        lockName,
        reason
      },
      accountId,
      accountEmail
    })
  }

  // ==================== 性能监控方法 ====================

  /**
   * 记录性能指标
   */
  async logPerformance({ operation, durationMs, success, details = {} }) {
    // 更新性能指标滑动窗口
    this.updatePerformanceMetrics(operation, durationMs, success)
    
    // 检查是否需要触发告警
    await this.checkPerformanceAlerts(operation, durationMs, success)
    
    // 记录到数据库
    await this.log({
      type: LogType.PERFORMANCE,
      level: success ? LogLevel.INFO : LogLevel.WARN,
      action: operation,
      message: `性能指标 [${operation}]: ${durationMs}ms - ${success ? '成功' : '失败'}`,
      details: {
        operation,
        durationMs,
        success,
        ...details
      },
      durationMs
    })
  }

  /**
   * 更新性能指标滑动窗口
   */
  updatePerformanceMetrics(operation, durationMs, success) {
    if (!this.performanceMetrics.has(operation)) {
      this.performanceMetrics.set(operation, {
        durations: [],
        successCount: 0,
        failCount: 0,
        lastUpdated: Date.now()
      })
    }
    
    const metrics = this.performanceMetrics.get(operation)
    metrics.durations.push(durationMs)
    
    // 保持滑动窗口大小
    if (metrics.durations.length > this.maxMetricsWindow) {
      metrics.durations.shift()
    }
    
    if (success) {
      metrics.successCount++
    } else {
      metrics.failCount++
    }
    
    metrics.lastUpdated = Date.now()
  }

  /**
   * 检查性能告警条件
   */
  async checkPerformanceAlerts(operation, durationMs, success) {
    // 高延迟告警（排除token_refresh操作，因为它包含sleep时间）
    if (operation !== 'token_refresh' && durationMs > this.alertThresholds.highLatencyMs) {
      await this.logAlert({
        alertType: AlertType.HIGH_LATENCY,
        severity: durationMs > this.alertThresholds.highLatencyMs * 2 ? AlertSeverity.CRITICAL : AlertSeverity.WARNING,
        message: `操作 ${operation} 延迟过高: ${durationMs}ms`,
        details: { operation, durationMs },
        threshold: this.alertThresholds.highLatencyMs,
        currentValue: durationMs
      })
    }
    
    // 检查错误率
    const metrics = this.performanceMetrics.get(operation)
    if (metrics && metrics.successCount + metrics.failCount >= 100) {
      const errorRate = (metrics.failCount / (metrics.successCount + metrics.failCount)) * 100
      if (errorRate > this.alertThresholds.highErrorRatePercent) {
        await this.logAlert({
          alertType: AlertType.HIGH_ERROR_RATE,
          severity: errorRate > this.alertThresholds.highErrorRatePercent * 1.5 ? AlertSeverity.CRITICAL : AlertSeverity.WARNING,
          message: `操作 ${operation} 错误率过高: ${errorRate.toFixed(1)}%`,
          details: { operation, errorRate, successCount: metrics.successCount, failCount: metrics.failCount },
          threshold: this.alertThresholds.highErrorRatePercent,
          currentValue: errorRate
        })
      }
    }
  }

  /**
   * 记录告警事件
   */
  async logAlert({ alertType, severity, message, details = {}, threshold, currentValue }) {
    const alertRecord = {
      id: uuidv4(),
      alertType,
      severity,
      message,
      details,
      threshold,
      currentValue,
      timestamp: Date.now(),
      resolved: false
    }
    
    // 添加到告警历史
    this.alertHistory.push(alertRecord)
    
    // 保持历史记录大小
    if (this.alertHistory.length > this.maxAlertHistory) {
      this.alertHistory.shift()
    }
    
    // 记录到数据库
    await this.log({
      type: LogType.ALERT,
      level: severity === AlertSeverity.CRITICAL ? LogLevel.ERROR : LogLevel.WARN,
      action: alertType,
      message: `[${severity.toUpperCase()}] ${message}`,
      details: {
        alertType,
        severity,
        threshold,
        currentValue,
        ...details
      }
    })
    
    // 控制台输出告警
    const alertPrefix = severity === AlertSeverity.CRITICAL ? '🚨 CRITICAL' : '⚠️ WARNING'
    console.log(`[SystemLogger] ${alertPrefix}: ${message}`)
  }

  /**
   * 记录API调用
   */
  async logApiCall({ endpoint, method, statusCode, durationMs, accountId = null, errorType = null, requestId = null, requestHeaders = null }) {
    const success = statusCode >= 200 && statusCode < 400
    
    // 更新API调用统计
    this.updateApiCallStats(endpoint, method, durationMs, success, statusCode)
    
    // 记录到数据库
    await this.log({
      type: LogType.API_CALL,
      level: success ? LogLevel.INFO : LogLevel.WARN,
      action: `${method} ${endpoint}`,
      message: `API调用 ${method} ${endpoint}: ${statusCode} (${durationMs}ms)`,
      details: {
        endpoint,
        method,
        statusCode,
        durationMs,
        success,
        errorType
      },
      accountId,
      durationMs,
      requestId,
      requestHeaders
    })
  }

  /**
   * 更新API调用统计
   */
  updateApiCallStats(endpoint, method, durationMs, success, statusCode) {
    const key = `${method}:${endpoint}`
    
    if (!this.apiCallStats.has(key)) {
      this.apiCallStats.set(key, {
        calls: [],
        errorCount: 0,
        totalDuration: 0,
        lastUpdated: Date.now()
      })
    }
    
    const stats = this.apiCallStats.get(key)
    stats.calls.push({ durationMs, success, statusCode, timestamp: Date.now() })
    
    // 保持最近1000条记录
    if (stats.calls.length > 1000) {
      stats.calls.shift()
    }
    
    if (!success) {
      stats.errorCount++
    }
    stats.totalDuration += durationMs
    stats.lastUpdated = Date.now()
  }

  // ==================== 性能统计方法 ====================

  /**
   * 获取性能统计信息
   */
  getPerformanceStats() {
    const stats = {}
    
    for (const [operation, metrics] of this.performanceMetrics.entries()) {
      if (metrics.durations.length === 0) continue
      
      const sorted = [...metrics.durations].sort((a, b) => a - b)
      const total = metrics.successCount + metrics.failCount
      
      stats[operation] = {
        avgDuration: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        p99: sorted[Math.floor(sorted.length * 0.99)],
        minDuration: sorted[0],
        maxDuration: sorted[sorted.length - 1],
        successRate: total > 0 ? (metrics.successCount / total * 100).toFixed(2) : 0,
        totalCalls: total,
        successCount: metrics.successCount,
        failCount: metrics.failCount,
        lastUpdated: metrics.lastUpdated
      }
    }
    
    return stats
  }

  /**
   * 获取告警历史
   */
  getAlertHistory({ alertType = null, severity = null, limit = 100 } = {}) {
    let alerts = [...this.alertHistory]
    
    // 过滤
    if (alertType) {
      alerts = alerts.filter(a => a.alertType === alertType)
    }
    if (severity) {
      alerts = alerts.filter(a => a.severity === severity)
    }
    
    // 按时间倒序
    alerts.sort((a, b) => b.timestamp - a.timestamp)
    
    // 限制数量
    alerts = alerts.slice(0, limit)
    
    // 统计摘要
    const summary = {
      total: this.alertHistory.length,
      critical: this.alertHistory.filter(a => a.severity === AlertSeverity.CRITICAL).length,
      warning: this.alertHistory.filter(a => a.severity === AlertSeverity.WARNING).length,
      byType: {}
    }
    
    for (const alert of this.alertHistory) {
      summary.byType[alert.alertType] = (summary.byType[alert.alertType] || 0) + 1
    }
    
    return { alerts, summary }
  }

  /**
   * 获取API调用统计
   */
  getApiCallStats() {
    const stats = []
    
    for (const [key, data] of this.apiCallStats.entries()) {
      if (data.calls.length === 0) continue
      
      const [method, endpoint] = key.split(':')
      const durations = data.calls.map(c => c.durationMs)
      const sorted = [...durations].sort((a, b) => a - b)
      const errorCount = data.calls.filter(c => !c.success).length
      
      stats.push({
        endpoint,
        method,
        avgDuration: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
        p95Duration: sorted[Math.floor(sorted.length * 0.95)],
        errorRate: (errorCount / data.calls.length * 100).toFixed(2),
        totalCalls: data.calls.length,
        errorCount,
        lastUpdated: data.lastUpdated
      })
    }
    
    // 按调用次数排序
    stats.sort((a, b) => b.totalCalls - a.totalCalls)
    
    return stats
  }

  /**
   * 标记告警为已解决
   */
  resolveAlert(alertId) {
    const alert = this.alertHistory.find(a => a.id === alertId)
    if (alert) {
      alert.resolved = true
      alert.resolvedAt = Date.now()
    }
  }

  /**
   * 更新告警阈值
   */
  updateAlertThresholds(thresholds) {
    this.alertThresholds = { ...this.alertThresholds, ...thresholds }
  }

  /**
   * 清理过期的性能指标和告警历史
   */
  cleanupMetrics() {
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000
    
    // 清理过期的性能指标
    for (const [operation, metrics] of this.performanceMetrics.entries()) {
      if (metrics.lastUpdated < oneHourAgo) {
        this.performanceMetrics.delete(operation)
      }
    }
    
    // 清理过期的API调用统计
    for (const [key, stats] of this.apiCallStats.entries()) {
      if (stats.lastUpdated < oneHourAgo) {
        this.apiCallStats.delete(key)
      }
    }
    
    // 清理过期的告警历史
    this.alertHistory = this.alertHistory.filter(a => a.timestamp > oneDayAgo)
  }

  /**
   * 清理 24 小时前的日志
   */
  async cleanup() {
    try {
      const [result] = await this.dbPool.query(
        `DELETE FROM system_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`
      )
      if (result.affectedRows > 0) {
        console.log(`[SystemLogger] Cleaned up ${result.affectedRows} old logs`)
        await this.logCleanup({
          action: 'cleanup_system_logs',
          message: `清理了 ${result.affectedRows} 条过期日志`,
          details: { deletedCount: result.affectedRows }
        })
      }
      
      // 同时清理内存中的指标
      this.cleanupMetrics()
    } catch (error) {
      console.error('[SystemLogger] Cleanup failed:', error.message)
    }
  }

  /**
   * 获取日志列表
   */
  async getLogs({ page = 1, pageSize = 50, type, level, serverId, startTime, endTime } = {}) {
    try {
      // 构建查询条件
      const conditions = []
      const params = []

      // 默认只查询 24 小时内的数据
      conditions.push('created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)')

      if (serverId && serverId.trim()) {
        conditions.push('server_id = ?')
        params.push(serverId.trim())
      }

      if (type && type.trim()) {
        conditions.push('type = ?')
        params.push(type.trim())
      }

      if (level && level.trim()) {
        conditions.push('level = ?')
        params.push(level.trim())
      }

      if (startTime) {
        conditions.push('created_at >= ?')
        params.push(new Date(startTime))
      }

      if (endTime) {
        conditions.push('created_at <= ?')
        params.push(new Date(endTime))
      }

      const whereClause = conditions.length > 0 ? conditions.join(' AND ') : '1=1'

      // 获取总数
      const countSql = `SELECT COUNT(*) as total FROM system_logs WHERE ${whereClause}`
      console.log(`[SystemLogger] Count SQL: ${countSql}, params: ${JSON.stringify(params)}`)
      const [countResult] = await this.dbPool.query(countSql, params)
      const total = countResult[0].total

      // 获取分页数据
      const pageNum = parseInt(page) || 1
      const pageSizeNum = parseInt(pageSize) || 50
      const offset = (pageNum - 1) * pageSizeNum

      const dataSql = `SELECT * FROM system_logs WHERE ${whereClause} ORDER BY created_at DESC LIMIT ${pageSizeNum} OFFSET ${offset}`
      console.log(`[SystemLogger] Data SQL: ${dataSql}`)
      const [rows] = await this.dbPool.query(dataSql, params)

      // 处理 details 和 request_headers 字段
      const data = rows.map((row) => {
        let details = row.details
        if (typeof details === 'string') {
          try {
            details = JSON.parse(details)
          } catch {
            details = null
          }
        }
        
        let requestHeaders = row.request_headers
        if (typeof requestHeaders === 'string') {
          try {
            requestHeaders = JSON.parse(requestHeaders)
          } catch {
            requestHeaders = null
          }
        }
        
        return { ...row, details, request_headers: requestHeaders }
      })

      console.log(`[SystemLogger] getLogs: found ${data.length} logs, total: ${total}`)

      return {
        data,
        pagination: {
          page: pageNum,
          pageSize: pageSizeNum,
          total,
          totalPages: Math.ceil(total / pageSizeNum)
        }
      }
    } catch (error) {
      console.error('[SystemLogger] Failed to get logs:', error.message, error.stack)
      return { data: [], pagination: { page, pageSize, total: 0, totalPages: 0 } }
    }
  }

  /**
   * 获取统计信息
   */
  async getStats() {
    try {
      // 总体统计
      const [rows] = await this.dbPool.query(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN level = 'success' THEN 1 ELSE 0 END) as successCount,
          SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) as errorCount,
          SUM(CASE WHEN level = 'warn' THEN 1 ELSE 0 END) as warnCount,
          SUM(CASE WHEN level = 'info' THEN 1 ELSE 0 END) as infoCount
        FROM system_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      `)

      const stats = rows[0]

      // 按类型统计
      const [typeRows] = await this.dbPool.query(`
        SELECT type, COUNT(*) as count,
          SUM(CASE WHEN level = 'success' THEN 1 ELSE 0 END) as success,
          SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) as errors
        FROM system_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        GROUP BY type
        ORDER BY count DESC
      `)

      // 按小时统计
      const [hourlyRows] = await this.dbPool.query(`
        SELECT
          DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00') as hour,
          COUNT(*) as count,
          SUM(CASE WHEN level = 'success' THEN 1 ELSE 0 END) as success,
          SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) as errors
        FROM system_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        GROUP BY hour
        ORDER BY hour DESC
        LIMIT 24
      `)

      // 最近错误
      const [recentErrors] = await this.dbPool.query(`
        SELECT type, action, message, account_email, created_at
        FROM system_logs
        WHERE level = 'error' AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        ORDER BY created_at DESC
        LIMIT 10
      `)

      // 并发控制统计
      const [concurrencyRows] = await this.dbPool.query(`
        SELECT
          SUM(CASE WHEN type = 'concurrency' THEN 1 ELSE 0 END) as concurrency_events,
          SUM(CASE WHEN type = 'distributed_lock' THEN 1 ELSE 0 END) as lock_events,
          SUM(CASE WHEN type = 'version_conflict' THEN 1 ELSE 0 END) as conflict_events,
          SUM(CASE WHEN type = 'distributed_lock' AND action = 'lock_skipped' THEN 1 ELSE 0 END) as lock_skipped_events
        FROM system_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      `)

      // 获取性能统计
      const performanceStats = this.getPerformanceStats()
      
      // 获取告警统计
      const alertStats = this.getAlertHistory({ limit: 100 })
      
      // 获取API调用统计
      const apiStats = this.getApiCallStats()

      return {
        overview: {
          total: stats.total,
          successCount: stats.successCount,
          errorCount: stats.errorCount,
          warnCount: stats.warnCount,
          infoCount: stats.infoCount
        },
        byType: typeRows,
        hourly: hourlyRows,
        recentErrors,
        concurrency: concurrencyRows[0] || {},
        performance: performanceStats,
        alerts: alertStats,
        apiCalls: apiStats
      }
    } catch (error) {
      console.error('[SystemLogger] Failed to get stats:', error.message)
      return {
        overview: {},
        byType: [],
        hourly: [],
        recentErrors: [],
        concurrency: {},
        performance: {},
        alerts: { alerts: [], summary: {} },
        apiCalls: []
      }
    }
  }

  /**
   * 启动定时清理任务
   */
  startCleanupTask(intervalMs = 60 * 60 * 1000) {
    // 每小时清理一次
    this.cleanupInterval = setInterval(() => {
      this.cleanup()
    }, intervalMs)
    console.log('[SystemLogger] Cleanup task started')
  }

  /**
   * 停止定时清理任务
   */
  stopCleanupTask() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
      console.log('[SystemLogger] Cleanup task stopped')
    }
  }
}

// 单例实例
let loggerInstance = null

/**
 * 初始化系统日志记录器
 */
export function initSystemLogger(pool) {
  if (!loggerInstance) {
    loggerInstance = new SystemLogger(pool)
    loggerInstance.startCleanupTask()
  }
  return loggerInstance
}

/**
 * 获取系统日志记录器实例
 */
export function getSystemLogger() {
  return loggerInstance
}

export default SystemLogger