/**
 * 账号 API v2 路由
 *
 * 提供带版本控制的账号 CRUD 接口：
 * - GET /api/v2/accounts - 获取账号列表（支持分页、过滤、排序）
 * - GET /api/v2/accounts/:id - 获取单个账号详情
 * - POST /api/v2/accounts - 创建新账号
 * - PUT /api/v2/accounts/:id - 更新账号（带版本控制）
 * - DELETE /api/v2/accounts/:id - 软删除账号
 * - POST /api/v2/accounts/batch - 批量操作接口（支持灵活回滚策略）
 */

import { Router } from 'express'
import { pool, getConnectionWithRetry } from '../config/database.js'
import { rowToAccount, insertAccount, clearActiveAccountIfMatch } from '../models/account.js'
import {
  ErrorType,
  createErrorResponse,
  createSuccessResponse,
  sendErrorResponse,
  sendSuccessResponse,
  classifyDatabaseError,
  getDatabaseErrorMessage,
  validateRequiredFields,
  generateRequestId
} from '../utils/error-handler.js'
import {
  validateRequest,
  accountCreateSchema,
  accountUpdateSchema,
  accountBatchSchema,
  accountListQuerySchema,
  idParamSchema
} from '../validators/schemas.js'

const router = Router()

// 批量操作回滚策略枚举
const RollbackStrategy = {
  NONE: 'none',           // 不回滚，部分成功部分失败
  ALL: 'all',             // 任何失败都回滚所有操作
  FAILED_ONLY: 'failed-only'  // 只回滚失败的操作（使用保存点）
}

// 批量操作配置
const BATCH_CONFIG = {
  MAX_OPERATIONS: 100,
  BULK_THRESHOLD: 50  // 超过此数量使用批量SQL优化
}

// 版本冲突重试配置
const VERSION_RETRY_CONFIG = {
  MAX_RETRIES: 3,
  BASE_DELAY_MS: 100,
  MAX_DELAY_MS: 2000,
  BACKOFF_MULTIPLIER: 2
}

/**
 * 计算指数退避延迟时间
 * @param {number} attempt - 当前重试次数（从0开始）
 * @returns {number} 延迟毫秒数
 */
function calculateBackoffDelay(attempt) {
  const delay = VERSION_RETRY_CONFIG.BASE_DELAY_MS * Math.pow(VERSION_RETRY_CONFIG.BACKOFF_MULTIPLIER, attempt)
  // 添加随机抖动（±50ms）
  const jitter = Math.random() * 100 - 50
  return Math.min(delay + jitter, VERSION_RETRY_CONFIG.MAX_DELAY_MS)
}

/**
 * 延迟函数
 * @param {number} ms - 延迟毫秒数
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * 检查是否为版本冲突错误
 * @param {object} result - 操作结果
 * @returns {boolean}
 */
function isVersionConflict(result) {
  return result && !result.success &&
         result.errorType === ErrorType.CONFLICT_ERROR &&
         result.conflictReason === 'modified_by_other_client' &&
         result.retryable === true
}

/**
 * 获取账号列表
 * 
 * GET /api/v2/accounts
 * 
 * 查询参数:
 * - page: 页码（默认 1）
 * - pageSize: 每页数量（默认 50，最大 200）
 * - fields: 字段过滤（逗号分隔，如 "id,email,usage"）
 * - includeDeleted: 是否包含已删除账号（默认 false）
 * - modifiedSince: 增量查询时间戳（毫秒）
 * - groupId: 按分组过滤
 * - tagId: 按标签过滤
 * - status: 按状态过滤（active/banned/expired）
 * - search: 搜索关键词（匹配 email 或 nickname）
 * - sortBy: 排序字段（createdAt/lastUsedAt/email，默认 createdAt）
 * - sortOrder: 排序方向（asc/desc，默认 desc）
 */
