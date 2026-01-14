/**
 * 统一错误处理工具模块
 * 提供标准化的错误分类、响应构造、事务管理和重试机制
 */

import { getConnectionWithRetry } from '../config/database.js'

// 错误类型枚举
export const ErrorType = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',     // 参数验证错误
  DATABASE_ERROR: 'DATABASE_ERROR',         // 数据库错误
  NETWORK_ERROR: 'NETWORK_ERROR',           // 网络错误
  AUTH_ERROR: 'AUTH_ERROR',                 // 认证错误
  CONFLICT_ERROR: 'CONFLICT_ERROR',         // 冲突错误（如版本冲突）
  NOT_FOUND: 'NOT_FOUND',                   // 资源未找到
  INTERNAL_ERROR: 'INTERNAL_ERROR'          // 内部错误
}

// 重试配置常量
export const RETRY_CONFIG = {
  MAX_RETRIES: 3,
  RETRY_DELAY_MS: 100,
  RETRY_BACKOFF_MULTIPLIER: 2,
  RETRYABLE_ERRORS: ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT', 1213, 1205]
}

// 重试统计数据
const retryStats = {
  totalRetries: 0,
  successfulRetries: 0,
  failedAfterRetries: 0,
  retryCountByOperation: {},
  lastRetryTime: null
}

// HTTP状态码映射
export const ErrorStatusCode = {
  [ErrorType.VALIDATION_ERROR]: 400,
  [ErrorType.DATABASE_ERROR]: 500,
  [ErrorType.NETWORK_ERROR]: 503,
  [ErrorType.AUTH_ERROR]: 401,
  [ErrorType.CONFLICT_ERROR]: 409,
  [ErrorType.NOT_FOUND]: 404,
  [ErrorType.INTERNAL_ERROR]: 500
}

/**
 * 创建标准化错误响应
 * @param {string} errorType - 错误类型（来自ErrorType枚举）
 * @param {string} message - 错误消息
 * @param {object} details - 可选的错误详情
 * @returns {object} 标准化错误响应对象
 */
export function createErrorResponse(errorType, message, details = null) {
  const response = {
    success: false,
    error: errorType,
    message: message
  }
  
  if (details) {
    response.details = details
  }
  
  return response
}

/**
 * 创建标准化成功响应
 * @param {any} data - 响应数据
 * @param {string} message - 可选的成功消息
 * @returns {object} 标准化成功响应对象
 */
export function createSuccessResponse(data, message = null) {
  const response = {
    success: true,
    data: data
  }
  
  if (message) {
    response.message = message
  }
  
  return response
}

/**
 * 检查错误是否为可重试类型（死锁、锁等待超时）
 * @param {Error} error - 错误对象
 * @returns {boolean} 是否可重试
 */
export function isRetryableError(error) {
  const code = error.code || error.errno
  return RETRY_CONFIG.RETRYABLE_ERRORS.includes(code) ||
         RETRY_CONFIG.RETRYABLE_ERRORS.includes(String(code))
}

/**
 * 延迟函数
 * @param {number} ms - 延迟毫秒数
 * @returns {Promise<void>}
 */
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 带重试的操作包装器
 * @param {function} operation - 要执行的异步函数
 * @param {object} options - 配置选项
 * @param {number} options.maxRetries - 最大重试次数
 * @param {number} options.retryDelay - 初始重试延迟（毫秒）
 * @param {function} options.logger - 日志记录函数
 * @param {string} options.operationName - 操作名称（用于日志）
 * @param {function} options.shouldRetry - 自定义重试判断函数
 * @returns {Promise<any>} 操作结果
 */
