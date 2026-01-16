/**
 * 数据库迁移：添加 api_protocol 字段
 * 用于区分 OpenAI 和 Claude API 协议的请求日志
 */

export async function up(pool) {
  console.log('[Migration] Adding api_protocol column to api_request_logs...')
  
  try {
    // 检查列是否已存在
    const [columns] = await pool.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'api_request_logs' 
      AND COLUMN_NAME = 'api_protocol'
    `)
    
    if (columns.length === 0) {
      // 添加 api_protocol 列
      await pool.query(`
        ALTER TABLE api_request_logs 
        ADD COLUMN api_protocol VARCHAR(20) DEFAULT 'openai' 
        AFTER request_headers
      `)
      console.log('[Migration] api_protocol column added successfully')
    } else {
      console.log('[Migration] api_protocol column already exists, skipping')
    }
    
    return true
  } catch (error) {
    console.error('[Migration] Failed to add api_protocol column:', error.message)
    throw error
  }
}

export async function down(pool) {
  console.log('[Migration] Removing api_protocol column from api_request_logs...')
  
  try {
    await pool.query(`
      ALTER TABLE api_request_logs 
      DROP COLUMN IF EXISTS api_protocol
    `)
    console.log('[Migration] api_protocol column removed successfully')
    return true
  } catch (error) {
    console.error('[Migration] Failed to remove api_protocol column:', error.message)
    throw error
  }
}