router.get('/api/v2/accounts', validateRequest(accountListQuerySchema, 'query'), async (req, res) => {
  try {
    // 解析分页参数（已通过验证中间件处理默认值）
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50))
    const offset = (page - 1) * pageSize
    
    // 解析过滤参数
    const includeDeleted = req.query.includeDeleted === 'true'
    const modifiedSince = parseInt(req.query.modifiedSince) || null
    const groupId = req.query.groupId || null
    const tagId = req.query.tagId || null
    const status = req.query.status || null
    const search = req.query.search || null
    
    // 解析排序参数
    const validSortFields = ['created_at', 'last_used_at', 'email', 'updated_at']
    const sortByMap = {
      'createdAt': 'created_at',
      'lastUsedAt': 'last_used_at',
      'email': 'email',
      'updatedAt': 'updated_at'
    }
    const sortBy = sortByMap[req.query.sortBy] || 'created_at'
    const sortOrder = req.query.sortOrder === 'asc' ? 'ASC' : 'DESC'
    
    // 解析字段过滤参数
    const fieldsParam = req.query.fields
    const requestedFields = fieldsParam ? fieldsParam.split(',').map(f => f.trim()) : null
    
    // 构建查询条件
    const conditions = []
    const params = []
    
    if (!includeDeleted) {
      conditions.push('(is_del = FALSE OR is_del IS NULL)')
    }
    
    if (modifiedSince) {
      conditions.push('updated_at > ?')
      params.push(modifiedSince)
    }
    
    if (groupId) {
      conditions.push('group_id = ?')
      params.push(groupId)
    }
    
    if (tagId) {
      conditions.push('JSON_CONTAINS(tags, ?)')
      params.push(JSON.stringify(tagId))
    }
    
    if (status && status !== 'all') {
      conditions.push('status = ?')
      params.push(status)
    }
    
    if (search) {
      conditions.push('(email LIKE ? OR nickname LIKE ?)')
      const searchPattern = `%${search}%`
      params.push(searchPattern, searchPattern)
    }
    
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    
    // 查询总数
    const countQuery = `SELECT COUNT(*) as total FROM accounts ${whereClause}`
    const [countResult] = await pool.query(countQuery, params)
    const total = countResult[0].total
    
    // 查询数据
    const dataQuery = `
      SELECT * FROM accounts 
      ${whereClause}
      ORDER BY ${sortBy} ${sortOrder}
      LIMIT ? OFFSET ?
    `
    const [rows] = await pool.query(dataQuery, [...params, pageSize, offset])
    
    // 转换数据格式
    let accounts = rows.map(row => {
      const account = rowToAccount(row)
      // 添加版本控制字段
      account.version = row.version || 1
      account.updatedAt = row.updated_at || row.created_at || Date.now()
      return account
    })
    
    // 字段过滤
    if (requestedFields && requestedFields.length > 0) {
      accounts = accounts.map(account => {
        const filtered = {}
        for (const field of requestedFields) {
          if (account.hasOwnProperty(field)) {
            filtered[field] = account[field]
          }
        }
        // 始终包含 id 和版本信息
        filtered.id = account.id
        filtered.version = account.version
        filtered.updatedAt = account.updatedAt
        return filtered
      })
    }
    
    // 计算分页信息
    const totalPages = Math.ceil(total / pageSize)
    
    sendSuccessResponse(res, {
      accounts,
      pagination: {
        page,
        pageSize,
        total,
        totalPages,
        hasNext: page < totalPages
      },
      serverTime: Date.now()
    })
    
  } catch (error) {
    console.error('[Accounts V2] Get accounts error:', error.message, { code: error.code })
    const errorType = classifyDatabaseError(error)
    const userMessage = getDatabaseErrorMessage(error, errorType)
    sendErrorResponse(res, errorType, userMessage, {
      operation: 'get_accounts',
      code: error.code
    })
  }
})

/**
 * 获取单个账号详情
 * 
 * GET /api/v2/accounts/:id
 */
router.get('/api/v2/accounts/:id', validateRequest(idParamSchema, 'params'), async (req, res) => {
  try {
    const { id } = req.params
    
    const [rows] = await pool.query('SELECT * FROM accounts WHERE id = ?', [id])
    
    if (rows.length === 0) {
      return sendErrorResponse(res, ErrorType.NOT_FOUND, '账号不存在', {
        operation: 'get_account',
        accountId: id
      })
    }
    
    const row = rows[0]
    const account = rowToAccount(row)
    // 添加版本控制字段
    account.version = row.version || 1
    account.updatedAt = row.updated_at || row.created_at || Date.now()
    
    sendSuccessResponse(res, account)
    
  } catch (error) {
    console.error('[Accounts V2] Get account error:', error.message, { code: error.code })
    const errorType = classifyDatabaseError(error)
    const userMessage = getDatabaseErrorMessage(error, errorType)
    sendErrorResponse(res, errorType, userMessage, {
      operation: 'get_account',
      accountId: req.params.id,
      code: error.code
    })
  }
})