export async function withRetry(operation, options = {}) {
  const {
    maxRetries = RETRY_CONFIG.MAX_RETRIES,
    retryDelay = RETRY_CONFIG.RETRY_DELAY_MS,
    logger = null,
    operationName = 'unknown',
    shouldRetry = isRetryableError
  } = options
  
  let lastError = null
  let currentDelay = retryDelay
  
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    try {
      const result = await operation()
      
      // 如果是重试后成功，记录统计
      if (attempt > 1) {
        retryStats.successfulRetries++
        retryStats.lastRetryTime = new Date().toISOString()
        
        if (logger) {
          logger({
            action: 'retry_success',
            message: `操作 ${operationName} 在第 ${attempt} 次尝试后成功`,
            level: 'info',
            details: { attempt, operationName }
          })
        }
        
        console.log(`[Retry] ${operationName} 在第 ${attempt} 次尝试后成功`)
      }
      
      return result
    } catch (error) {
      lastError = error
      
      // 检查是否应该重试
      if (attempt <= maxRetries && shouldRetry(error)) {
        retryStats.totalRetries++
        retryStats.retryCountByOperation[operationName] =
          (retryStats.retryCountByOperation[operationName] || 0) + 1
        
        const errorCode = error.code || error.errno || 'UNKNOWN'
        
        if (logger) {
          logger({
            action: 'retry_attempt',
            message: `操作 ${operationName} 失败，将在 ${currentDelay}ms 后重试 (${attempt}/${maxRetries})`,
            level: 'warn',
            details: {
              attempt,
              maxRetries,
              errorCode,
              errorMessage: error.message,
              nextDelay: currentDelay
            }
          })
        }
        
        console.warn(`[Retry] ${operationName} 失败 (${errorCode})，将在 ${currentDelay}ms 后重试 (${attempt}/${maxRetries})`)
        
        // 等待后重试
        await delay(currentDelay)
        
        // 指数退避
        currentDelay *= RETRY_CONFIG.RETRY_BACKOFF_MULTIPLIER
      } else {
        // 不可重试或已达最大重试次数
        if (attempt > 1) {
          retryStats.failedAfterRetries++
          
          if (logger) {
            logger({
              action: 'retry_exhausted',
              message: `操作 ${operationName} 在 ${attempt - 1} 次重试后仍然失败`,
              level: 'error',
              details: {
                totalAttempts: attempt,
                errorCode: error.code || error.errno,
                errorMessage: error.message
              }
            })
          }
          
          console.error(`[Retry] ${operationName} 在 ${attempt - 1} 次重试后仍然失败`)
        }
        break
      }
    }
  }
  
  // 增强错误对象
  const enhancedError = new Error(lastError.message)
  enhancedError.originalError = lastError
  enhancedError.code = lastError.code
  enhancedError.errno = lastError.errno
  enhancedError.retryAttempts = retryStats.retryCountByOperation[operationName] || 0
  enhancedError.operationName = operationName
  
  throw enhancedError
}

/**
 * 获取重试统计信息
 * @returns {object} 重试统计数据
 */
export function getRetryStats() {
  return {
    ...retryStats,
    successRate: retryStats.totalRetries > 0
      ? (retryStats.successfulRetries / retryStats.totalRetries * 100).toFixed(2) + '%'
      : 'N/A'
  }
}

/**
 * 重置重试统计（用于测试或监控重置）
 */
export function resetRetryStats() {
  retryStats.totalRetries = 0
  retryStats.successfulRetries = 0
  retryStats.failedAfterRetries = 0
  retryStats.retryCountByOperation = {}
  retryStats.lastRetryTime = null
  console.log('[Retry] 重试统计已重置')
}

/**
 * 根据MySQL错误码分类数据库错误
 * @param {Error} error - 数据库错误对象
 * @returns {string} 错误类型
 */
export function classifyDatabaseError(error) {
  const code = error.code || error.errno
  
  // MySQL错误码分类
  switch (code) {
    // 重复键错误
    case 'ER_DUP_ENTRY':
    case 1062:
      return ErrorType.CONFLICT_ERROR
    
    // 死锁错误
    case 'ER_LOCK_DEADLOCK':
    case 1213:
      return ErrorType.CONFLICT_ERROR
    
    // 锁等待超时
    case 'ER_LOCK_WAIT_TIMEOUT':
    case 1205:
      return ErrorType.CONFLICT_ERROR
    
    // 外键约束错误
    case 'ER_NO_REFERENCED_ROW':
    case 'ER_NO_REFERENCED_ROW_2':
    case 1216:
    case 1452:
      return ErrorType.VALIDATION_ERROR
    
    // 连接错误
    case 'ECONNREFUSED':
    case 'ENOTFOUND':
    case 'ETIMEDOUT':
    case 'PROTOCOL_CONNECTION_LOST':
    case 'ER_CON_COUNT_ERROR':
      return ErrorType.DATABASE_ERROR
    
    // 语法错误
    case 'ER_PARSE_ERROR':
    case 1064:
      return ErrorType.INTERNAL_ERROR
    
    // 表不存在
    case 'ER_NO_SUCH_TABLE':
    case 1146:
      return ErrorType.INTERNAL_ERROR
    
    // 列不存在
    case 'ER_BAD_FIELD_ERROR':
    case 1054:
      return ErrorType.INTERNAL_ERROR
    
    default:
      return ErrorType.DATABASE_ERROR
  }
}

