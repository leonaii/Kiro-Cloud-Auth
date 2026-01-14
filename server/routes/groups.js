/**
 * 分组 API 路由
 */
import { Router } from 'express'
import { pool } from '../db/index.js'

const router = Router()

// 获取所有分组 (对象格式)
router.get('/api/groups', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM `groups` ORDER BY `order`')
    const groups = {}
    for (const row of rows) {
      groups[row.id] = {
        id: row.id,
        name: row.name,
        color: row.color,
        order: row.order,
        createdAt: row.created_at
      }
    }
    res.json(groups)
  } catch (error) {
    console.error('Get groups error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取分组列表 (数组格式)
router.get('/api/groups/list', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM `groups` ORDER BY `order`')
    res.json(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        color: row.color,
        order: row.order,
        createdAt: row.created_at
      }))
    )
  } catch (error) {
    console.error('Get groups list error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 创建/更新分组
router.post('/api/groups/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { name, color, order, createdAt } = req.body
    await pool.query(
      'INSERT INTO `groups` (id, name, color, `order`, created_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = ?, color = ?, `order` = ?',
      [id, name, color, order || 0, createdAt || Date.now(), name, color, order || 0]
    )
    res.json({ success: true })
  } catch (error) {
    console.error('Save group error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 删除分组
router.delete('/api/groups/:id', async (req, res) => {
  try {
    const { id } = req.params
    await pool.query('DELETE FROM `groups` WHERE id = ?', [id])
    await pool.query('UPDATE accounts SET group_id = NULL WHERE group_id = ?', [id])
    res.json({ success: true })
  } catch (error) {
    console.error('Delete group error:', error)
    res.status(500).json({ error: error.message })
  }
})

export default router