/**
 * 创建新账号
 * 
 * POST /api/v2/accounts
 * 
 * 请求体:
 * {
 *   "id": "account-uuid",
 *   "email": "user@example.com",
 *   "credentials": { ... },
 *   // ... 其他字段
 * }
 */
router.post('/api/v2/accounts', validateRequest(accountCreateSchema, 'body'), async (req, res) => {
  const conn = await getConnectionWithRetry({ operationName: 'create_account_v2' })
  
  try {
    await conn.beginTransaction()
    
    const account = req.body
    
    // 验证已通过joi中间件完成
    
    // 检查账号是否已存在
    const [existing] = await conn.query('SELECT id FROM accounts WHERE id = ?', [account.id])
    if (existing.length > 0) {
      await conn.rollback()
      return sendErrorResponse(res, ErrorType.CONFLICT_ERROR, '账号已存在', {
        operation: 'create_account',
        accountId: account.id,
        conflictReason: 'duplicate_id'
      })
    }
    
    // 检查邮箱是否已存在
    const [existingEmail] = await conn.query('SELECT id FROM accounts WHERE email = ? AND (is_del = FALSE OR is_del IS NULL)', [account.email])
    if (existingEmail.length > 0) {
      await conn.rollback()
      return sendErrorResponse(res, ErrorType.CONFLICT_ERROR, '该邮箱已被其他账号使用', {
        operation: 'create_account',
        email: account.email,
        conflictReason: 'duplicate_email'
      })
    }
    
    const serverTime = Date.now()
    
    // 设置创建时间
    if (!account.createdAt) {
      account.createdAt = serverTime
    }
    
    // 插入账号
    await insertAccount(conn, account.id, account)
    
    // 设置初始版本和更新时间
    await conn.query(
      'UPDATE accounts SET version = 1, updated_at = ? WHERE id = ?',
      [serverTime, account.id]
    )
    
    await conn.commit()
    
    console.log(`[Accounts V2] Account created: ${account.email}`)
    
    res.status(201).json(createSuccessResponse({
      id: account.id,
      version: 1,
      updatedAt: serverTime,
      created: true
    }, '账号创建成功'))
    
  } catch (error) {
    await conn.rollback()
    console.error('[Accounts V2] Create account error:', error.message, { code: error.code })
    const errorType = classifyDatabaseError(error)
    const userMessage = getDatabaseErrorMessage(error, errorType)
    sendErrorResponse(res, errorType, userMessage, {
      operation: 'create_account',
      code: error.code
    })
  } finally {
    conn.release()
  }
})

/**
 * 执行单次更新操作（内部方法，用于重试机制）
 * @param {string} id - 账号ID
 * @param {object} updateData - 更新数据
 * @param {number} clientVersion - 客户端版本号
 * @returns {Promise<object>} 操作结果
 */
