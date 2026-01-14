/**
 * 分组 API v2 路由
 * 
 * 提供带版本控制的分组 CRUD 接口：
 * - GET /api/v2/groups - 获取分组列表（支持分页、排序）
 * - GET /api/v2/groups/:id - 获取单个分组详情
 * - POST /api/v2/groups - 创建新分组
 * - PUT /api/v2/groups/:id - 更新分组（带版本控制）
 * - DELETE /api/v2/groups/:id - 删除分组
 * - POST /api/v2/groups/batch - 批量操作接口
 */

import { Router } from 'express'
import { pool, getConnectionWithRetry } from '../config/database.js'
import { clearGroupApiKeyCache } from '../openai-compat/auth-middleware.js'
import { rowToGroup } from '../models/account.js'
import {
  validateRequest,
  groupSchema,
  groupUpdateSchema,
  idParamSchema
} from '../validators/schemas.js'

const router = Router()

/**
 * 获取分组列表
 * 
 * GET /api/v2/groups
 * 
 * 查询参数:
 * - page: 页码（默认 1）
 * - pageSize: 每页数量（默认 50，最大 200）
 * - modifiedSince: 增量查询时间戳（毫秒）
 * - sortBy: 排序字段（order/name/createdAt，默认 order）
 * - sortOrder: 排序方向（asc/desc，默认 asc）
 */
router.get('/api/v2/groups', async (req, res) => {
  try {
    // 解析分页参数
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50))
    const offset = (page - 1) * pageSize
    
    // 解析过滤参数
    const modifiedSince = parseInt(req.query.modifiedSince) || null
    
    // 解析排序参数
    const sortByMap = {
      'order': '`order`',
      'name': 'name',
      'createdAt': 'created_at',
      'updatedAt': 'updated_at'
    }
    const sortBy = sortByMap[req.query.sortBy] || '`order`'
    const sortOrder = req.query.sortOrder === 'desc' ? 'DESC' : 'ASC'
    
    // 构建查询条件
    const conditions = []
    const params = []
    
    if (modifiedSince) {
      conditions.push('updated_at > ?')
      params.push(modifiedSince)
    }
    
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    
    // 查询总数
    const countQuery = `SELECT COUNT(*) as total FROM \`groups\` ${whereClause}`
    const [countResult] = await pool.query(countQuery, params)
    const total = countResult[0].total
    
    // 查询数据
    const dataQuery = `
      SELECT * FROM \`groups\` 
      ${whereClause}
      ORDER BY ${sortBy} ${sortOrder}
      LIMIT ? OFFSET ?
    `
    const [rows] = await pool.query(dataQuery, [...params, pageSize, offset])
    
    // 转换数据格式
    const groups = rows.map(row => rowToGroup(row))
    
    // 计算分页信息
    const totalPages = Math.ceil(total / pageSize)
    
    res.json({
      success: true,
      data: {
        groups,
        pagination: {
          page,
          pageSize,
          total,
          totalPages,
          hasNext: page < totalPages
        },
        serverTime: Date.now()
      }
    })
    
  } catch (error) {
    console.error('[Groups V2] Get groups error:', error)
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    })
  }
})

/**
 * 获取单个分组详情
 * 
 * GET /api/v2/groups/:id
 */
router.get('/api/v2/groups/:id', validateRequest(idParamSchema, 'params'), async (req, res) => {
  try {
    const { id } = req.params
    
    const [rows] = await pool.query('SELECT * FROM `groups` WHERE id = ?', [id])
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        message: '分组不存在'
      })
    }
    
    const group = rowToGroup(rows[0])
    
    res.json({
      success: true,
      data: group
    })
    
  } catch (error) {
    console.error('[Groups V2] Get group error:', error)
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    })
  }
})

/**
 * 创建新分组
 * 
 * POST /api/v2/groups
 * 
 * 请求体:
 * {
 *   "id": "group-uuid",
 *   "name": "分组名称",
 *   "color": "#ff0000",
 *   "order": 0
 * }
 */
