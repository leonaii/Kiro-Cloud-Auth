/**
 * 标签 API 路由
 */
import { Router } from 'express'
import { pool } from '../db/index.js'

const router = Router()

// 获取所有标签 (对象格式)
router.get('/api/tags', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tags')
    const tags = {}
    for (const row of rows) {
      tags[row.id] = {
        id: row.id,
        name: row.name,
        color: row.color,
        createdAt: row.created_at
      }
    }
    res.json(tags)
  } catch (error) {
    console.error('Get tags error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取标签列表 (数组格式)
router.get('/api/tags/list', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tags')
    res.json(
      rows.map((row) => ({
        id: row.id,
        name: row.name,
        color: row.color,
        createdAt: row.created_at
      }))
    )
  } catch (error) {
    console.error('Get tags list error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 创建/更新标签
router.post('/api/tags/:id', async (req, res) => {
  try {
    const { id } = req.params
    const { name, color, createdAt } = req.body
    await pool.query(
      'INSERT INTO tags (id, name, color, created_at) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = ?, color = ?',
      [id, name, color, createdAt || Date.now(), name, color]
    )
    res.json({ success: true })
  } catch (error) {
    console.error('Save tag error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 删除标签
router.delete('/api/tags/:id', async (req, res) => {
  try {
    const { id } = req.params
    await pool.query('DELETE FROM tags WHERE id = ?', [id])
    // 从账号中移除该标签
    const [accounts] = await pool.query('SELECT id, tags FROM accounts')
    for (const acc of accounts) {
      const tags = JSON.parse(acc.tags || '[]')
      const newTags = tags.filter((t) => t !== id)
      if (tags.length !== newTags.length) {
        await pool.query('UPDATE accounts SET tags = ? WHERE id = ?', [JSON.stringify(newTags), acc.id])
      }
    }
    res.json({ success: true })
  } catch (error) {
    console.error('Delete tag error:', error)
    res.status(500).json({ error: error.message })
  }
})

export default router