async function executeUpdateOperation(id, updateData, clientVersion) {
  const conn = await getConnectionWithRetry({ operationName: 'update_account_v2_internal' })
  
  try {
    await conn.beginTransaction()
    
    // 使用 FOR UPDATE 锁定行，防止并发修改
    const [rows] = await conn.query(
      'SELECT * FROM accounts WHERE id = ? FOR UPDATE',
      [id]
    )
    
    if (rows.length === 0) {
      await conn.rollback()
      return {
        success: false,
        errorType: ErrorType.NOT_FOUND,
        message: '账号不存在'
      }
    }
    
    const currentRow = rows[0]
    const currentVersion = currentRow.version || 1
    const email = currentRow.email
    const idp = currentRow.idp
    
    // 版本冲突检测：直接比较当前账号的版本号
    // 乐观锁机制：检查当前记录（通过 ID 锁定）是否被其他客户端修改
    // 注意：email + idp 唯一索引已在数据库层面保证唯一性，无需跨账号查询版本
    if (currentVersion !== clientVersion) {
      await conn.rollback()
      
      // 返回服务器最新数据
      const serverAccount = rowToAccount(currentRow)
      serverAccount.version = currentVersion
      serverAccount.updatedAt = currentRow.updated_at || currentRow.created_at || Date.now()
      
      return {
        success: false,
        errorType: ErrorType.CONFLICT_ERROR,
        message: `账号 ${email} (${idp}) 已被其他客户端修改`,
        clientVersion,
        currentVersion: currentVersion,
        conflictReason: 'modified_by_other_client',
        retryable: true,
        serverData: serverAccount
      }
    }
    
    const serverTime = Date.now()
    const newVersion = currentVersion + 1
    
    // 合并更新数据（保留原有数据，只更新提供的字段）
    const mergedAccount = {
      ...rowToAccount(currentRow),
      ...updateData,
      id // 确保 ID 不被修改
    }
    
    // 更新账号
    await insertAccount(conn, id, mergedAccount)
    
    // 更新版本号和时间戳（基于 email + idp 的最新版本）
    await conn.query(
      'UPDATE accounts SET version = ?, updated_at = ? WHERE id = ?',
      [newVersion, serverTime, id]
    )
    
    await conn.commit()
    
    return {
      success: true,
      id,
      version: newVersion,
      updatedAt: serverTime,
      email: mergedAccount.email
    }
    
  } catch (error) {
    await conn.rollback()
    throw error
  } finally {
    conn.release()
  }
}

/**
 * 更新账号（带版本控制和自动重试）
 *
 * PUT /api/v2/accounts/:id
 *
 * 请求体:
 * {
 *   "version": 5,
 *   "email": "newemail@example.com",
 *   // ... 要更新的字段
 * }
 *
 * 版本冲突时会自动重试（最多3次），如果仍然失败则返回 409 状态码和服务器最新数据
 */
router.put('/api/v2/accounts/:id', validateRequest(idParamSchema, 'params'), validateRequest(accountUpdateSchema, 'body'), async (req, res) => {
  const { id } = req.params
  const updateData = req.body
  let clientVersion = updateData.version
  
  // 验证版本号
  if (clientVersion === undefined || clientVersion === null) {
    return sendErrorResponse(res, ErrorType.VALIDATION_ERROR,
      '缺少必需字段: version（用于乐观锁校验）', {
        operation: 'update_account',
        accountId: id
      })
  }
  
  let retryCount = 0
  let lastResult = null
  
  // 重试循环
  while (retryCount <= VERSION_RETRY_CONFIG.MAX_RETRIES) {
    try {
      const result = await executeUpdateOperation(id, updateData, clientVersion)
      
      if (result.success) {
        // 更新成功
        console.log(`[Accounts V2] Account updated: ${result.email}, version: ${clientVersion} -> ${result.version}${retryCount > 0 ? ` (after ${retryCount} retries)` : ''}`)
        
        return sendSuccessResponse(res, {
          id,
          version: result.version,
          updatedAt: result.updatedAt,
          retryCount
        }, '账号更新成功')
      }
      
      // 检查是否为版本冲突且可重试
      if (isVersionConflict(result) && retryCount < VERSION_RETRY_CONFIG.MAX_RETRIES) {
        // 使用服务器返回的最新版本重试
        clientVersion = result.currentVersion
        // 更新 updateData 中的版本号
        updateData.version = clientVersion
        
        const delay = calculateBackoffDelay(retryCount)
        console.log(`[Accounts V2] Version conflict for account ${id}, retrying (attempt ${retryCount + 1}/${VERSION_RETRY_CONFIG.MAX_RETRIES}) after ${Math.round(delay)}ms`)
        
        await sleep(delay)
        retryCount++
        lastResult = result
        continue
      }
      
      // 不可重试的错误或已达最大重试次数
      lastResult = result
      break
      
    } catch (error) {
      console.error('[Accounts V2] Update account error:', error.message, { code: error.code })
      const errorType = classifyDatabaseError(error)
      const userMessage = getDatabaseErrorMessage(error, errorType)
      return sendErrorResponse(res, errorType, userMessage, {
        operation: 'update_account',
        accountId: id,
        code: error.code,
        retryCount
      })
    }
  }
  
  // 所有重试都失败，返回最后的错误
  if (lastResult) {
    if (lastResult.errorType === ErrorType.NOT_FOUND) {
      return sendErrorResponse(res, ErrorType.NOT_FOUND, lastResult.message, {
        operation: 'update_account',
        accountId: id
      })
    }
    
    // 版本冲突
    console.log(`[Accounts V2] Version conflict for account ${id} after ${retryCount} retries: client=${lastResult.clientVersion}, server=${lastResult.currentVersion}`)
    
    return res.status(409).json({
      success: false,
      error: ErrorType.CONFLICT_ERROR,
      message: '账号已被其他客户端修改（已尝试自动重试）',
      details: {
        operation: 'update_account',
        accountId: id,
        clientVersion: lastResult.clientVersion,
        currentVersion: lastResult.currentVersion,
        conflictReason: 'modified_by_other_client',
        retryable: true,
        retryCount
      },
      serverData: lastResult.serverData
    })
  }
  
  // 不应该到达这里
  return sendErrorResponse(res, ErrorType.INTERNAL_ERROR, '更新操作失败', {
    operation: 'update_account',
    accountId: id
  })
})

