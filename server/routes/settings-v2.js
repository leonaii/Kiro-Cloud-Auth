/**
 * 设置 API v2 路由
 * 
 * 提供带版本控制的设置 CRUD 接口：
 * - GET /api/v2/settings - 获取所有设置
 * - GET /api/v2/settings/:key - 获取单个设置
 * - PUT /api/v2/settings/:key - 更新单个设置（带版本控制）
 * - PUT /api/v2/settings/batch - 批量更新设置
 */

import { Router } from 'express'
import { pool, getConnectionWithRetry } from '../config/database.js'
import { rowToSetting } from '../models/account.js'
import {
  validateRequest,
  settingValueSchema,
  settingsBatchSchema
} from '../validators/schemas.js'

const router = Router()

/**
 * 获取值的类型
 */
function getValueType(value) {
  if (value === null || value === undefined) {
    return 'string'
  }
  if (typeof value === 'object') {
    return 'json'
  }
  if (typeof value === 'boolean') {
    return 'boolean'
  }
  if (typeof value === 'number') {
    return 'number'
  }
  return 'string'
}

/**
 * 将值转换为字符串存储
 */
function valueToString(value) {
  if (value === null || value === undefined) {
    return ''
  }
  if (typeof value === 'object') {
    return JSON.stringify(value)
  }
  return String(value)
}

/**
 * 获取所有设置
 * 
 * GET /api/v2/settings
 * 
 * 查询参数:
 * - modifiedSince: 增量查询时间戳（毫秒）
 * - format: 响应格式（object/array，默认 object）
 */
router.get('/api/v2/settings', async (req, res) => {
  try {
    // 解析过滤参数
    const modifiedSince = parseInt(req.query.modifiedSince) || null
    const format = req.query.format || 'object'
    
    // 构建查询条件
    const conditions = []
    const params = []
    
    if (modifiedSince) {
      conditions.push('updated_at > ?')
      params.push(modifiedSince)
    }
    
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    
    // 查询数据
    const [rows] = await pool.query(`SELECT * FROM settings ${whereClause}`, params)
    
    if (format === 'array') {
      // 数组格式：返回完整的设置对象数组
      const settings = rows.map(row => rowToSetting(row))
      
      res.json({
        success: true,
        data: {
          settings,
          serverTime: Date.now()
        }
      })
    } else {
      // 对象格式：返回 key-value 对象（兼容旧版）
      const settings = {}
      const versions = {}
      
      for (const row of rows) {
        const setting = rowToSetting(row)
        settings[setting.key] = setting.value
        versions[setting.key] = {
          version: setting.version,
          updatedAt: setting.updatedAt
        }
      }
      
      res.json({
        success: true,
        data: {
          settings,
          versions,
          serverTime: Date.now()
        }
      })
    }
    
  } catch (error) {
    console.error('[Settings V2] Get settings error:', error)
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    })
  }
})

/**
 * 获取单个设置
 * 
 * GET /api/v2/settings/:key
 */
router.get('/api/v2/settings/:key', async (req, res) => {
  try {
    const { key } = req.params
    
    const [rows] = await pool.query('SELECT * FROM settings WHERE `key` = ?', [key])
    
    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'NOT_FOUND',
        message: '设置不存在'
      })
    }
    
    const setting = rowToSetting(rows[0])
    
    res.json({
      success: true,
      data: setting
    })
    
  } catch (error) {
    console.error('[Settings V2] Get setting error:', error)
    res.status(500).json({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message
    })
  }
})

/**
 * 更新单个设置（带版本控制）
 * 
 * PUT /api/v2/settings/:key
 * 
 * 请求体:
 * {
 *   "version": 5,  // 可选，如果提供则进行版本校验；如果设置不存在则创建
 *   "value": "设置值"
 * }
 * 
 * 版本冲突时返回 409 状态码和服务器最新数据
 */
