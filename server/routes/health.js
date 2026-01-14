/**
 * 健康检查路由
 *
 * 提供系统健康状态监控：
 * - 数据库连接状态和连接池统计
 * - Token 刷新服务状态
 * - 错误统计和重试统计
 */
import { Router } from 'express'
import { pool, checkDatabaseHealth, getPoolStats } from '../config/database.js'
import { APP_VERSION, SERVER_ID } from '../config/index.js'
import { getTokenRefresher } from '../index.js'
import { getErrorStats, getRetryStats } from '../utils/error-handler.js'

const router = Router()

// 健康检查
router.get('/api/health', async (req, res) => {
  try {
    // 使用增强的数据库健康检查
    const dbHealth = await checkDatabaseHealth()
    
    // 获取 Token 刷新服务的下次检测时间
    const tokenRefresher = getTokenRefresher()
    const tokenCheckInfo = tokenRefresher ? tokenRefresher.getNextCheckInfo() : null
    
    res.json({
      status: dbHealth.healthy ? 'ok' : 'degraded',
      database: {
        connected: dbHealth.healthy,
        latency: dbHealth.latency,
        version: dbHealth.details?.version,
        threadsConnected: dbHealth.details?.threadsConnected
      },
      version: APP_VERSION,
      serverId: SERVER_ID,
      tokenRefresh: tokenCheckInfo ? {
        nextCheckTime: tokenCheckInfo.nextCheckTime,
        lastCheckTime: tokenCheckInfo.lastCheckTime,
        checkInterval: tokenCheckInfo.checkInterval,
        isRefreshing: tokenCheckInfo.isRefreshing,
        isRunning: tokenCheckInfo.isRunning,
        timeUntilNextCheck: tokenCheckInfo.timeUntilNextCheck,
        retryQueueSize: tokenCheckInfo.retryQueueSize
      } : {
        isRunning: false,
        message: 'Token refresh service is disabled'
      }
    })
  } catch (error) {
    res.status(500).json({
      status: 'error',
      database: {
        connected: false,
        error: error.message
      },
      version: APP_VERSION,
      serverId: SERVER_ID,
      error: error.message
    })
  }
})

// 详细健康检查（包含更多诊断信息）
router.get('/api/health/detailed', async (req, res) => {
  try {
    // 数据库健康检查
    const dbHealth = await checkDatabaseHealth()
    const poolStats = getPoolStats()
    
    // Token 刷新服务状态
    const tokenRefresher = getTokenRefresher()
    const tokenCheckInfo = tokenRefresher ? tokenRefresher.getNextCheckInfo() : null
    const tokenStats = tokenRefresher ? tokenRefresher.getStats() : null
    
    // 错误和重试统计
    const errorStats = getErrorStats()
    const retryStats = getRetryStats()
    
    res.json({
      status: dbHealth.healthy ? 'ok' : 'degraded',
      timestamp: Date.now(),
      version: APP_VERSION,
      serverId: SERVER_ID,
      
      database: {
        health: dbHealth,
        pool: poolStats
      },
      
      tokenRefresh: {
        info: tokenCheckInfo,
        stats: tokenStats
      },
      
      errors: {
        stats: errorStats,
        retryStats: retryStats
      }
    })
  } catch (error) {
    res.status(500).json({
      status: 'error',
      timestamp: Date.now(),
      version: APP_VERSION,
      serverId: SERVER_ID,
      error: error.message
    })
  }
})

// 数据库连接池状态
router.get('/api/health/database', async (req, res) => {
  try {
    const dbHealth = await checkDatabaseHealth()
    const poolStats = getPoolStats()
    
    res.json({
      health: dbHealth,
      pool: poolStats
    })
  } catch (error) {
    res.status(500).json({
      error: error.message
    })
  }
})

// 获取下次 Token 检测时间（专用接口）
router.get('/api/token-check-info', async (req, res) => {
  try {
    const tokenRefresher = getTokenRefresher()
    
    if (!tokenRefresher) {
      return res.json({
        isRunning: false,
        message: 'Token refresh service is disabled'
      })
    }
    
    const info = tokenRefresher.getNextCheckInfo()
    res.json(info)
  } catch (error) {
    res.status(500).json({
      error: error.message
    })
  }
})

export default router
