/**
 * 数据库配置和连接池
 * 提供连接池管理、健康检查和监控功能
 */
import mysql from 'mysql2/promise'

// 数据库配置 - 针对 12核12G 服务器优化
export const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'kiro',
  password: process.env.DB_PASSWORD || 'pwd',
  database: process.env.DB_NAME || 'kiro',
  waitForConnections: true,
  connectionLimit: parseInt(process.env.DB_POOL_SIZE) || 100, // 12核可支持更多连接
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 5000,
  // 连接超时和空闲配置
  connectTimeout: 10000,
  acquireTimeout: 30000, // 获取连接超时30秒
  // 预热连接
  idleTimeout: 60000,
  maxIdle: 10, // 最大空闲连接数
  // 统一时区为UTC
  timezone: '+00:00'
}

// 创建连接池
export const pool = mysql.createPool(dbConfig)

// 连接获取重试配置
export const CONNECTION_RETRY_CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 100,
  RETRY_BACKOFF_MULTIPLIER: 2,
  RETRYABLE_ERRORS: [
    'ECONNREFUSED',           // 连接被拒绝
    'PROTOCOL_CONNECTION_LOST', // 连接丢失
    'ER_CON_COUNT_ERROR',     // 连接数超限
    'ENOTFOUND',              // DNS解析失败
    'ETIMEDOUT',              // 连接超时
    'ECONNRESET',             // 连接重置
    'ER_ACCESS_DENIED_ERROR', // 访问被拒绝（可能是临时的）
    'ER_TOO_MANY_USER_CONNECTIONS' // 用户连接数过多
  ]
}

/**
 * 判断是否为可重试的连接错误
 * @param {Error} error - 错误对象
 * @returns {boolean} 是否可重试
 */
export function isRetryableConnectionError(error) {
  if (!error) return false

  const errorCode = error.code || ''
  const errorMessage = error.message || ''

  // 检查错误码
  if (CONNECTION_RETRY_CONFIG.RETRYABLE_ERRORS.includes(errorCode)) {
    return true
  }

  // 检查错误消息中的关键词
  const retryablePatterns = [
    /connection.*refused/i,
    /connection.*lost/i,
    /connection.*reset/i,
    /too many connections/i,
    /cannot connect/i,
    /connection timed out/i
  ]

  return retryablePatterns.some(pattern => pattern.test(errorMessage))
}

/**
 * 带重试的连接获取
 * @param {object} options - 重试选项
 * @param {number} options.maxRetries - 最大重试次数（默认3）
 * @param {number} options.retryDelay - 初始重试延迟毫秒（默认100）
 * @param {string} options.operationName - 操作名称（用于日志）
 * @returns {Promise<mysql.PoolConnection>} 数据库连接
 */
export async function getConnectionWithRetry(options = {}) {
  const {
    maxRetries = CONNECTION_RETRY_CONFIG.MAX_RETRIES,
    retryDelay = CONNECTION_RETRY_CONFIG.RETRY_DELAY_MS,
    operationName = 'getConnection'
  } = options

  let lastError = null
  let currentDelay = retryDelay

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const connection = await pool.getConnection()

      // 如果是重试成功，记录日志
      if (attempt > 1) {
        console.log(`[Database] ${operationName} 重试成功，尝试次数: ${attempt}`)
        poolStats.connectionRetrySuccess = (poolStats.connectionRetrySuccess || 0) + 1
      }

      return connection
    } catch (error) {
      lastError = error

      // 记录重试统计
      poolStats.connectionRetryAttempts = (poolStats.connectionRetryAttempts || 0) + 1

      // 检查是否可重试
      if (!isRetryableConnectionError(error)) {
        console.error(`[Database] ${operationName} 失败（不可重试）:`, {
          error: error.message,
          code: error.code,
          attempt
        })
        throw error
      }

      // 检查是否还有重试机会
      if (attempt > maxRetries) {
        console.error(`[Database] ${operationName} 重试次数耗尽:`, {
          error: error.message,
          code: error.code,
          totalAttempts: attempt
        })
        poolStats.connectionRetryExhausted = (poolStats.connectionRetryExhausted || 0) + 1
        throw error
      }

      // 记录重试日志
      console.warn(`[Database] ${operationName} 失败，将在 ${currentDelay}ms 后重试:`, {
        error: error.message,
        code: error.code,
        attempt,
        remainingRetries: maxRetries - attempt + 1
      })

      // 等待后重试
      await new Promise(resolve => setTimeout(resolve, currentDelay))

      // 指数退避
      currentDelay *= CONNECTION_RETRY_CONFIG.RETRY_BACKOFF_MULTIPLIER
    }
  }

  // 理论上不会到达这里，但为了类型安全
  throw lastError
}