router.put('/api/v2/settings/:key', validateRequest(settingValueSchema, 'body'), async (req, res) => {
  const conn = await getConnectionWithRetry({ operationName: 'update_setting_v2' })
  
  try {
    await conn.beginTransaction()
    
    const { key } = req.params
    const { version: clientVersion, value } = req.body
    
    // value 验证已通过joi中间件完成
    
    const serverTime = Date.now()
    const valueType = getValueType(value)
    const valueStr = valueToString(value)
    
    // 使用 FOR UPDATE 锁定行
    const [rows] = await conn.query(
      'SELECT * FROM settings WHERE `key` = ? FOR UPDATE',
      [key]
    )
    
    if (rows.length === 0) {
      // 设置不存在，创建新设置
      await conn.query(
        'INSERT INTO settings (`key`, value, value_type, version, updated_at) VALUES (?, ?, ?, 1, ?)',
        [key, valueStr, valueType, serverTime]
      )
      
      await conn.commit()
      
      console.log(`[Settings V2] Setting created: ${key}`)
      
      return res.status(201).json({
        success: true,
        data: {
          key,
          version: 1,
          updatedAt: serverTime,
          created: true
        }
      })
    }
    
    const currentRow = rows[0]
    const currentVersion = currentRow.version || 1
    
    // 如果提供了版本号，进行冲突检测
    if (clientVersion !== undefined && clientVersion !== null && currentVersion !== clientVersion) {
      await conn.rollback()
      
      // 返回服务器最新数据
      const serverSetting = rowToSetting(currentRow)
      
      console.log(`[Settings V2] Version conflict for ${key}: client=${clientVersion}, server=${currentVersion}`)
      
      return res.status(409).json({
        success: false,
        error: 'VERSION_CONFLICT',
        message: '设置已被其他客户端修改',
        currentVersion,
        serverData: serverSetting
      })
    }
    
    const newVersion = currentVersion + 1
    
    // 更新设置
    await conn.query(
      'UPDATE settings SET value = ?, value_type = ?, version = ?, updated_at = ? WHERE `key` = ?',
      [valueStr, valueType, newVersion, serverTime, key]
    )
    
    await conn.commit()
    
    console.log(`[Settings V2] Setting updated: ${key}, version: ${currentVersion} -> ${newVersion}`)
    
    res.json({
      success: true,
      data: {
        key,
        version: newVersion,
        updatedAt: serverTime
      }
    })
    
  } catch (error) {
    await conn.rollback()
    console.error('[Settings V2] Update setting error:', error)
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
 * 批量更新设置
 * 
 * PUT /api/v2/settings/batch
 * 
 * 请求体:
 * {
 *   "settings": [
 *     {
 *       "key": "setting1",
 *       "value": "value1",
 *       "version": 5  // 可选
 *     },
 *     {
 *       "key": "setting2",
 *       "value": { "nested": "object" },
 *       "version": 3  // 可选
 *     }
 *   ],
 *   "stopOnError": false  // 是否在遇到错误时停止（默认 false）
 * }
 */
router.put('/api/v2/settings/batch', validateRequest(settingsBatchSchema, 'body'), async (req, res) => {
  const conn = await getConnectionWithRetry({ operationName: 'batch_settings_v2' })
  
  try {
    await conn.beginTransaction()
    
    const { settings, stopOnError = false } = req.body
    
    // settings 验证已通过joi中间件完成
    
    const results = []
    const serverTime = Date.now()
    let succeeded = 0
    let failed = 0
    
    for (const setting of settings) {
      const { key, value, version: clientVersion } = setting
      
      if (!key) {
        results.push({
          key: 'unknown',
          success: false,
          error: 'INVALID_REQUEST',
          message: '缺少必需字段: key'
        })
        failed++
        if (stopOnError) break
        continue
      }
      
      if (value === undefined) {
        results.push({
          key,
          success: false,
          error: 'INVALID_REQUEST',
          message: '缺少必需字段: value'
        })
        failed++
        if (stopOnError) break
        continue
      }
      
      try {
        const valueType = getValueType(value)
        const valueStr = valueToString(value)
        
        // 使用 FOR UPDATE 锁定行
        const [rows] = await conn.query(
          'SELECT * FROM settings WHERE `key` = ? FOR UPDATE',
          [key]
        )
        
        if (rows.length === 0) {
          // 设置不存在，创建新设置
          await conn.query(
            'INSERT INTO settings (`key`, value, value_type, version, updated_at) VALUES (?, ?, ?, 1, ?)',
            [key, valueStr, valueType, serverTime]
          )
          
          results.push({
            key,
            success: true,
            action: 'create',
            version: 1,
            updatedAt: serverTime
          })
          succeeded++
          continue
        }
        
        const currentRow = rows[0]
        const currentVersion = currentRow.version || 1
        
        // 如果提供了版本号，进行冲突检测
        if (clientVersion !== undefined && clientVersion !== null && currentVersion !== clientVersion) {
          results.push({
            key,
            success: false,
            error: 'VERSION_CONFLICT',
            message: '设置已被其他客户端修改',
            currentVersion
          })
          failed++
          if (stopOnError) break
          continue
        }
        
        const newVersion = currentVersion + 1
        
        // 更新设置
        await conn.query(
          'UPDATE settings SET value = ?, value_type = ?, version = ?, updated_at = ? WHERE `key` = ?',
          [valueStr, valueType, newVersion, serverTime, key]
        )
        
        results.push({
          key,
          success: true,
          action: 'update',
          version: newVersion,
          updatedAt: serverTime
        })
        succeeded++
        
      } catch (opError) {
        results.push({
          key,
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
            total: settings.length,
            succeeded: 0,
            failed: results.length
          }
        }
      })
    }
    
    await conn.commit()
    
    console.log(`[Settings V2] Batch operation completed: ${succeeded} succeeded, ${failed} failed`)
    
    res.json({
      success: true,
      data: {
        results,
        summary: {
          total: settings.length,
          succeeded,
          failed
        }
      }
    })
    
  } catch (error) {
    await conn.rollback()
    console.error('[Settings V2] Batch operation error:', error)
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