/**
 * API 请求日志记录器
 * 记录 /v1 API 的请求日志，自动清理 24 小时前的数据
 */

import { v4 as uuidv4 } from 'uuid'

class RequestLogger {
  constructor(pool) {
    this.dbPool = pool
    this.cleanupInterval = null
    this.serverId = process.env.SERVER_ID || 'default'
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
   * 记录请求日志（异步写入，不阻塞请求）
   */
  log({
    requestId,
    accountId,
    accountEmail,
    accountIdp,
    model,
    isStream,
    status,
    errorType,
    errorMessage,
    requestTokens,
    responseTokens,
    durationMs,
    clientIp,
    userAgent,
    isThinking = false,
    thinkingBudget = 0,
    headerVersion = 1,
    requestHeaders = null,
    apiProtocol = 'openai'  // API 协议类型：openai 或 claude
  }) {
    // 脱敏并序列化请求头
    const sanitizedHeaders = this.sanitizeHeaders(requestHeaders)
    const headersJson = sanitizedHeaders ? JSON.stringify(sanitizedHeaders) : null
    
    // 异步写入数据库，不等待结果
    this.dbPool.query(
      `INSERT INTO api_request_logs
       (server_id, request_id, account_id, account_email, account_idp, model, is_stream, status,
        error_type, error_message, request_tokens, response_tokens,
        duration_ms, client_ip, user_agent, is_thinking, thinking_budget, header_version, request_headers, api_protocol)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        this.serverId,
        requestId || uuidv4(),
        accountId || null,
        accountEmail || null,
        accountIdp || null,
        model || null,
        isStream || false,
        status,
        errorType || null,
        errorMessage || null,
        requestTokens || 0,
        responseTokens || 0,
        durationMs || 0,
        clientIp || null,
        userAgent || null,
        isThinking ? 1 : 0,
        thinkingBudget || 0,
        headerVersion || 1,
        headersJson,
        apiProtocol || 'openai'
      ]
    ).catch(error => {
      console.error('[RequestLogger] Failed to log request:', error.message)
    })
  }

  /**
   * 记录成功请求
   */
  logSuccess(data) {
    this.log({ ...data, status: 'success' })
  }

  /**
   * 记录失败请求
   */
  logError(data) {
    this.log({ ...data, status: 'error' })
  }

  /**
   * 清理 24 小时前的日志
   */
  async cleanup() {
    try {
      const [result] = await this.dbPool.query(
        `DELETE FROM api_request_logs WHERE created_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)`
      )
      if (result.affectedRows > 0) {
        console.log(`[RequestLogger] Cleaned up ${result.affectedRows} old logs`)
      }
    } catch (error) {
      console.error('[RequestLogger] Cleanup failed:', error.message)
    }
  }

  /**
   * 获取日志列表
   */
  async getLogs({ page = 1, pageSize = 50, status, accountId, serverId, startTime, endTime, apiProtocol } = {}) {
    try {
      let whereClause = '1=1'
      const params = []

      if (serverId) {
        whereClause += ' AND server_id = ?'
        params.push(serverId)
      }

      if (status) {
        whereClause += ' AND status = ?'
        params.push(status)
      }

      if (accountId) {
        whereClause += ' AND account_id = ?'
        params.push(accountId)
      }

      if (apiProtocol) {
        whereClause += ' AND api_protocol = ?'
        params.push(apiProtocol)
      }

      if (startTime) {
        whereClause += ' AND created_at >= ?'
        params.push(new Date(startTime))
      }

      if (endTime) {
        whereClause += ' AND created_at <= ?'
        params.push(new Date(endTime))
      }

      // 获取总数
      const [countResult] = await this.dbPool.query(
        `SELECT COUNT(*) as total FROM api_request_logs WHERE ${whereClause}`,
        params
      )
      const total = countResult[0].total

      // 获取分页数据
      const offset = (page - 1) * pageSize
      const [rows] = await this.dbPool.query(
        `SELECT * FROM api_request_logs
         WHERE ${whereClause}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [...params, pageSize, offset]
      )

      // 解析request_headers JSON字段
      const data = rows.map(row => {
        let requestHeaders = row.request_headers
        if (typeof requestHeaders === 'string') {
          try {
            requestHeaders = JSON.parse(requestHeaders)
          } catch {
            requestHeaders = null
          }
        }
        return { ...row, request_headers: requestHeaders }
      })

      return {
        data,
        pagination: {
          page,
          pageSize,
          total,
          totalPages: Math.ceil(total / pageSize)
        }
      }
    } catch (error) {
      console.error('[RequestLogger] Failed to get logs:', error.message)
      return { data: [], pagination: { page, pageSize, total: 0, totalPages: 0 } }
    }
  }

  /**
   * 获取统计信息
   */
  async getStats() {
    try {
      const [rows] = await this.dbPool.query(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
          AVG(duration_ms) as avg_duration,
          SUM(request_tokens) as total_request_tokens,
          SUM(response_tokens) as total_response_tokens
        FROM api_request_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
      `)

      const stats = rows[0]

      // 按小时统计
      const [hourlyRows] = await this.dbPool.query(`
        SELECT
          DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00') as hour,
          COUNT(*) as count,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
        FROM api_request_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        GROUP BY hour
        ORDER BY hour DESC
      `)

      // 错误类型统计
      const [errorRows] = await this.dbPool.query(`
        SELECT error_type, COUNT(*) as count
        FROM api_request_logs
        WHERE status = 'error' AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        GROUP BY error_type
        ORDER BY count DESC
        LIMIT 10
      `)

      // 按 API 协议统计
      const [protocolRows] = await this.dbPool.query(`
        SELECT
          api_protocol,
          COUNT(*) as count,
          SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) as success,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors,
          SUM(request_tokens) as request_tokens,
          SUM(response_tokens) as response_tokens
        FROM api_request_logs
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
        GROUP BY api_protocol
      `)

      return {
        total: stats.total || 0,
        successCount: stats.success_count || 0,
        errorCount: stats.error_count || 0,
        successRate: stats.total > 0 ? ((stats.success_count / stats.total) * 100).toFixed(2) : 0,
        avgDuration: Math.round(stats.avg_duration || 0),
        totalRequestTokens: stats.total_request_tokens || 0,
        totalResponseTokens: stats.total_response_tokens || 0,
        hourly: hourlyRows,
        errorTypes: errorRows,
        byProtocol: protocolRows
      }
    } catch (error) {
      console.error('[RequestLogger] Failed to get stats:', error.message)
      return {
        total: 0,
        successCount: 0,
        errorCount: 0,
        successRate: 0,
        avgDuration: 0,
        hourly: [],
        errorTypes: []
      }
    }
  }

  /**
   * 启动定时清理
   */
  startCleanup() {
    // 每小时清理一次
    this.cleanupInterval = setInterval(() => this.cleanup(), 60 * 60 * 1000)
    // 启动时立即清理一次
    this.cleanup()
    console.log('[RequestLogger] Cleanup scheduler started')
  }

  /**
   * 停止定时清理
   */
  stopCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }
}

export default RequestLogger