/**
 * 获取数据库错误的用户友好消息
 * @param {Error} error - 数据库错误对象
 * @param {string} errorType - 已分类的错误类型
 * @returns {string} 用户友好的错误消息
 */
export function getDatabaseErrorMessage(error, errorType) {
  switch (errorType) {
    case ErrorType.CONFLICT_ERROR:
      if (error.code === 'ER_DUP_ENTRY' || error.errno === 1062) {
        return '数据已存在，请检查是否重复'
      }
      if (error.code === 'ER_LOCK_DEADLOCK' || error.errno === 1213) {
        return '数据库操作冲突，请重试'
      }
      if (error.code === 'ER_LOCK_WAIT_TIMEOUT' || error.errno === 1205) {
        return '数据库操作超时，请重试'
      }
      return '数据冲突，请刷新后重试'
    
    case ErrorType.VALIDATION_ERROR:
      return '数据验证失败，请检查输入'
    
    case ErrorType.DATABASE_ERROR:
      return '数据库连接失败，请稍后重试'
    
    case ErrorType.INTERNAL_ERROR:
      return '内部错误，请联系管理员'
    
    default:
      return error.message || '未知数据库错误'
  }
}

/**
 * 事务包装器 - 自动处理连接获取、事务开启、提交和回滚
 * 支持死锁自动重试
 * @param {object} pool - 数据库连接池
 * @param {function} callback - 事务回调函数，接收connection参数
 * @param {object} options - 可选配置
 * @param {object} options.logger - 日志记录器
 * @param {string} options.operation - 操作名称（用于日志）
 * @param {boolean} options.enableRetry - 是否启用死锁重试（默认true）
 * @param {number} options.maxRetries - 最大重试次数（默认3）
 * @returns {Promise<object>} 包含success和data/error的结果对象
 */
export async function withTransaction(pool, callback, options = {}) {
  const {
    logger = null,
    operation = 'unknown',
    enableRetry = true,
    maxRetries = RETRY_CONFIG.MAX_RETRIES
  } = options
  
  // 定义单次事务执行函数
  const executeTransaction = async () => {
    let conn = null
    
    try {
      conn = await getConnectionWithRetry({ operationName: `transaction:${operation}` })
      await conn.beginTransaction()
      
      const result = await callback(conn)
      
      await conn.commit()
      
      if (logger) {
        logger.logSystem({
          action: 'transaction_success',
          message: `事务成功完成: ${operation}`,
          level: 'info'
        })
      }
      
      return { success: true, data: result }
    } catch (error) {
      if (conn) {
        try {
          await conn.rollback()
          if (logger) {
            logger.logSystem({
              action: 'transaction_rollback',
              message: `事务回滚: ${operation}`,
              level: 'warn',
              details: { error: error.message, code: error.code }
            })
          }
        } catch (rollbackError) {
          console.error('[Transaction] Rollback failed:', rollbackError)
          if (logger) {
            logger.logSystem({
              action: 'transaction_rollback_failed',
              message: `事务回滚失败: ${operation}`,
              level: 'error',
              details: { error: rollbackError.message }
            })
          }
        }
      }
      
      // 重新抛出错误，让重试机制处理
      throw error
    } finally {
      if (conn) {
        conn.release()
      }
    }
  }
  
  // 如果启用重试，使用withRetry包装
  if (enableRetry) {
    try {
      return await withRetry(executeTransaction, {
        maxRetries,
        operationName: `transaction:${operation}`,
        logger: logger ? (log) => logger.logSystem(log) : null,
        shouldRetry: isRetryableError
      })
    } catch (error) {
      // 重试失败后，构造标准化错误响应
      const errorType = classifyDatabaseError(error.originalError || error)
      const userMessage = getDatabaseErrorMessage(error.originalError || error, errorType)
      
      console.error(`[Transaction] ${operation} failed after retries:`, error.message, {
        code: error.code,
        retryAttempts: error.retryAttempts
      })
      
      const errorResponse = createErrorResponse(errorType, userMessage, {
        code: error.code,
        operation: operation,
        originalMessage: error.message,
        retryAttempts: error.retryAttempts
      })
      
      const enhancedError = new Error(userMessage)
      enhancedError.errorResponse = errorResponse
      enhancedError.statusCode = ErrorStatusCode[errorType]
      enhancedError.retryAttempts = error.retryAttempts
      throw enhancedError
    }
  } else {
    // 不启用重试，直接执行
    try {
      return await executeTransaction()
    } catch (error) {
      const errorType = classifyDatabaseError(error)
      const userMessage = getDatabaseErrorMessage(error, errorType)
      
      console.error(`[Transaction] ${operation} failed:`, error.message, { code: error.code })
      
      const errorResponse = createErrorResponse(errorType, userMessage, {
        code: error.code,
        operation: operation,
        originalMessage: error.message
      })
      
      const enhancedError = new Error(userMessage)
      enhancedError.errorResponse = errorResponse
      enhancedError.statusCode = ErrorStatusCode[errorType]
      throw enhancedError
    }
  }
}