router.post('/api/v2/groups', validateRequest(groupSchema, 'body'), async (req, res) => {
  const conn = await getConnectionWithRetry({ operationName: 'create_group_v2' })
  
  try {
    await conn.beginTransaction()
    
    const group = req.body
    
    // 验证已通过joi中间件完成
    
    // 检查分组是否已存在
    const [existing] = await conn.query('SELECT id FROM `groups` WHERE id = ?', [group.id])
    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'ALREADY_EXISTS',
        message: '分组已存在'
      })
    }
    
    const serverTime = Date.now()
    const createdAt = group.createdAt || serverTime
    
    // 插入分组
    await conn.query(
      'INSERT INTO `groups` (id, name, color, description, api_key, `order`, created_at, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
      [group.id, group.name, group.color || '#808080', group.description || null, group.apiKey || null, group.order || 0, createdAt, serverTime]
    )
    
    await conn.commit()
    
    // 如果设置了 API Key，清除缓存
    if (group.apiKey) {
      clearGroupApiKeyCache()
    }
    
    console.log(`[Groups V2] Group created: ${group.name}`)
    
    res.status(201).json({
      success: true,
      data: {
        id: group.id,
        version: 1,
        updatedAt: serverTime,
        created: true
      }
    })
    
  } catch (error) {
    await conn.rollback()
    console.error('[Groups V2] Create group error:', error)
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    })
  } finally {
    conn.release()
  }
})

/**
 * 更新分组（带版本控制）
 * 
 * PUT /api/v2/groups/:id
 * 
 * 请求体:
 * {
 *   "version": 5,
 *   "name": "新名称",
 *   "color": "#00ff00",
 *   "order": 1
 * }
 * 
 * 版本冲突时返回 409 状态码和服务器最新数据
 */
router.put('/api/v2/groups/:id', validateRequest(idParamSchema, 'params'), validateRequest(groupUpdateSchema, 'body'), async (req, res) => {
  const conn = await getConnectionWithRetry({ operationName: 'update_group_v2' })
  
  try {
    await conn.beginTransaction()
    
    const { id } = req.params
    const updateData = req.body
    const clientVersion = updateData.version
    
    // 版本号验证已通过joi中间件完成
    
    // 使用 FOR UPDATE 锁定行，防止并发修改
    const [rows] = await conn.query(
      'SELECT * FROM `groups` WHERE id = ? FOR UPDATE',
      [id]
    )
    
    if (rows.length === 0) {
      await conn.rollback()
      return res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        message: '分组不存在'
      })
    }
    
    const currentRow = rows[0]
    const currentVersion = currentRow.version || 1
    
    // 版本冲突检测
    if (currentVersion !== clientVersion) {
      await conn.rollback()
      
      // 返回服务器最新数据
      const serverGroup = rowToGroup(currentRow)
      
      console.log(`[Groups V2] Version conflict for ${currentRow.name}: client=${clientVersion}, server=${currentVersion}`)
      
      return res.status(409).json({
        success: false,
        error: 'VERSION_CONFLICT',
        message: '分组已被其他客户端修改',
        currentVersion,
        serverData: serverGroup
      })
    }
    
    const serverTime = Date.now()
    const newVersion = currentVersion + 1
    
    // 更新分组
    await conn.query(
      'UPDATE `groups` SET name = ?, color = ?, description = ?, api_key = ?, `order` = ?, version = ?, updated_at = ? WHERE id = ?',
      [
        updateData.name !== undefined ? updateData.name : currentRow.name,
        updateData.color !== undefined ? updateData.color : currentRow.color,
        updateData.description !== undefined ? updateData.description : currentRow.description,
        updateData.apiKey !== undefined ? updateData.apiKey : currentRow.api_key,
        updateData.order !== undefined ? updateData.order : currentRow.order,
        newVersion,
        serverTime,
        id
      ]
    )
    
    await conn.commit()
    
    // 如果 API Key 有变化，清除缓存
    if (updateData.apiKey !== undefined || currentRow.api_key) {
      clearGroupApiKeyCache()
    }
    
    console.log(`[Groups V2] Group updated: ${updateData.name || currentRow.name}, version: ${currentVersion} -> ${newVersion}`)
    
    res.json({
      success: true,
      data: {
        id,
        version: newVersion,
        updatedAt: serverTime
      }
    })
    
  } catch (error) {
    await conn.rollback()
    console.error('[Groups V2] Update group error:', error)
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    })
  } finally {
    conn.release()
  }
})

/**
 * 删除分组
 * 
 * DELETE /api/v2/groups/:id
 * 
 * 请求体（可选）:
 * {
 *   "version": 5  // 可选，如果提供则进行版本校验
 * }
 */