// 连接池统计数据
const poolStats = {
  totalConnections: 0,
  activeConnections: 0,
  idleConnections: 0,
  waitingRequests: 0,
  connectionCreated: 0,
  connectionAcquired: 0,
  connectionReleased: 0,
  connectionEnqueued: 0,
  connectionRetryAttempts: 0,
  connectionRetrySuccess: 0,
  connectionRetryExhausted: 0,
  lastHealthCheck: null,
  lastHealthStatus: null,
  // 分布式锁相关统计
  distributedLock: {
    acquireAttempts: 0,
    acquireSuccess: 0,
    acquireFailed: 0,
    releaseAttempts: 0,
    releaseSuccess: 0,
    releaseFailed: 0,
    lockTimeouts: 0,
    totalWaitTimeMs: 0,
    avgWaitTimeMs: 0
  },
  // 并发控制相关统计
  concurrency: {
    roundRobinUpdates: 0,
    roundRobinLockWaitTimeMs: 0,
    versionConflicts: 0,
    versionConflictRetries: 0,
    versionConflictRetriesSuccess: 0
  }
}

/**
 * 更新分布式锁统计
 * @param {string} operation - 操作类型: 'acquire_attempt', 'acquire_success', 'acquire_failed', 'release_attempt', 'release_success', 'release_failed', 'timeout'
 * @param {number} waitTimeMs - 等待时间（毫秒）
 */
export function updateLockStats(operation, waitTimeMs = 0) {
  switch (operation) {
    case 'acquire_attempt':
      poolStats.distributedLock.acquireAttempts++
      break
    case 'acquire_success':
      poolStats.distributedLock.acquireSuccess++
      poolStats.distributedLock.totalWaitTimeMs += waitTimeMs
      // 计算平均等待时间
      if (poolStats.distributedLock.acquireSuccess > 0) {
        poolStats.distributedLock.avgWaitTimeMs =
          poolStats.distributedLock.totalWaitTimeMs / poolStats.distributedLock.acquireSuccess
      }
      break
    case 'acquire_failed':
      poolStats.distributedLock.acquireFailed++
      break
    case 'release_attempt':
      poolStats.distributedLock.releaseAttempts++
      break
    case 'release_success':
      poolStats.distributedLock.releaseSuccess++
      break
    case 'release_failed':
      poolStats.distributedLock.releaseFailed++
      break
    case 'timeout':
      poolStats.distributedLock.lockTimeouts++
      break
  }
}

/**
 * 更新并发控制统计
 * @param {string} operation - 操作类型
 * @param {number} value - 数值（可选）
 */
export function updateConcurrencyStats(operation, value = 1) {
  switch (operation) {
    case 'round_robin_update':
      poolStats.concurrency.roundRobinUpdates += value
      break
    case 'round_robin_lock_wait':
      poolStats.concurrency.roundRobinLockWaitTimeMs += value
      break
    case 'version_conflict':
      poolStats.concurrency.versionConflicts += value
      break
    case 'version_conflict_retry':
      poolStats.concurrency.versionConflictRetries += value
      break
    case 'version_conflict_retry_success':
      poolStats.concurrency.versionConflictRetriesSuccess += value
      break
  }
}

/**
 * 获取分布式锁统计
 * @returns {object} 锁统计数据
 */
export function getLockStats() {
  return { ...poolStats.distributedLock }
}

/**
 * 获取并发控制统计
 * @returns {object} 并发控制统计数据
 */
export function getConcurrencyStats() {
  return { ...poolStats.concurrency }
}

// 设置连接池事件监听
function setupPoolEventListeners() {
  const poolInternal = pool.pool

  if (poolInternal) {
    // 监听连接创建事件
    poolInternal.on('connection', (connection) => {
      poolStats.connectionCreated++
      poolStats.totalConnections++
      console.log('[Database] 新连接创建，当前总连接数:', poolStats.totalConnections)
    })

    // 监听连接获取事件
    poolInternal.on('acquire', (connection) => {
      poolStats.connectionAcquired++
      poolStats.activeConnections++
      poolStats.idleConnections = Math.max(0, poolStats.idleConnections - 1)
    })

    // 监听连接释放事件
    poolInternal.on('release', (connection) => {
      poolStats.connectionReleased++
      poolStats.activeConnections = Math.max(0, poolStats.activeConnections - 1)
      poolStats.idleConnections++
    })

    // 监听连接等待队列事件
    poolInternal.on('enqueue', () => {
      poolStats.connectionEnqueued++
      poolStats.waitingRequests++
      console.log('[Database] 连接请求进入等待队列，当前等待数:', poolStats.waitingRequests)
    })
  }
}