/**
 * 简单查询包装器 - 用于非事务性查询
 * @param {object} pool - 数据库连接池
 * @param {function} callback - 查询回调函数，接收connection参数
 * @param {object} options - 可选配置
 * @returns {Promise<object>} 包含success和data/error的结果对象
 */
export async function withConnection(pool, callback, options = {}) {
  const { logger = null, operation = 'unknown' } = options
  let conn = null
  
  try {
    conn = await getConnectionWithRetry({ operationName: `query:${operation}` })
    const result = await callback(conn)
    return { success: true, data: result }
  } catch (error) {
    const errorType = classifyDatabaseError(error)
    const userMessage = getDatabaseErrorMessage(error, errorType)
    
    console.error(`[Query] ${operation} failed:`, error.message, { code: error.code })
    
    if (logger) {
      logger.logSystem({
        action: 'query_failed',
        message: `查询失败: ${operation}`,
        level: 'error',
        details: { error: error.message, code: error.code }
      })
    }
    
    return {
      success: false,
      error: createErrorResponse(errorType, userMessage, {
        code: error.code,
        operation: operation
      }),
      statusCode: ErrorStatusCode[errorType]
    }
  } finally {
    if (conn) {
      conn.release()
    }
  }
}

/**
 * 发送标准化错误响应
 * @param {object} res - Express响应对象
 * @param {string} errorType - 错误类型
 * @param {string} message - 错误消息
 * @param {object} details - 可选的错误详情
 */
export function sendErrorResponse(res, errorType, message, details = null) {
  const statusCode = ErrorStatusCode[errorType] || 500
  const response = createErrorResponse(errorType, message, details)
  res.status(statusCode).json(response)
}

/**
 * 发送标准化成功响应
 * @param {object} res - Express响应对象
 * @param {any} data - 响应数据
 * @param {string} message - 可选的成功消息
 * @param {number} statusCode - HTTP状态码，默认200
 */
export function sendSuccessResponse(res, data, message = null, statusCode = 200) {
  const response = createSuccessResponse(data, message)
  res.status(statusCode).json(response)
}

/**
 * 验证必需字段
 * @param {object} data - 要验证的数据对象
 * @param {string[]} requiredFields - 必需字段列表
 * @returns {object|null} 如果验证失败返回错误响应，否则返回null
 */
export function validateRequiredFields(data, requiredFields) {
  const missingFields = requiredFields.filter(field => {
    const value = data[field]
    return value === undefined || value === null || value === ''
  })
  
  if (missingFields.length > 0) {
    return createErrorResponse(
      ErrorType.VALIDATION_ERROR,
      `缺少必需字段: ${missingFields.join(', ')}`,
      { missingFields }
    )
  }
  
  return null
}

/**
 * 验证数组长度
 * @param {any[]} array - 要验证的数组
 * @param {string} fieldName - 字段名称
 * @param {object} options - 验证选项
 * @param {number} options.min - 最小长度
 * @param {number} options.max - 最大长度
 * @returns {object|null} 如果验证失败返回错误响应，否则返回null
 */
export function validateArrayLength(array, fieldName, options = {}) {
  const { min = 0, max = Infinity } = options
  
  if (!Array.isArray(array)) {
    return createErrorResponse(
      ErrorType.VALIDATION_ERROR,
      `${fieldName} 必须是数组`,
      { field: fieldName }
    )
  }
  
  if (array.length < min) {
    return createErrorResponse(
      ErrorType.VALIDATION_ERROR,
      `${fieldName} 至少需要 ${min} 个元素`,
      { field: fieldName, min, actual: array.length }
    )
  }
  
  if (array.length > max) {
    return createErrorResponse(
      ErrorType.VALIDATION_ERROR,
      `${fieldName} 最多允许 ${max} 个元素`,
      { field: fieldName, max, actual: array.length }
    )
  }
  
  return null
}