router.delete('/api/v2/groups/:id', validateRequest(idParamSchema, 'params'), async (req, res) => {
  const conn = await getConnectionWithRetry({ operationName: 'delete_group_v2' })
  
  try {
    await conn.beginTransaction()
    
    const { id } = req.params
    const clientVersion = req.body?.version
    
    // 使用 FOR UPDATE 锁定行
    const [rows] = await conn.query(
      'SELECT version, name, api_key FROM `groups` WHERE id = ? FOR UPDATE',
      [id]
    )
    
    if (rows.length === 0) {
      await conn.rollback()
      return res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        message: '分组不存在'
      })
    }
    
    const currentVersion = rows[0].version || 1
    const name = rows[0].name
    const hasApiKey = !!rows[0].api_key
    
    // 如果提供了版本号，进行冲突检测
    if (clientVersion !== undefined && clientVersion !== null && currentVersion !== clientVersion) {
      await conn.rollback()
      return res.status(409).json({
        success: false,
        error: 'VERSION_CONFLICT',
        message: '分组已被其他客户端修改',
        currentVersion
      })
    }
    
    const serverTime = Date.now()
    
    // 删除分组
    await conn.query('DELETE FROM `groups` WHERE id = ?', [id])
    
    // 清除账号中的分组引用
    await conn.query('UPDATE accounts SET group_id = NULL WHERE group_id = ?', [id])
    
    await conn.commit()
    
    // 如果删除的分组有 API Key，清除缓存
    if (hasApiKey) {
      clearGroupApiKeyCache()
    }
    
    console.log(`[Groups V2] Group deleted: ${name}`)
    
    res.json({
      success: true,
      data: {
        id,
        deleted: true,
        deletedAt: serverTime
      }
    })
    
  } catch (error) {
    await conn.rollback()
    console.error('[Groups V2] Delete group error:', error)
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    })
  } finally {
    conn.release()
  }
})

/**
 * 批量操作接口
 * 
 * POST /api/v2/groups/batch
 * 
 * 请求体:
 * {
 *   "operations": [
 *     {
 *       "action": "create",
 *       "data": { "id": "...", "name": "..." }
 *     },
 *     {
 *       "action": "update",
 *       "data": { "id": "...", "version": 3, "name": "..." }
 *     },
 *     {
 *       "action": "delete",
 *       "data": { "id": "...", "version": 5 }
 *     }
 *   ],
 *   "stopOnError": false  // 是否在遇到错误时停止（默认 false）
 * }
 */
