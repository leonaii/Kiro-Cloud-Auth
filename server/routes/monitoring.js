/**
 * 监控仪表板API端点
 *
 * 提供系统性能、告警和健康状态的查询接口
 */

import express from 'express'
import { getSystemLogger } from '../openai-compat/system-logger.js'
import { pool } from '../config/database.js'

const router = express.Router()

// TokenRefresher 实例引用（由 index.js 设置，避免循环依赖）
let tokenRefresherInstance = null

/**
 * 设置 TokenRefresher 实例（由 index.js 调用）
 */
export function setTokenRefresher(refresher) {
  tokenRefresherInstance = refresher
}

/**
 * 获取 TokenRefresher 实例
 */
function getTokenRefresher() {
  return tokenRefresherInstance
}

/**
 * GET /api/monitoring/performance
 * 获取性能指标
 * 
 * Query参数:
 * - timeRange: 时间范围 (last_hour, last_24h, last_7d)
 */
router.get('/performance', async (req, res) => {
  try {
    const logger = getSystemLogger()
    if (!logger) {
      return res.status(503).json({
        success: false,
        error: 'SERVICE_UNAVAILABLE',
        message: '系统日志服务未初始化'
      })
    }
    
    const timeRange = req.query.timeRange || 'last_hour'
    const performanceStats = logger.getPerformanceStats()
    const apiCallStats = logger.getApiCallStats()
    
    res.json({
      success: true,
      data: {
        operations: Object.entries(performanceStats).map(([name, stats]) => ({
          name,
          ...stats
        })),
        apiCalls: apiCallStats,
        timeRange
      }
    })
  } catch (error) {
    console.error('[Monitoring] Failed to get performance stats:', error.message)
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    })
  }
})

/**
 * GET /api/monitoring/alerts
 * 获取告警列表
 * 
 * Query参数:
 * - severity: 严重级别过滤 (warning, critical)
 * - alertType: 告警类型过滤
 * - limit: 返回数量限制 (默认100)
 */
router.get('/alerts', async (req, res) => {
  try {
    const logger = getSystemLogger()
    if (!logger) {
      return res.status(503).json({
        success: false,
        error: 'SERVICE_UNAVAILABLE',
        message: '系统日志服务未初始化'
      })
    }
    
    const { severity, alertType, limit = 100 } = req.query
    const alertHistory = logger.getAlertHistory({
      severity: severity || null,
      alertType: alertType || null,
      limit: parseInt(limit) || 100
    })
    
    res.json({
      success: true,
      data: alertHistory
    })
  } catch (error) {
    console.error('[Monitoring] Failed to get alerts:', error.message)
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    })
  }
})

/**
 * GET /api/monitoring/health
 * 获取系统健康状态
 */
