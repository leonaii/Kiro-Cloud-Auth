/**
 * 修复 cred_client_secret 字段长度问题
 * 将 VARCHAR(255) 改为 TEXT 以支持更长的 JWT token
 */
import { pool, getConnectionWithRetry } from '../config/database.js'

async function fixClientSecretColumn() {
  const conn = await getConnectionWithRetry({ operationName: 'fix_client_secret' })
  
  try {
    console.log('[Fix] Checking cred_client_secret column type...')
    
    // 检查当前字段类型
    const [columns] = await conn.query(`
      SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() 
        AND TABLE_NAME = 'accounts' 
        AND COLUMN_NAME = 'cred_client_secret'
    `)
    
    if (columns.length === 0) {
      console.log('[Fix] Column cred_client_secret not found')
      return
    }
    
    const column = columns[0]
    console.log(`[Fix] Current type: ${column.DATA_TYPE}(${column.CHARACTER_MAXIMUM_LENGTH})`)
    
    if (column.DATA_TYPE === 'varchar') {
      console.log(`[Fix] Modifying column from VARCHAR(${column.CHARACTER_MAXIMUM_LENGTH}) to TEXT type...`)
      
      await conn.query(`
        ALTER TABLE accounts 
        MODIFY COLUMN cred_client_secret TEXT
      `)
      
      console.log('[Fix] ✓ Column modified successfully')
    } else if (column.DATA_TYPE === 'text') {
      console.log('[Fix] ✓ Column is already TEXT type')
    } else {
      console.log(`[Fix] Unexpected column type: ${column.DATA_TYPE}`)
    }
    
  } catch (error) {
    console.error('[Fix] Error:', error.message)
    throw error
  } finally {
    conn.release()
  }
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  fixClientSecretColumn()
    .then(() => {
      console.log('[Fix] Completed')
      process.exit(0)
    })
    .catch((error) => {
      console.error('[Fix] Failed:', error)
      process.exit(1)
    })
}

export { fixClientSecretColumn }