// 初始化事件监听
setupPoolEventListeners()

/**
 * 检查数据库连接健康状态
 * @returns {Promise<{healthy: boolean, latency: number, error?: string, details?: object}>}
 */
export async function checkDatabaseHealth() {
  const startTime = Date.now()

  try {
    // 使用带重试的连接获取
    const conn = await getConnectionWithRetry({ operationName: 'healthCheck' })
    try {
      // 执行简单查询测试连接
      const [rows] = await conn.query('SELECT 1 as health_check')
      const latency = Date.now() - startTime

      // 获取数据库版本信息
      const [versionRows] = await conn.query('SELECT VERSION() as version')
      const version = versionRows[0]?.version || 'unknown'

      // 获取连接状态
      const [statusRows] = await conn.query('SHOW STATUS LIKE "Threads_connected"')
      const threadsConnected = statusRows[0]?.Value || 0

      const result = {
        healthy: true,
        latency,
        details: {
          version,
          threadsConnected: parseInt(threadsConnected),
          poolConfig: {
            connectionLimit: dbConfig.connectionLimit,
            maxIdle: dbConfig.maxIdle
          }
        }
      }

      poolStats.lastHealthCheck = new Date().toISOString()
      poolStats.lastHealthStatus = result

      return result
    } finally {
      conn.release()
    }
  } catch (error) {
    const latency = Date.now() - startTime
    const result = {
      healthy: false,
      latency,
      error: error.message,
      details: {
        code: error.code,
        errno: error.errno
      }
    }

    poolStats.lastHealthCheck = new Date().toISOString()
    poolStats.lastHealthStatus = result

    console.error('[Database] 健康检查失败:', error.message)
    return result
  }
}

/**
 * 获取连接池统计信息
 * @returns {object} 连接池状态统计
 */
export function getPoolStats() {
  const poolInternal = pool.pool

  // 尝试从内部池获取实时数据
  let realTimeStats = {}
  if (poolInternal) {
    try {
      realTimeStats = {
        _freeConnections: poolInternal._freeConnections?.length || 0,
        _allConnections: poolInternal._allConnections?.length || 0,
        _connectionQueue: poolInternal._connectionQueue?.length || 0
      }
    } catch (e) {
      // 忽略获取内部状态的错误
    }
  }

  return {
    ...poolStats,
    realTime: realTimeStats,
    config: {
      connectionLimit: dbConfig.connectionLimit,
      maxIdle: dbConfig.maxIdle,
      acquireTimeout: dbConfig.acquireTimeout,
      connectTimeout: dbConfig.connectTimeout,
      idleTimeout: dbConfig.idleTimeout
    },
    // 包含分布式锁和并发控制统计
    distributedLock: { ...poolStats.distributedLock },
    concurrency: { ...poolStats.concurrency }
  }
}

/**
 * 重置连接池统计（用于测试或监控重置）
 */
export function resetPoolStats() {
  poolStats.connectionCreated = 0
  poolStats.connectionAcquired = 0
  poolStats.connectionReleased = 0
  poolStats.connectionEnqueued = 0
  poolStats.connectionRetryAttempts = 0
  poolStats.connectionRetrySuccess = 0
  poolStats.connectionRetryExhausted = 0

  // 重置分布式锁统计
  poolStats.distributedLock = {
    acquireAttempts: 0,
    acquireSuccess: 0,
    acquireFailed: 0,
    releaseAttempts: 0,
    releaseSuccess: 0,
    releaseFailed: 0,
    lockTimeouts: 0,
    totalWaitTimeMs: 0,
    avgWaitTimeMs: 0
  }

  // 重置并发控制统计
  poolStats.concurrency = {
    roundRobinUpdates: 0,
    roundRobinLockWaitTimeMs: 0,
    versionConflicts: 0,
    versionConflictRetries: 0,
    versionConflictRetriesSuccess: 0
  }

  console.log('[Database] 连接池统计已重置')
}

/**
 * 优雅关闭连接池
 * @returns {Promise<void>}
 */
export async function closePool() {
  try {
    await pool.end()
    console.log('[Database] 连接池已关闭')
  } catch (error) {
    console.error('[Database] 关闭连接池失败:', error.message)
    throw error
  }
}

// 获取数据库名称
export function getDbName() {
  return process.env.DB_NAME || 'kiro'
}

export default pool