/**
 * 软删除账号
 * 
 * DELETE /api/v2/accounts/:id
 * 
 * 请求体（可选）:
 * {
 *   "version": 5  // 可选，如果提供则进行版本校验
 * }
 */
router.delete('/api/v2/accounts/:id', validateRequest(idParamSchema, 'params'), async (req, res) => {
  const conn = await getConnectionWithRetry({ operationName: 'delete_account_v2' })
  
  try {
    await conn.beginTransaction()
    
    const { id } = req.params
    const clientVersion = req.body?.version
    
    // 使用 FOR UPDATE 锁定行
    const [rows] = await conn.query(
      'SELECT version, email FROM accounts WHERE id = ? FOR UPDATE',
      [id]
    )
    
    if (rows.length === 0) {
      await conn.rollback()
      return sendErrorResponse(res, ErrorType.NOT_FOUND, '账号不存在', {
        operation: 'delete_account',
        accountId: id
      })
    }
    
    const currentVersion = rows[0].version || 1
    const email = rows[0].email
    
    // 如果提供了版本号，进行冲突检测
    if (clientVersion !== undefined && clientVersion !== null && currentVersion !== clientVersion) {
      await conn.rollback()
      return res.status(409).json({
        success: false,
        error: ErrorType.CONFLICT_ERROR,
        message: '账号已被其他客户端修改',
        details: {
          operation: 'delete_account',
          accountId: id,
          clientVersion,
          currentVersion,
          conflictReason: 'modified_by_other_client',
          retryable: true
        }
      })
    }
    
    const serverTime = Date.now()
    const newVersion = currentVersion + 1
    
    // 软删除：设置 is_del = TRUE，更新版本和时间戳
    await conn.query(
      'UPDATE accounts SET is_del = TRUE, deleted_at = ?, version = ?, updated_at = ? WHERE id = ?',
      [serverTime, newVersion, serverTime, id]
    )
    
    // 如果是当前激活账号，清除激活状态（使用提取的公共函数）
    await clearActiveAccountIfMatch(id)
    
    await conn.commit()
    
    console.log(`[Accounts V2] Account deleted: ${email}`)
    
    sendSuccessResponse(res, {
      id,
      deleted: true,
      deletedAt: serverTime,
      version: newVersion
    }, '账号删除成功')
    
  } catch (error) {
    await conn.rollback()
    console.error('[Accounts V2] Delete account error:', error.message, { code: error.code })
    const errorType = classifyDatabaseError(error)
    const userMessage = getDatabaseErrorMessage(error, errorType)
    sendErrorResponse(res, errorType, userMessage, {
      operation: 'delete_account',
      accountId: req.params.id,
      code: error.code
    })
  } finally {
    conn.release()
  }
})

/**
 * 执行单个批量操作
 * @param {object} conn - 数据库连接
 * @param {string} action - 操作类型
 * @param {object} data - 操作数据
 * @param {number} serverTime - 服务器时间戳
 * @returns {Promise<object>} 操作结果
 */