// 错误统计数据
const errorStats = {
  totalErrors: 0,
  errorsByType: {},
  errorsByOperation: {},
  recentErrors: [], // 最近100个错误
  alertThresholds: {
    deadlockPerMinute: 10,
    connectionErrorPerMinute: 5
  },
  alertCounts: {
    deadlock: [],
    connectionError: []
  }
}

/**
 * 记录错误统计
 * @param {string} errorType - 错误类型
 * @param {string} operation - 操作名称
 * @param {Error} error - 错误对象
 */
export function recordErrorStats(errorType, operation, error) {
  const now = Date.now()
  
  errorStats.totalErrors++
  errorStats.errorsByType[errorType] = (errorStats.errorsByType[errorType] || 0) + 1
  errorStats.errorsByOperation[operation] = (errorStats.errorsByOperation[operation] || 0) + 1
  
  // 记录最近错误（保留最近100个）
  errorStats.recentErrors.push({
    type: errorType,
    operation,
    message: error.message,
    code: error.code,
    timestamp: new Date().toISOString()
  })
  
  if (errorStats.recentErrors.length > 100) {
    errorStats.recentErrors.shift()
  }
  
  // 检查死锁告警
  if (error.code === 'ER_LOCK_DEADLOCK' || error.errno === 1213) {
    errorStats.alertCounts.deadlock.push(now)
    // 清理1分钟前的记录
    errorStats.alertCounts.deadlock = errorStats.alertCounts.deadlock.filter(
      t => now - t < 60000
    )
    
    if (errorStats.alertCounts.deadlock.length >= errorStats.alertThresholds.deadlockPerMinute) {
      console.error('[ALERT] 死锁频率过高！最近1分钟内发生',
        errorStats.alertCounts.deadlock.length, '次死锁')
    }
  }
  
  // 检查连接错误告警
  if (['ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT', 'PROTOCOL_CONNECTION_LOST'].includes(error.code)) {
    errorStats.alertCounts.connectionError.push(now)
    errorStats.alertCounts.connectionError = errorStats.alertCounts.connectionError.filter(
      t => now - t < 60000
    )
    
    if (errorStats.alertCounts.connectionError.length >= errorStats.alertThresholds.connectionErrorPerMinute) {
      console.error('[ALERT] 数据库连接错误频率过高！最近1分钟内发生',
        errorStats.alertCounts.connectionError.length, '次连接错误')
    }
  }
}

/**
 * 获取错误统计信息
 * @returns {object} 错误统计数据
 */
export function getErrorStats() {
  return {
    ...errorStats,
    // 计算最常见的错误类型
    mostCommonErrorType: Object.entries(errorStats.errorsByType)
      .sort((a, b) => b[1] - a[1])[0] || ['N/A', 0],
    // 计算最常见的错误操作
    mostCommonErrorOperation: Object.entries(errorStats.errorsByOperation)
      .sort((a, b) => b[1] - a[1])[0] || ['N/A', 0]
  }
}

/**
 * 重置错误统计（用于测试或监控重置）
 */
export function resetErrorStats() {
  errorStats.totalErrors = 0
  errorStats.errorsByType = {}
  errorStats.errorsByOperation = {}
  errorStats.recentErrors = []
  errorStats.alertCounts.deadlock = []
  errorStats.alertCounts.connectionError = []
  console.log('[Error] 错误统计已重置')
}

/**
 * 生成唯一请求ID
 * @returns {string} 请求ID
 */
export function generateRequestId() {
  return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
}

export default {
  ErrorType,
  ErrorStatusCode,
  RETRY_CONFIG,
  createErrorResponse,
  createSuccessResponse,
  classifyDatabaseError,
  getDatabaseErrorMessage,
  isRetryableError,
  withRetry,
  getRetryStats,
  resetRetryStats,
  withTransaction,
  withConnection,
  sendErrorResponse,
  sendSuccessResponse,
  validateRequiredFields,
  validateArrayLength,
  recordErrorStats,
  getErrorStats,
  resetErrorStats,
  generateRequestId
}