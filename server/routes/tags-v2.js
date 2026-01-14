/**
 * 标签 API v2 路由
 * 
 * 提供带版本控制的标签 CRUD 接口：
 * - GET /api/v2/tags - 获取标签列表（支持分页、排序）
 * - GET /api/v2/tags/:id - 获取单个标签详情
 * - POST /api/v2/tags - 创建新标签
 * - PUT /api/v2/tags/:id - 更新标签（带版本控制）
 * - DELETE /api/v2/tags/:id - 删除标签
 * - POST /api/v2/tags/batch - 批量操作接口
 */

import { Router } from 'express'
import { pool, getConnectionWithRetry } from '../config/database.js'
import { rowToTag } from '../models/account.js'
import {
  validateRequest,
  tagSchema,
  tagUpdateSchema,
  idParamSchema
} from '../validators/schemas.js'

const router = Router()

/**
 * 获取标签列表
 * 
 * GET /api/v2/tags
 * 
 * 查询参数:
 * - page: 页码（默认 1）
 * - pageSize: 每页数量（默认 50，最大 200）
 * - modifiedSince: 增量查询时间戳（毫秒）
 * - sortBy: 排序字段（name/createdAt，默认 name）
 * - sortOrder: 排序方向（asc/desc，默认 asc）
 */
router.get('/api/v2/tags', async (req, res) => {
  try {
    // 解析分页参数
    const page = Math.max(1, parseInt(req.query.page) || 1)
    const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize) || 50))
    const offset = (page - 1) * pageSize
    
    // 解析过滤参数
    const modifiedSince = parseInt(req.query.modifiedSince) || null
    
    // 解析排序参数
    const sortByMap = {
      'name': 'name',
      'createdAt': 'created_at',
      'updatedAt': 'updated_at'
    }
    const sortBy = sortByMap[req.query.sortBy] || 'name'
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
    const countQuery = `SELECT COUNT(*) as total FROM tags ${whereClause}`
    const [countResult] = await pool.query(countQuery, params)
    const total = countResult[0].total
    
    // 查询数据
    const dataQuery = `
      SELECT * FROM tags 
      ${whereClause}
      ORDER BY ${sortBy} ${sortOrder}
      LIMIT ? OFFSET ?
    `
    const [rows] = await pool.query(dataQuery, [...params, pageSize, offset])
    
    // 转换数据格式
    const tags = rows.map(row => rowToTag(row))
    
    // 计算分页信息
    const totalPages = Math.ceil(total / pageSize)
    
    res.json({
      success: true,
      data: {
        tags,
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
    console.error('[Tags V2] Get tags error:', error)
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    })
  }
})

/**
 * 获取单个标签详情
 * 
 * GET /api/v2/tags/:id
 */
router.get('/api/v2/tags/:id', validateRequest(idParamSchema, 'params'), async (req, res) => {
  try {
    const { id } = req.params
    
    const [rows] = await pool.query('SELECT * FROM tags WHERE id = ?', [id])
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        message: '标签不存在'
      })
    }
    
    const tag = rowToTag(rows[0])
    
    res.json({
      success: true,
      data: tag
    })
    
  } catch (error) {
    console.error('[Tags V2] Get tag error:', error)
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    })
  }
})

/**
 * 创建新标签
 * 
 * POST /api/v2/tags
 * 
 * 请求体:
 * {
 *   "id": "tag-uuid",
 *   "name": "标签名称",
 *   "color": "#ff0000"
 * }
 */