router.get('/health', async (req, res) => {
  try {
    const logger = getSystemLogger()
    const tokenRefresher = getTokenRefresher()
    
    // 基础健康检查
    const health = {
      overall: 'healthy',
      timestamp: Date.now(),
      components: {
        database: { status: 'unknown', latency: null },
        systemLogger: { status: logger ? 'healthy' : 'unavailable' },
        tokenRefresher: { status: 'unknown' },
        accountPool: { status: 'unknown', availableAccounts: 0 }
      }
    }
    
    // 1. 数据库健康检查
    try {
      const dbStartTime = Date.now()
      await pool.query('SELECT 1')
      const dbLatency = Date.now() - dbStartTime
      
      health.components.database = {
        status: dbLatency < 1000 ? 'healthy' : (dbLatency < 3000 ? 'warning' : 'critical'),
        latency: dbLatency
      }
    } catch (dbError) {
      console.error('[Monitoring] Database health check failed:', dbError.message)
      health.components.database = {
        status: 'critical',
        latency: null,
        error: dbError.message
      }
      health.overall = 'critical'
    }
    
    // 2. 账号池健康检查（通过数据库查询）
    if (health.components.database.status !== 'critical') {
      try {
        const [accountStats] = await pool.query(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active,
            SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_count,
            SUM(CASE WHEN status = 'banned' THEN 1 ELSE 0 END) as banned,
            SUM(CASE WHEN cred_expires_at < ? THEN 1 ELSE 0 END) as expired,
            SUM(CASE WHEN status = 'active' AND cred_access_token IS NOT NULL AND cred_access_token != '' AND (COALESCE(usage_limit, 0) - COALESCE(usage_current, 0)) > 5 THEN 1 ELSE 0 END) as available
          FROM accounts
          WHERE is_del = FALSE OR is_del IS NULL
        `, [Date.now()])
        
        const stats = accountStats[0]
        const availableAccounts = stats.available || 0
        const errorRate = stats.total > 0 ? (stats.error_count / stats.total) : 0
        
        let poolStatus = 'healthy'
        if (availableAccounts === 0) {
          poolStatus = 'critical'
        } else if (availableAccounts < 3 || errorRate > 0.3) {
          poolStatus = 'warning'
        }
        
        health.components.accountPool = {
          status: poolStatus,
          availableAccounts: availableAccounts,
          totalAccounts: stats.total || 0,
          activeAccounts: stats.active || 0,
          errorAccounts: stats.error_count || 0,
          bannedAccounts: stats.banned || 0,
          expiredAccounts: stats.expired || 0,
          successRate: stats.total > 0 ? ((stats.total - stats.error_count) / stats.total) : 1
        }
        
        if (poolStatus === 'critical') {
          health.overall = 'critical'
        } else if (poolStatus === 'warning' && health.overall !== 'critical') {
          health.overall = 'warning'
        }
      } catch (poolError) {
        console.error('[Monitoring] Account pool health check failed:', poolError.message)
        health.components.accountPool = {
          status: 'unknown',
          error: poolError.message
        }
      }
    }
    
    // 3. Token 刷新器健康检查
    if (tokenRefresher) {
      try {
        const refresherInfo = tokenRefresher.getNextCheckInfo()
        const refresherStats = tokenRefresher.getStats()
        
        let refresherStatus = 'healthy'
        if (!refresherInfo.isRunning) {
          refresherStatus = 'warning'
        }
        if (refresherStats.recentFailureRate > 50) {
          refresherStatus = 'critical'
        } else if (refresherStats.recentFailureRate > 20) {
          refresherStatus = 'warning'
        }
        
        health.components.tokenRefresher = {
          status: refresherStatus,
          isRunning: refresherInfo.isRunning,
          isRefreshing: refresherInfo.isRefreshing,
          nextCheckTime: refresherInfo.nextCheckTime,
          lastCheckTime: refresherInfo.lastCheckTime,
          timeUntilNextCheck: refresherInfo.timeUntilNextCheck,
          retryQueueSize: refresherInfo.retryQueueSize,
          successRate: refresherStats.successRate,
          recentFailureRate: parseFloat(refresherStats.recentFailureRate) || 0,
          totalRefreshes: refresherStats.totalRefreshes,
          successfulRefreshes: refresherStats.successfulRefreshes,
          failedRefreshes: refresherStats.failedRefreshes
        }
        
        if (refresherStatus === 'critical' && health.overall !== 'critical') {
          health.overall = 'critical'
        } else if (refresherStatus === 'warning' && health.overall === 'healthy') {
          health.overall = 'warning'
        }
      } catch (refresherError) {
        console.error('[Monitoring] Token refresher health check failed:', refresherError.message)
        health.components.tokenRefresher = {
          status: 'unknown',
          error: refresherError.message
        }
      }
    } else {
      health.components.tokenRefresher = {
        status: 'unavailable',
        message: 'Token refresher not initialized or disabled'
      }
    }
    
    // 4. 如果有logger，获取更多统计信息
    if (logger) {
      try {
        const stats = await logger.getStats()
        
        // 根据统计信息判断健康状态
        if (stats.overview) {
          const errorRate = stats.overview.total > 0
            ? (stats.overview.errorCount / stats.overview.total) * 100
            : 0
          
          if (errorRate > 50 && health.overall !== 'critical') {
            health.overall = 'critical'
          } else if (errorRate > 20 && health.overall === 'healthy') {
            health.overall = 'warning'
          }
        }
        
        // 添加性能统计
        health.performance = stats.performance || {}
        health.alerts = stats.alerts || {}
      } catch (statsError) {
        console.warn('[Monitoring] Failed to get logger stats:', statsError.message)
      }
    } else {
      if (health.overall === 'healthy') {
        health.overall = 'warning'
      }
    }
    
    res.json({
      success: true,
      data: health
    })
  } catch (error) {
    console.error('[Monitoring] Health check failed:', error.message)
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message,
      data: {
        overall: 'unhealthy',
        timestamp: Date.now(),
        error: error.message
      }
    })
  }
})

/**
 * GET /api/monitoring/stats
 * 获取综合统计信息
 */
router.get('/stats', async (req, res) => {
  try {
    const logger = getSystemLogger()
    if (!logger) {
      return res.status(503).json({
        success: false,
        error: 'SERVICE_UNAVAILABLE',
        message: '系统日志服务未初始化'
      })
    }
    
    const stats = await logger.getStats()
    
    res.json({
      success: true,
      data: stats
    })
  } catch (error) {
    console.error('[Monitoring] Failed to get stats:', error.message)
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    })
  }
})

/**
 * POST /api/monitoring/alerts/:id/resolve
 * 标记告警为已解决
 */
router.post('/alerts/:id/resolve', async (req, res) => {
  try {
    const logger = getSystemLogger()
    if (!logger) {
      return res.status(503).json({
        success: false,
        error: 'SERVICE_UNAVAILABLE',
        message: '系统日志服务未初始化'
      })
    }
    
    const { id } = req.params
    logger.resolveAlert(id)
    
    res.json({
      success: true,
      data: {
        id,
        resolved: true,
        resolvedAt: Date.now()
      }
    })
  } catch (error) {
    console.error('[Monitoring] Failed to resolve alert:', error.message)
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    })
  }
})

// 已删除：POST /api/monitoring/errors 端点
// 前端错误不再上报到服务器，仅在客户端本地记录

/**
 * GET /api/monitoring/logs
 * 获取系统日志
 * 
 * Query参数:
 * - page: 页码 (默认1)
 * - pageSize: 每页数量 (默认50)
 * - type: 日志类型过滤
 * - level: 日志级别过滤
 */
router.get('/logs', async (req, res) => {
  try {
    const logger = getSystemLogger()
    if (!logger) {
      return res.status(503).json({
        success: false,
        error: 'SERVICE_UNAVAILABLE',
        message: '系统日志服务未初始化'
      })
    }
    
    const { page = 1, pageSize = 50, type, level, serverId, startTime, endTime } = req.query
    
    const logs = await logger.getLogs({
      page: parseInt(page) || 1,
      pageSize: parseInt(pageSize) || 50,
      type: type || undefined,
      level: level || undefined,
      serverId: serverId || undefined,
      startTime: startTime ? parseInt(startTime) : undefined,
      endTime: endTime ? parseInt(endTime) : undefined
    })
    
    res.json({
      success: true,
      data: logs
    })
  } catch (error) {
    console.error('[Monitoring] Failed to get logs:', error.message)
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    })
  }
})

export default router