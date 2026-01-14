/**
 * 数据库迁移脚本：添加版本控制字段
 * 
 * 为 accounts、groups、tags、settings、account_machine_ids 表添加：
 * - version: 版本号（每次更新递增）
 * - updated_at: 最后更新时间戳（毫秒）
 * 
 * 执行方式：
 * node server/db/migrations/add-version-control.js
 */

import { pool, getConnectionWithRetry } from '../../config/database.js'

/**
 * 检查列是否存在
 */
async function columnExists(conn, tableName, columnName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) as count 
     FROM INFORMATION_SCHEMA.COLUMNS 
     WHERE TABLE_SCHEMA = DATABASE() 
     AND TABLE_NAME = ? 
     AND COLUMN_NAME = ?`,
    [tableName, columnName]
  )
  return rows[0].count > 0
}

/**
 * 检查索引是否存在
 */
async function indexExists(conn, tableName, indexName) {
  const [rows] = await conn.query(
    `SELECT COUNT(*) as count 
     FROM INFORMATION_SCHEMA.STATISTICS 
     WHERE TABLE_SCHEMA = DATABASE() 
     AND TABLE_NAME = ? 
     AND INDEX_NAME = ?`,
    [tableName, indexName]
  )
  return rows[0].count > 0
}

/**
 * 为表添加版本控制字段
 */
async function addVersionControlColumns(conn, tableName) {
  console.log(`[Migration] 检查表 ${tableName} 的版本控制字段...`)
  
  // 添加 version 字段
  const hasVersion = await columnExists(conn, tableName, 'version')
  if (!hasVersion) {
    console.log(`[Migration] 为表 ${tableName} 添加 version 字段...`)
    await conn.query(`ALTER TABLE ${tableName} ADD COLUMN version INT NOT NULL DEFAULT 1`)
  } else {
    console.log(`[Migration] 表 ${tableName} 已存在 version 字段，跳过`)
  }
  
  // 添加 updated_at 字段
  const hasUpdatedAt = await columnExists(conn, tableName, 'updated_at')
  if (!hasUpdatedAt) {
    console.log(`[Migration] 为表 ${tableName} 添加 updated_at 字段...`)
    await conn.query(`ALTER TABLE ${tableName} ADD COLUMN updated_at BIGINT`)
  } else {
    console.log(`[Migration] 表 ${tableName} 已存在 updated_at 字段，跳过`)
  }
}

/**
 * 初始化现有数据的版本控制字段
 */
async function initializeVersionData(conn, tableName) {
  console.log(`[Migration] 初始化表 ${tableName} 的版本控制数据...`)
  
  // 为 version 为 NULL 或 0 的记录设置初始值
  await conn.query(
    `UPDATE ${tableName} 
     SET version = 1 
     WHERE version IS NULL OR version = 0`
  )
  
  // 为 updated_at 为 NULL 的记录设置初始值
  // 优先使用 created_at，如果不存在则使用当前时间
  const hasCreatedAt = await columnExists(conn, tableName, 'created_at')
  if (hasCreatedAt) {
    await conn.query(
      `UPDATE ${tableName} 
       SET updated_at = COALESCE(created_at, ${Date.now()}) 
       WHERE updated_at IS NULL`
    )
  } else {
    await conn.query(
      `UPDATE ${tableName} 
       SET updated_at = ${Date.now()} 
       WHERE updated_at IS NULL`
    )
  }
  
  console.log(`[Migration] 表 ${tableName} 的版本控制数据初始化完成`)
}

/**
 * 添加索引以优化查询性能
 */
async function addIndexes(conn, tableName) {
  console.log(`[Migration] 为表 ${tableName} 添加索引...`)
  
  // 添加 updated_at 索引（用于增量查询）
  const indexName = `idx_${tableName}_updated_at`
  const hasIndex = await indexExists(conn, tableName, indexName)
  if (!hasIndex) {
    console.log(`[Migration] 创建索引 ${indexName}...`)
    await conn.query(`CREATE INDEX ${indexName} ON ${tableName}(updated_at)`)
  } else {
    console.log(`[Migration] 索引 ${indexName} 已存在，跳过`)
  }
  
  // 添加 version 索引（用于版本冲突检测）
  const versionIndexName = `idx_${tableName}_version`
  const hasVersionIndex = await indexExists(conn, tableName, versionIndexName)
  if (!hasVersionIndex) {
    console.log(`[Migration] 创建索引 ${versionIndexName}...`)
    await conn.query(`CREATE INDEX ${versionIndexName} ON ${tableName}(version)`)
  } else {
    console.log(`[Migration] 索引 ${versionIndexName} 已存在，跳过`)
  }
}

/**
 * 执行迁移
 */
async function migrate() {
  const conn = await getConnectionWithRetry({ operationName: 'migration_version_control' })
  
  try {
    console.log('[Migration] 开始数据库迁移：添加版本控制字段')
    console.log('[Migration] ==========================================')
    
    await conn.beginTransaction()
    
    // 需要添加版本控制的表
    const tables = ['accounts', 'groups', 'tags', 'settings', 'account_machine_ids']
    
    for (const tableName of tables) {
      console.log(`\n[Migration] 处理表: ${tableName}`)
      console.log('[Migration] ------------------------------------------')
      
      // 1. 添加版本控制字段
      await addVersionControlColumns(conn, tableName)
      
      // 2. 初始化现有数据
      await initializeVersionData(conn, tableName)
      
      // 3. 添加索引
      await addIndexes(conn, tableName)
      
      console.log(`[Migration] 表 ${tableName} 处理完成`)
    }
    
    await conn.commit()
    
    console.log('\n[Migration] ==========================================')
    console.log('[Migration] 数据库迁移成功完成！')
    console.log('[Migration] 所有表已添加版本控制字段和索引')
    
  } catch (error) {
    await conn.rollback()
    console.error('[Migration] 迁移失败:', error)
    throw error
  } finally {
    conn.release()
  }
}

/**
 * 回滚迁移（可选）
 */
async function rollback() {
  const conn = await getConnectionWithRetry({ operationName: 'rollback_version_control' })
  
  try {
    console.log('[Migration] 开始回滚迁移...')
    
    await conn.beginTransaction()
    
    const tables = ['accounts', 'groups', 'tags', 'settings', 'account_machine_ids']
    
    for (const tableName of tables) {
      console.log(`[Migration] 回滚表: ${tableName}`)
      
      // 删除索引
      const indexName = `idx_${tableName}_updated_at`
      const versionIndexName = `idx_${tableName}_version`
      
      if (await indexExists(conn, tableName, indexName)) {
        await conn.query(`DROP INDEX ${indexName} ON ${tableName}`)
      }
      
      if (await indexExists(conn, tableName, versionIndexName)) {
        await conn.query(`DROP INDEX ${versionIndexName} ON ${tableName}`)
      }
      
      // 删除字段
      if (await columnExists(conn, tableName, 'version')) {
        await conn.query(`ALTER TABLE ${tableName} DROP COLUMN version`)
      }
      
      if (await columnExists(conn, tableName, 'updated_at')) {
        await conn.query(`ALTER TABLE ${tableName} DROP COLUMN updated_at`)
      }
    }
    
    await conn.commit()
    console.log('[Migration] 回滚完成')
    
  } catch (error) {
    await conn.rollback()
    console.error('[Migration] 回滚失败:', error)
    throw error
  } finally {
    conn.release()
  }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  const command = process.argv[2]
  
  if (command === 'rollback') {
    rollback()
      .then(() => {
        console.log('[Migration] 回滚成功')
        process.exit(0)
      })
      .catch((error) => {
        console.error('[Migration] 回滚失败:', error)
        process.exit(1)
      })
  } else {
    migrate()
      .then(() => {
        console.log('[Migration] 迁移成功')
        process.exit(0)
      })
      .catch((error) => {
        console.error('[Migration] 迁移失败:', error)
        process.exit(1)
      })
  }
}

export { migrate, rollback }