router.post('/api/v2/tags', validateRequest(tagSchema, 'body'), async (req, res) => {
  const conn = await getConnectionWithRetry({ operationName: 'create_tag_v2' })
  
  try {
    await conn.beginTransaction()
    
    const tag = req.body
    
    // 验证已通过joi中间件完成
    
    // 检查标签是否已存在
    const [existing] = await conn.query('SELECT id FROM tags WHERE id = ?', [tag.id])
    if (existing.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'ALREADY_EXISTS',
        message: '标签已存在'
      })
    }
    
    const serverTime = Date.now()
    const createdAt = tag.createdAt || serverTime
    
    // 插入标签
    await conn.query(
      'INSERT INTO tags (id, name, color, created_at, version, updated_at) VALUES (?, ?, ?, ?, 1, ?)',
      [tag.id, tag.name, tag.color || '#808080', createdAt, serverTime]
    )
    
    await conn.commit()
    
    console.log(`[Tags V2] Tag created: ${tag.name}`)
    
    res.status(201).json({
      success: true,
      data: {
        id: tag.id,
        version: 1,
        updatedAt: serverTime,
        created: true
      }
    })
    
  } catch (error) {
    await conn.rollback()
    console.error('[Tags V2] Create tag error:', error)
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
 * 更新标签（带版本控制）
 * 
 * PUT /api/v2/tags/:id
 * 
 * 请求体:
 * {
 *   "version": 5,
 *   "name": "新名称",
 *   "color": "#00ff00"
 * }
 * 
 * 版本冲突时返回 409 状态码和服务器最新数据
 */
router.put('/api/v2/tags/:id', validateRequest(idParamSchema, 'params'), validateRequest(tagUpdateSchema, 'body'), async (req, res) => {
  const conn = await getConnectionWithRetry({ operationName: 'update_tag_v2' })
  
  try {
    await conn.beginTransaction()
    
    const { id } = req.params
    const updateData = req.body
    const clientVersion = updateData.version
    
    // 版本号验证已通过joi中间件完成
    
    // 使用 FOR UPDATE 锁定行，防止并发修改
    const [rows] = await conn.query(
      'SELECT * FROM tags WHERE id = ? FOR UPDATE',
      [id]
    )
    
    if (rows.length === 0) {
      await conn.rollback()
      return res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        message: '标签不存在'
      })
    }
    
    const currentRow = rows[0]
    const currentVersion = currentRow.version || 1
    
    // 版本冲突检测
    if (currentVersion !== clientVersion) {
      await conn.rollback()
      
      // 返回服务器最新数据
      const serverTag = rowToTag(currentRow)
      
      console.log(`[Tags V2] Version conflict for ${currentRow.name}: client=${clientVersion}, server=${currentVersion}`)
      
      return res.status(409).json({
        success: false,
        error: 'VERSION_CONFLICT',
        message: '标签已被其他客户端修改',
        currentVersion,
        serverData: serverTag
      })
    }
    
    const serverTime = Date.now()
    const newVersion = currentVersion + 1
    
    // 更新标签
    await conn.query(
      'UPDATE tags SET name = ?, color = ?, version = ?, updated_at = ? WHERE id = ?',
      [
        updateData.name !== undefined ? updateData.name : currentRow.name,
        updateData.color !== undefined ? updateData.color : currentRow.color,
        newVersion,
        serverTime,
        id
      ]
    )
    
    await conn.commit()
    
    console.log(`[Tags V2] Tag updated: ${updateData.name || currentRow.name}, version: ${currentVersion} -> ${newVersion}`)
    
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
    console.error('[Tags V2] Update tag error:', error)
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
 * 删除标签
 * 
 * DELETE /api/v2/tags/:id
 * 
 * 请求体（可选）:
 * {
 *   "version": 5  // 可选，如果提供则进行版本校验
 * }
 */
router.delete('/api/v2/tags/:id', validateRequest(idParamSchema, 'params'), async (req, res) => {
  const conn = await getConnectionWithRetry({ operationName: 'delete_tag_v2' })
  
  try {
    await conn.beginTransaction()
    
    const { id } = req.params
    const clientVersion = req.body?.version
    
    // 使用 FOR UPDATE 锁定行
    const [rows] = await conn.query(
      'SELECT version, name FROM tags WHERE id = ? FOR UPDATE',
      [id]
    )
    
    if (rows.length === 0) {
      await conn.rollback()
      return res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        message: '标签不存在'
      })
    }
    
    const currentVersion = rows[0].version || 1
    const name = rows[0].name
    
    // 如果提供了版本号，进行冲突检测
    if (clientVersion !== undefined && clientVersion !== null && currentVersion !== clientVersion) {
      await conn.rollback()
      return res.status(409).json({
        success: false,
        error: 'VERSION_CONFLICT',
        message: '标签已被其他客户端修改',
        currentVersion
      })
    }
    
    const serverTime = Date.now()
    
    // 删除标签
    await conn.query('DELETE FROM tags WHERE id = ?', [id])
    
    // 从账号中移除该标签
    const [accounts] = await conn.query('SELECT id, tags FROM accounts')
    for (const acc of accounts) {
      const tags = JSON.parse(acc.tags || '[]')
      const newTags = tags.filter(t => t !== id)
      if (tags.length !== newTags.length) {
        await conn.query('UPDATE accounts SET tags = ? WHERE id = ?', [JSON.stringify(newTags), acc.id])
      }
    }
    
    await conn.commit()
    
    console.log(`[Tags V2] Tag deleted: ${name}`)
    
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
    console.error('[Tags V2] Delete tag error:', error)
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
 * POST /api/v2/tags/batch
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
router.post('/api/v2/tags/batch', async (req, res) => {
  const conn = await getConnectionWithRetry({ operationName: 'batch_tags_v2' })
  
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
            const [existing] = await conn.query('SELECT id FROM tags WHERE id = ?', [data.id])
            if (existing.length > 0) {
              results.push({
                id: data.id,
                success: false,
                error: 'ALREADY_EXISTS',
                message: '标签已存在'
              })
              failed++
              if (stopOnError) break
              continue
            }
            
            const createdAt = data.createdAt || serverTime
            
            // 插入标签
            await conn.query(
              'INSERT INTO tags (id, name, color, created_at, version, updated_at) VALUES (?, ?, ?, ?, 1, ?)',
              [data.id, data.name, data.color || '#808080', createdAt, serverTime]
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
              'SELECT * FROM tags WHERE id = ? FOR UPDATE',
              [data.id]
            )
            
            if (rows.length === 0) {
              results.push({
                id: data.id,
                success: false,
                error: 'NOT_FOUND',
                message: '标签不存在'
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
                message: '标签已被其他客户端修改',
                currentVersion
              })
              failed++
              if (stopOnError) break
              continue
            }
            
            const newVersion = currentVersion + 1
            
            // 更新标签
            await conn.query(
              'UPDATE tags SET name = ?, color = ?, version = ?, updated_at = ? WHERE id = ?',
              [
                data.name !== undefined ? data.name : currentRow.name,
                data.color !== undefined ? data.color : currentRow.color,
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
              'SELECT version FROM tags WHERE id = ? FOR UPDATE',
              [data.id]
            )
            
            if (rows.length === 0) {
              results.push({
                id: data.id,
                success: false,
                error: 'NOT_FOUND',
                message: '标签不存在'
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
                message: '标签已被其他客户端修改',
                currentVersion
              })
              failed++
              if (stopOnError) break
              continue
            }
            
            // 删除标签
            await conn.query('DELETE FROM tags WHERE id = ?', [data.id])
            
            // 从账号中移除该标签
            const [accounts] = await conn.query('SELECT id, tags FROM accounts')
            for (const acc of accounts) {
              const tags = JSON.parse(acc.tags || '[]')
              const newTags = tags.filter(t => t !== data.id)
              if (tags.length !== newTags.length) {
                await conn.query('UPDATE accounts SET tags = ? WHERE id = ?', [JSON.stringify(newTags), acc.id])
              }
            }
            
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
    
    console.log(`[Tags V2] Batch operation completed: ${succeeded} succeeded, ${failed} failed`)
    
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
    console.error('[Tags V2] Batch operation error:', error)
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