async function executeSingleOperation(conn, action, data, serverTime) {
  switch (action) {
    case 'create': {
      // 检查必需字段
      if (!data.id || !data.email) {
        return {
          id: data.id || 'unknown',
          success: false,
          errorType: ErrorType.VALIDATION_ERROR,
          error: 'INVALID_REQUEST',
          message: '缺少必需字段: id 或 email'
        }
      }
      
      // 检查是否已存在
      const [existing] = await conn.query('SELECT id FROM accounts WHERE id = ?', [data.id])
      if (existing.length > 0) {
        return {
          id: data.id,
          success: false,
          errorType: ErrorType.CONFLICT_ERROR,
          error: 'ALREADY_EXISTS',
          message: '账号已存在',
          conflictReason: 'duplicate_id'
        }
      }
      
      // 设置创建时间
      if (!data.createdAt) {
        data.createdAt = serverTime
      }
      
      // 插入账号
      await insertAccount(conn, data.id, data)
      await conn.query(
        'UPDATE accounts SET version = 1, updated_at = ? WHERE id = ?',
        [serverTime, data.id]
      )
      
      return {
        id: data.id,
        success: true,
        action: 'create',
        version: 1,
        updatedAt: serverTime
      }
    }
    
    case 'update': {
      if (!data.id) {
        return {
          id: 'unknown',
          success: false,
          errorType: ErrorType.VALIDATION_ERROR,
          error: 'INVALID_REQUEST',
          message: '缺少必需字段: id'
        }
      }
      
      let clientVersion = data.version
      if (clientVersion === undefined || clientVersion === null) {
        return {
          id: data.id,
          success: false,
          errorType: ErrorType.VALIDATION_ERROR,
          error: 'INVALID_REQUEST',
          message: '缺少必需字段: version'
        }
      }
      
      // 批量操作中的更新也支持重试
      let retryCount = 0
      const maxRetries = VERSION_RETRY_CONFIG.MAX_RETRIES
      
      while (retryCount <= maxRetries) {
        // 检查版本号
        const [rows] = await conn.query(
          'SELECT * FROM accounts WHERE id = ? FOR UPDATE',
          [data.id]
        )
        
        if (rows.length === 0) {
          return {
            id: data.id,
            success: false,
            errorType: ErrorType.NOT_FOUND,
            error: 'NOT_FOUND',
            message: '账号不存在'
          }
        }
        
        const currentRow = rows[0]
        const currentVersion = currentRow.version || 1
        const email = currentRow.email
        const idp = currentRow.idp
        
        // 版本冲突检测：直接比较当前账号的版本号
        // 乐观锁机制：检查当前记录（通过 ID 锁定）是否被其他客户端修改
        if (currentVersion !== clientVersion) {
          // 版本冲突，尝试重试
          if (retryCount < maxRetries) {
            // 使用服务器最新版本重试
            clientVersion = currentVersion
            data.version = clientVersion
            
            const delay = calculateBackoffDelay(retryCount)
            console.log(`[Accounts V2] Batch update version conflict for ${data.id} (${email}/${idp}), retrying (attempt ${retryCount + 1}/${maxRetries}) after ${Math.round(delay)}ms`)
            
            await sleep(delay)
            retryCount++
            continue
          }
          
          // 达到最大重试次数
          const serverAccount = rowToAccount(currentRow)
          serverAccount.version = currentVersion
          serverAccount.updatedAt = currentRow.updated_at || currentRow.created_at || Date.now()
          
          return {
            id: data.id,
            success: false,
            errorType: ErrorType.CONFLICT_ERROR,
            error: 'VERSION_CONFLICT',
            message: `账号 ${email} (${idp}) 已被其他客户端修改（已尝试自动重试）`,
            currentVersion: currentVersion,
            clientVersion: data.version,
            conflictReason: 'modified_by_other_client',
            retryable: true,
            retryCount,
            serverData: serverAccount
          }
        }
        
        const newVersion = currentVersion + 1
        
        // 合并更新数据
        const mergedAccount = {
          ...rowToAccount(currentRow),
          ...data,
          id: data.id
        }
        
        await insertAccount(conn, data.id, mergedAccount)
        await conn.query(
          'UPDATE accounts SET version = ?, updated_at = ? WHERE id = ?',
          [newVersion, serverTime, data.id]
        )
        
        return {
          id: data.id,
          success: true,
          action: 'update',
          version: newVersion,
          updatedAt: serverTime,
          retryCount
        }
      }
      
      // 不应该到达这里
      return {
        id: data.id,
        success: false,
        errorType: ErrorType.INTERNAL_ERROR,
        error: 'INTERNAL_ERROR',
        message: '更新操作失败'
      }
    }
    
    case 'delete': {
      if (!data.id) {
        return {
          id: 'unknown',
          success: false,
          errorType: ErrorType.VALIDATION_ERROR,
          error: 'INVALID_REQUEST',
          message: '缺少必需字段: id'
        }
      }
      
      const [rows] = await conn.query(
        'SELECT version FROM accounts WHERE id = ? FOR UPDATE',
        [data.id]
      )
      
      if (rows.length === 0) {
        return {
          id: data.id,
          success: false,
          errorType: ErrorType.NOT_FOUND,
          error: 'NOT_FOUND',
          message: '账号不存在'
        }
      }
      
      const currentVersion = rows[0].version || 1
      const clientVersion = data.version
      
      // 如果提供了版本号，进行冲突检测
      if (clientVersion !== undefined && clientVersion !== null && currentVersion !== clientVersion) {
        return {
          id: data.id,
          success: false,
          errorType: ErrorType.CONFLICT_ERROR,
          error: 'VERSION_CONFLICT',
          message: '账号已被其他客户端修改',
          currentVersion,
          clientVersion,
          conflictReason: 'modified_by_other_client',
          retryable: true
        }
      }
      
      const newVersion = currentVersion + 1
      
      // 软删除
      await conn.query(
        'UPDATE accounts SET is_del = TRUE, deleted_at = ?, version = ?, updated_at = ? WHERE id = ?',
        [serverTime, newVersion, serverTime, data.id]
      )
      
      return {
        id: data.id,
        success: true,
        action: 'delete',
        version: newVersion,
        deletedAt: serverTime
      }
    }
    
    default:
      return {
        id: data.id || 'unknown',
        success: false,
        errorType: ErrorType.VALIDATION_ERROR,
        error: 'INVALID_ACTION',
        message: `不支持的操作: ${action}`
      }
  }
}