router.post('/api/v2/groups/batch', async (req, res) => {
  const conn = await getConnectionWithRetry({ operationName: 'batch_groups_v2' })
  
  try {
    await conn.beginTransaction()
    
    const { operations, stopOnError = false } = req.body
    
    if (!operations || !Array.isArray(operations)) {
      return res.status(400).json({
        success: false,
        error: 'INVALID_REQUEST',
        message: 'operations 必须是数组'
      })
    }
    
    if (operations.length > 100) {
      return res.status(400).json({
        success: false,
        error: 'LIMIT_EXCEEDED',
        message: '单次批量操作最多 100 条记录'
      })
    }
    
    const results = []
    const serverTime = Date.now()
    let succeeded = 0
    let failed = 0
    
    for (const operation of operations) {
      const { action, data } = operation
      
      if (!action || !data) {
        results.push({
          id: data?.id || 'unknown',
          success: false,
          error: 'INVALID_OPERATION',
          message: '操作缺少 action 或 data'
        })
        failed++
        if (stopOnError) break
        continue
      }
      
      try {
        switch (action) {
          case 'create': {
            // 检查必需字段
            if (!data.id || !data.name) {
              results.push({
                id: data.id || 'unknown',
                success: false,
                error: 'INVALID_REQUEST',
                message: '缺少必需字段: id 或 name'
              })
              failed++
              if (stopOnError) break
              continue
            }
            
            // 检查是否已存在
            const [existing] = await conn.query('SELECT id FROM `groups` WHERE id = ?', [data.id])
            if (existing.length > 0) {
              results.push({
                id: data.id,
                success: false,
                error: 'ALREADY_EXISTS',
                message: '分组已存在'
              })
              failed++
              if (stopOnError) break
              continue
            }
            
            const createdAt = data.createdAt || serverTime
            
            // 插入分组
            await conn.query(
              'INSERT INTO `groups` (id, name, color, description, api_key, `order`, created_at, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)',
              [data.id, data.name, data.color || '#808080', data.description || null, data.apiKey || null, data.order || 0, createdAt, serverTime]
            )
            
            results.push({
              id: data.id,
              success: true,
              action: 'create',
              version: 1,
              updatedAt: serverTime
            })
            succeeded++
            break
          }
          
          case 'update': {
            if (!data.id) {
              results.push({
                id: 'unknown',
                success: false,
                error: 'INVALID_REQUEST',
                message: '缺少必需字段: id'
              })
              failed++
              if (stopOnError) break
              continue
            }
            
            const clientVersion = data.version
            if (clientVersion === undefined || clientVersion === null) {
              results.push({
                id: data.id,
                success: false,
                error: 'INVALID_REQUEST',
                message: '缺少必需字段: version'
              })
              failed++
              if (stopOnError) break
              continue
            }
            
            // 检查版本号
            const [rows] = await conn.query(
              'SELECT * FROM `groups` WHERE id = ? FOR UPDATE',
              [data.id]
            )
            
            if (rows.length === 0) {
              results.push({
                id: data.id,
                success: false,
                error: 'NOT_FOUND',
                message: '分组不存在'
              })
              failed++
              if (stopOnError) break
              continue
            }
            
            const currentRow = rows[0]
            const currentVersion = currentRow.version || 1
            
            if (currentVersion !== clientVersion) {
              results.push({
                id: data.id,
                success: false,
                error: 'VERSION_CONFLICT',
                message: '分组已被其他客户端修改',
                currentVersion
              })
              failed++
              if (stopOnError) break
              continue
            }
            
            const newVersion = currentVersion + 1
            
            // 更新分组
            await conn.query(
              'UPDATE `groups` SET name = ?, color = ?, description = ?, api_key = ?, `order` = ?, version = ?, updated_at = ? WHERE id = ?',
              [
                data.name !== undefined ? data.name : currentRow.name,
                data.color !== undefined ? data.color : currentRow.color,
                data.description !== undefined ? data.description : currentRow.description,
                data.apiKey !== undefined ? data.apiKey : currentRow.api_key,
                data.order !== undefined ? data.order : currentRow.order,
                newVersion,
                serverTime,
                data.id
              ]
            )
            
            results.push({
              id: data.id,
              success: true,
              action: 'update',
              version: newVersion,
              updatedAt: serverTime
            })
            succeeded++
            break
          }
          
          case 'delete': {
            if (!data.id) {
              results.push({
                id: 'unknown',
                success: false,
                error: 'INVALID_REQUEST',
                message: '缺少必需字段: id'
              })
              failed++
              if (stopOnError) break
              continue
            }
            
            const [rows] = await conn.query(
              'SELECT version FROM `groups` WHERE id = ? FOR UPDATE',
              [data.id]
            )
            
            if (rows.length === 0) {
              results.push({
                id: data.id,
                success: false,
                error: 'NOT_FOUND',
                message: '分组不存在'
              })
              failed++
              if (stopOnError) break
              continue
            }
            
            const currentVersion = rows[0].version || 1
            const clientVersion = data.version
            
            // 如果提供了版本号，进行冲突检测
            if (clientVersion !== undefined && clientVersion !== null && currentVersion !== clientVersion) {
              results.push({
                id: data.id,
                success: false,
                error: 'VERSION_CONFLICT',
                message: '分组已被其他客户端修改',
                currentVersion
              })
              failed++
              if (stopOnError) break
              continue
            }
            
            // 删除分组
            await conn.query('DELETE FROM `groups` WHERE id = ?', [data.id])
            
            // 清除账号中的分组引用
            await conn.query('UPDATE accounts SET group_id = NULL WHERE group_id = ?', [data.id])
            
            results.push({
              id: data.id,
              success: true,
              action: 'delete',
              deletedAt: serverTime
            })
            succeeded++
            break
          }
          
          default:
            results.push({
              id: data.id || 'unknown',
              success: false,
              error: 'INVALID_ACTION',
              message: `不支持的操作: ${action}`
            })
            failed++
            if (stopOnError) break
        }
        
      } catch (opError) {
        results.push({
          id: data.id || 'unknown',
          success: false,
          error: 'OPERATION_FAILED',
          message: opError.message
        })
        failed++
        if (stopOnError) break
      }
    }
    
    // 如果 stopOnError 且有失败，回滚事务
    if (stopOnError && failed > 0) {
      await conn.rollback()
      return res.status(400).json({
        success: false,
        error: 'BATCH_STOPPED',
        message: '批量操作因错误而停止',
        data: {
          results,
          summary: {
            total: operations.length,
            succeeded: 0,
            failed: results.length
          }
        }
      })
    }
    
    await conn.commit()
    
    // 批量操作后清除分组 API Key 缓存（简化处理，只要有成功的操作就清除）
    if (succeeded > 0) {
      clearGroupApiKeyCache()
    }
    
    console.log(`[Groups V2] Batch operation completed: ${succeeded} succeeded, ${failed} failed`)
    
    res.json({
      success: true,
      data: {
        results,
        summary: {
          total: operations.length,
          succeeded,
          failed
        }
      }
    })
    
  } catch (error) {
    await conn.rollback()
    console.error('[Groups V2] Batch operation error:', error)
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    })
  } finally {
    conn.release()
  }
})

export default router