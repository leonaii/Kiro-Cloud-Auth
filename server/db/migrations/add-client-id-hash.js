/**
 * 迁移脚本：添加 cred_client_id_hash 字段
 * 用于存储 OIDC 客户端 ID 哈希（用于本地 SSO 缓存查找）
 */

export async function up(pool) {
  console.log('[Migration] Adding cred_client_id_hash column to accounts table...')
  
  try {
    // 检查字段是否已存在
    const [columns] = await pool.query(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'accounts' 
      AND COLUMN_NAME = 'cred_client_id_hash'
    `)
    
    if (columns.length > 0) {
      console.log('[Migration] cred_client_id_hash column already exists, skipping...')
      return
    }
    
    // 添加 cred_client_id_hash 字段（在 cred_client_id 之后）
    await pool.query(`
      ALTER TABLE accounts 
      ADD COLUMN cred_client_id_hash VARCHAR(64) 
      AFTER cred_client_id
    `)
    
    console.log('[Migration] ✅ cred_client_id_hash column added successfully')
  } catch (error) {
    console.error('[Migration] ❌ Failed to add cred_client_id_hash column:', error.message)
    throw error
  }
}

export async function down(pool) {
  console.log('[Migration] Removing cred_client_id_hash column from accounts table...')
  
  try {
    await pool.query(`
      ALTER TABLE accounts 
      DROP COLUMN IF EXISTS cred_client_id_hash
    `)
    
    console.log('[Migration] ✅ cred_client_id_hash column removed successfully')
  } catch (error) {
    console.error('[Migration] ❌ Failed to remove cred_client_id_hash column:', error.message)
    throw error
  }
}

export default { up, down }