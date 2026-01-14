/**
 * 设置 API 路由
 */
import { Router } from 'express'
import { pool } from '../db/index.js'

const router = Router()

// 获取所有设置
router.get('/api/settings', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM settings')
    const settings = {}
    for (const row of rows) {
      if (row.value_type === 'json') {
        settings[row.key] = JSON.parse(row.value)
      } else if (row.value_type === 'boolean') {
        settings[row.key] = row.value === 'true'
      } else if (row.value_type === 'number') {
        settings[row.key] = Number(row.value)
      } else {
        settings[row.key] = row.value
      }
    }
    res.json(settings)
  } catch (error) {
    console.error('Get settings error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取单个设置
router.get('/api/settings/:key', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM settings WHERE `key` = ?', [req.params.key])
    if (rows.length > 0) {
      const row = rows[0]
      let value
      if (row.value_type === 'json') {
        value = JSON.parse(row.value)
      } else if (row.value_type === 'boolean') {
        value = row.value === 'true'
      } else if (row.value_type === 'number') {
        value = Number(row.value)
      } else {
        value = row.value
      }
      res.json(value)
    } else {
      res.json(null)
    }
  } catch (error) {
    console.error('Get setting error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 保存单个设置
router.post('/api/settings/:key', async (req, res) => {
  try {
    const { key } = req.params
    const value = req.body.value !== undefined ? req.body.value : req.body
    const valueType = typeof value === 'object' ? 'json' : typeof value
    const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value)
    await pool.query(
      'INSERT INTO settings (`key`, value, value_type) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = ?, value_type = ?',
      [key, valueStr, valueType, valueStr, valueType]
    )
    res.json({ success: true })
  } catch (error) {
    console.error('Save setting error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 批量保存设置
router.post('/api/settings', async (req, res) => {
  try {
    const settings = req.body
    for (const [key, value] of Object.entries(settings)) {
      const valueType = typeof value === 'object' ? 'json' : typeof value
      const valueStr = typeof value === 'object' ? JSON.stringify(value) : String(value)
      await pool.query(
        'INSERT INTO settings (`key`, value, value_type) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = ?, value_type = ?',
        [key, valueStr, valueType, valueStr, valueType]
      )
    }
    res.json({ success: true })
  } catch (error) {
    console.error('Save settings error:', error)
    res.status(500).json({ error: error.message })
  }
})

export default router
