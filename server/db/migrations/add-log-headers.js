/**
 * 数据库迁移：为日志表添加header版本和请求头字段
 * 
 * 变更内容：
 * 1. api_request_logs 表添加 header_version 和 request_headers 字段
 * 2. system_logs 表添加 request_headers 字段
 * 
 * 使用方法：
 * node server/db/migrations/add-log-headers.js
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
    
    // 检查 header_version 字段
    const [headerVersionExists] = await connection.query(`
      SELECT COUNT(*) as count 
      FROM information_schema.COLUMNS 
      WHERE TABLE_SCHEMA = ? 
      AND TABLE_NAME = 'api_request_logs' 
      AND COLUMN_NAME = 'header_version'
    `, [dbConfig.database])
    
    if (headerVersionExists[0].count === 0) {
      console.log('➕ 添加 header_version 字段到 api_request_logs...')
      await connection.query(`
        ALTER TABLE api_request_logs 
        ADD COLUMN header_version INT DEFAULT 1 
        AFTER thinking_budget
      `)
      console.log('✅ header_version 字段添加成功')
    } else {
      console.log('⏭️  header_version 字段已存在，跳过')
    }
    
    // 检查 request_headers 字段 (api_request_logs)
    const [requestHeadersApiExists] = await connection.query(`
      SELECT COUNT(*) as count 
      FROM information_schema.COLUMNS 
      WHERE TABLE_SCHEMA = ? 
      AND TABLE_NAME = 'api_request_logs' 
      AND COLUMN_NAME = 'request_headers'
    `, [dbConfig.database])
    
    if (requestHeadersApiExists[0].count === 0) {
      console.log('➕ 添加 request_headers 字段到 api_request_logs...')
      await connection.query(`
        ALTER TABLE api_request_logs 
        ADD COLUMN request_headers TEXT 
        AFTER header_version
      `)
      console.log('✅ request_headers 字段添加成功')
    } else {
      console.log('⏭️  request_headers 字段已存在，跳过')
    }
    
    // 检查并添加 system_logs 表的新字段
    console.log('\n📝 检查 system_logs 表...')
    
    // 检查 request_headers 字段 (system_logs)
    const [requestHeadersSysExists] = await connection.query(`
      SELECT COUNT(*) as count 
      FROM information_schema.COLUMNS 
      WHERE TABLE_SCHEMA = ? 
      AND TABLE_NAME = 'system_logs' 
      AND COLUMN_NAME = 'request_headers'
    `, [dbConfig.database])
    
    if (requestHeadersSysExists[0].count === 0) {
      console.log('➕ 添加 request_headers 字段到 system_logs...')
      await connection.query(`
        ALTER TABLE system_logs 
        ADD COLUMN request_headers TEXT 
        AFTER duration_ms
      `)
      console.log('✅ request_headers 字段添加成功')
    } else {
      console.log('⏭️  request_headers 字段已存在，跳过')
    }
    
    console.log('\n🎉 迁移完成！')
    console.log('\n📊 迁移摘要：')
    console.log('  - api_request_logs.header_version: 记录Header版本（V1/V2）')
    console.log('  - api_request_logs.request_headers: 记录完整请求头（JSON格式）')
    console.log('  - system_logs.request_headers: 记录完整请求头（JSON格式）')
    
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