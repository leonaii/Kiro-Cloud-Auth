/**
 * 数据库迁移脚本：添加 email + idp 唯一索引
 * 
 * 将乐观锁机制从基于 ID 改为基于 email + idp 组合
 * 这样同一邮箱的不同 IDP 账号不会互相影响版本号
 * 
 * 执行方式：
 * node server/db/migrations/add-email-idp-unique-index.js
 */

import { pool, getConnectionWithRetry } from '../../config/database.js'

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
 * 检查是否有重复的 email + idp 组合
 */
async function checkDuplicates(conn) {
  const [rows] = await conn.query(`
    SELECT email, idp, COUNT(*) as count
    FROM accounts
    WHERE is_del = FALSE OR is_del IS NULL
    GROUP BY email, idp
    HAVING count > 1
  `)
  return rows
}

/**
 * 执行迁移
 */
async function migrate() {
  const conn = await getConnectionWithRetry({ operationName: 'migration_email_idp_unique' })
  
  try {
    console.log('[Migration] 开始数据库迁移：添加 email + idp 唯一索引')
    console.log('[Migration] ==========================================')
    
    await conn.beginTransaction()
    
    // 1. 检查是否有重复数据
    console.log('[Migration] 检查重复的 email + idp 组合...')
    const duplicates = await checkDuplicates(conn)
    
    if (duplicates.length > 0) {
      console.warn('[Migration] ⚠️  发现重复的 email + idp 组合:')
      for (const dup of duplicates) {
        console.warn(`  - ${dup.email} (${dup.idp}): ${dup.count} 条记录`)
      }
      console.warn('[Migration] 请先手动处理这些重复数据，然后重新运行迁移')
      console.warn('[Migration] 提示：可以保留最新的记录，删除或软删除旧记录')
      await conn.rollback()
      process.exit(1)
    }
    
    console.log('[Migration] ✓ 没有发现重复数据')
    
    // 2. 添加 email + idp 唯一索引
    const uniqueIndexName = 'idx_email_idp_unique'
    const hasUniqueIndex = await indexExists(conn, 'accounts', uniqueIndexName)
    
    if (!hasUniqueIndex) {
      console.log('[Migration] 添加 email + idp 唯一索引...')
      // 只对未删除的账号创建唯一索引
      await conn.query(`
        CREATE UNIQUE INDEX ${uniqueIndexName} 
        ON accounts(email, idp, is_del)
      `)
      console.log('[Migration] ✓ 唯一索引创建成功')
    } else {
      console.log('[Migration] 唯一索引已存在，跳过')
    }
    
    // 3. 添加复合索引以优化查询性能
    const compositeIndexName = 'idx_email_idp_version'
    const hasCompositeIndex = await indexExists(conn, 'accounts', compositeIndexName)
    
    if (!hasCompositeIndex) {
      console.log('[Migration] 添加 email + idp + version 复合索引...')
      await conn.query(`
        CREATE INDEX ${compositeIndexName} 
        ON accounts(email, idp, version)
      `)
      console.log('[Migration] ✓ 复合索引创建成功')
    } else {
      console.log('[Migration] 复合索引已存在，跳过')
    }
    
    await conn.commit()
    
    console.log('\n[Migration] ==========================================')
    console.log('[Migration] 数据库迁移成功完成！')
    console.log('[Migration] 已添加索引：')
    console.log('[Migration]   - idx_email_idp_unique: 确保 email + idp 组合唯一')
    console.log('[Migration]   - idx_email_idp_version: 优化版本查询性能')
    console.log('[Migration]')
    console.log('[Migration] 下一步：')
    console.log('[Migration]   1. 修改服务端版本冲突检测逻辑')
    console.log('[Migration]   2. 修改客户端版本号管理逻辑')
    
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
  const conn = await getConnectionWithRetry({ operationName: 'rollback_email_idp_unique' })
  
  try {
    console.log('[Migration] 开始回滚迁移...')
    
    await conn.beginTransaction()
    
    // 删除唯一索引
    const uniqueIndexName = 'idx_email_idp_unique'
    if (await indexExists(conn, 'accounts', uniqueIndexName)) {
      console.log('[Migration] 删除唯一索引...')
      await conn.query(`DROP INDEX ${uniqueIndexName} ON accounts`)
      console.log('[Migration] ✓ 唯一索引已删除')
    }
    
    // 删除复合索引
    const compositeIndexName = 'idx_email_idp_version'
    if (await indexExists(conn, 'accounts', compositeIndexName)) {
      console.log('[Migration] 删除复合索引...')
      await conn.query(`DROP INDEX ${compositeIndexName} ON accounts`)
      console.log('[Migration] ✓ 复合索引已删除')
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