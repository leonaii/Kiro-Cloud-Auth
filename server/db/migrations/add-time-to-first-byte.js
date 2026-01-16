/**
 * 数据库迁移：为 api_request_logs 表添加 time_to_first_byte 字段
 * 
 * 变更内容：
 * 1. api_request_logs 表添加 time_to_first_byte 字段（流式请求首字响应时间）
 * 
 * 使用方法：
 * node server/db/migrations/add-time-to-first-byte.js
 */

import mysql from 'mysql2/promise'
import dotenv from 'dotenv'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

// 加载环境变量
dotenv.config({ path: join(__dirname, '../../.env') })

// 数据库配置
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'kiro_accounts'
}

async function migrate() {
  let connection = null
  
  try {
    console.log('🔗 连接数据库...')
    connection = await mysql.createConnection(dbConfig)
    console.log('✅ 数据库连接成功')
    
    // 检查并添加 api_request_logs 表的新字段
    console.log('\n📝 检查 api_request_logs 表...')
    
    // 检查 time_to_first_byte 字段
    const [timeToFirstByteExists] = await connection.query(`
      SELECT COUNT(*) as count 
      FROM information_schema.COLUMNS 
      WHERE TABLE_SCHEMA = ? 
      AND TABLE_NAME = 'api_request_logs' 
      AND COLUMN_NAME = 'time_to_first_byte'
    `, [dbConfig.database])
    
    if (timeToFirstByteExists[0].count === 0) {
      console.log('➕ 添加 time_to_first_byte 字段到 api_request_logs...')
      await connection.query(`
        ALTER TABLE api_request_logs 
        ADD COLUMN time_to_first_byte INT DEFAULT NULL 
        AFTER duration_ms
      `)
      console.log('✅ time_to_first_byte 字段添加成功')
    } else {
      console.log('⏭️  time_to_first_byte 字段已存在，跳过')
    }
    
    console.log('\n🎉 迁移完成！')
    console.log('\n📊 迁移摘要：')
    console.log('  - api_request_logs.time_to_first_byte: 流式请求首字响应时间（毫秒），非流式请求为 NULL')
    
  } catch (error) {
    console.error('❌ 迁移失败:', error.message)
    console.error(error.stack)
    process.exit(1)
  } finally {
    if (connection) {
      await connection.end()
      console.log('\n🔌 数据库连接已关闭')
    }
  }
}

// 执行迁移
migrate()