/**
 * 批量操作接口
 *
 * POST /api/v2/accounts/batch
 *
 * 请求体:
 * {
 *   "operations": [
 *     {
 *       "action": "create",
 *       "data": { "id": "...", "email": "..." }
 *     },
 *     {
 *       "action": "update",
 *       "data": { "id": "...", "version": 3, "email": "..." }
 *     },
 *     {
 *       "action": "delete",
 *       "data": { "id": "...", "version": 5 }
 *     }
 *   ],
 *   "stopOnError": false,  // 是否在遇到错误时停止（默认 false）
 *   "rollbackStrategy": "none" | "all" | "failed-only"  // 回滚策略（默认 none）
 * }
 *
 * 回滚策略说明:
 * - none: 不回滚，部分成功部分失败（默认）
 * - all: 任何失败都回滚所有操作（等同于 stopOnError: true）
 * - failed-only: 只回滚失败的操作，成功的保留（使用保存点）
 */
router.post('/api/v2/accounts/batch', validateRequest(accountBatchSchema, 'body'), async (req, res) => {
  const requestId = generateRequestId()
  const conn = await getConnectionWithRetry({ operationName: 'batch_accounts_v2' })
  
  try {
    await conn.beginTransaction()
    
    const {
      operations,
      stopOnError = false,
      rollbackStrategy = RollbackStrategy.NONE
    } = req.body
    
    // 验证回滚策略
    const validStrategies = Object.values(RollbackStrategy)
    const effectiveStrategy = validStrategies.includes(rollbackStrategy)
      ? rollbackStrategy
      : RollbackStrategy.NONE
    
    // 如果 stopOnError 为 true，强制使用 ALL 策略
    const finalStrategy = stopOnError ? RollbackStrategy.ALL : effectiveStrategy
    
    console.log(`[Accounts V2] [${requestId}] Batch operation started, strategy: ${finalStrategy}`)
    
    // operations 验证已通过joi中间件完成
    
    const results = []
    const serverTime = Date.now()
    let succeeded = 0
    let failed = 0
    let rolledBack = 0
    
    // 保存点名称映射（用于 failed-only 策略）
    const savepoints = new Map()
    
    for (let index = 0; index < operations.length; index++) {
      const operation = operations[index]
      const { action, data } = operation
      const savepointName = `sp_${index}`
      
      if (!action || !data) {
        results.push({
          index,
          id: data?.id || 'unknown',
          success: false,
          errorType: ErrorType.VALIDATION_ERROR,
          error: 'INVALID_OPERATION',
          message: '操作缺少 action 或 data'
        })
        failed++
        
        if (finalStrategy === RollbackStrategy.ALL) {
          break
        }
        continue
      }
      
      try {
        // 对于 failed-only 策略，为每个操作创建保存点
        if (finalStrategy === RollbackStrategy.FAILED_ONLY) {
          await conn.query(`SAVEPOINT ${savepointName}`)
          savepoints.set(index, savepointName)
        }
        
        const result = await executeSingleOperation(conn, action, data, serverTime)
        
        if (result.success) {
          results.push({ index, ...result })
          succeeded++
          
          // 成功后释放保存点（可选，MySQL会在事务结束时自动释放）
          if (finalStrategy === RollbackStrategy.FAILED_ONLY) {
            await conn.query(`RELEASE SAVEPOINT ${savepointName}`)
            savepoints.delete(index)
          }
        } else {
          // 操作返回失败（非异常）
          results.push({ index, ...result })
          failed++
          
          // 对于 failed-only 策略，回滚到保存点
          if (finalStrategy === RollbackStrategy.FAILED_ONLY && savepoints.has(index)) {
            await conn.query(`ROLLBACK TO SAVEPOINT ${savepointName}`)
            rolledBack++
            results[results.length - 1].rolledBack = true
          }
          
          if (finalStrategy === RollbackStrategy.ALL) {
            break
          }
        }
        
      } catch (opError) {
        const errorType = classifyDatabaseError(opError)
        const errorResult = {
          index,
          id: data.id || 'unknown',
          success: false,
          errorType: errorType,
          error: 'OPERATION_FAILED',
          message: opError.message,
          code: opError.code
        }
        
        // 对于 failed-only 策略，回滚到保存点
        if (finalStrategy === RollbackStrategy.FAILED_ONLY && savepoints.has(index)) {
          try {
            await conn.query(`ROLLBACK TO SAVEPOINT ${savepointName}`)
            rolledBack++
            errorResult.rolledBack = true
          } catch (rollbackError) {
            console.error(`[Accounts V2] [${requestId}] Failed to rollback savepoint ${savepointName}:`, rollbackError.message)
            errorResult.rollbackFailed = true
          }
        }
        
        results.push(errorResult)
        failed++
        
        if (finalStrategy === RollbackStrategy.ALL) {
          break
        }
      }
    }
    
    // 根据策略决定最终操作
    if (finalStrategy === RollbackStrategy.ALL && failed > 0) {
      await conn.rollback()
      console.log(`[Accounts V2] [${requestId}] Batch operation rolled back due to ALL strategy`)
      
      return res.status(400).json({
        success: false,
        error: ErrorType.VALIDATION_ERROR,
        message: '批量操作因错误而回滚',
        requestId,
        details: {
          operation: 'batch',
          rollbackStrategy: finalStrategy,
          stopOnError: true
        },
        data: {
          results,
          summary: {
            total: operations.length,
            succeeded: 0,
            failed: results.length,
            rolledBack: results.length
          }
        }
      })
    }
    
    await conn.commit()
    
    console.log(`[Accounts V2] [${requestId}] Batch operation completed: ${succeeded} succeeded, ${failed} failed, ${rolledBack} rolled back`)
    
    sendSuccessResponse(res, {
      results,
      summary: {
        total: operations.length,
        succeeded,
        failed,
        rolledBack
      },
      rollbackStrategy: finalStrategy,
      requestId
    }, `批量操作完成: ${succeeded} 成功, ${failed} 失败${rolledBack > 0 ? `, ${rolledBack} 已回滚` : ''}`)
    
  } catch (error) {
    await conn.rollback()
    console.error(`[Accounts V2] [${requestId}] Batch operation error:`, error.message, { code: error.code })
    const errorType = classifyDatabaseError(error)
    const userMessage = getDatabaseErrorMessage(error, errorType)
    sendErrorResponse(res, errorType, userMessage, {
      requestId,
      operation: 'batch',
      code: error.code
    })
  } finally {
    conn.release()
  }
})

export default router