/**
 * 机器码 API 路由
 */
import { Router } from 'express'
import { pool } from '../db/index.js'

const router = Router()

// 获取机器码配置
router.get('/api/machine-id/config', async (req, res) => {
  try {
    const [rows] = await pool.query("SELECT value FROM settings WHERE `key` = 'machineIdConfig'")
    if (rows.length > 0) {
      res.json(JSON.parse(rows[0].value))
    } else {
      // 默认配置：启用切换账号时自动更换机器码
      res.json({
        autoSwitchOnAccountChange: true,
        bindMachineIdToAccount: false,
        useBindedMachineId: false
      })
    }
  } catch (error) {
    console.error('Get machine id config error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 保存机器码配置
router.post('/api/machine-id/config', async (req, res) => {
  try {
    const config = req.body
    await pool.query(
      "INSERT INTO settings (`key`, value, value_type) VALUES ('machineIdConfig', ?, 'json') ON DUPLICATE KEY UPDATE value = ?",
      [JSON.stringify(config), JSON.stringify(config)]
    )
    res.json({ success: true })
  } catch (error) {
    console.error('Save machine id config error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取所有账号机器码绑定
router.get('/api/machine-id/bindings', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM account_machine_ids')
    const bindings = {}
    for (const row of rows) {
      bindings[row.account_id] = row.machine_id
    }
    res.json(bindings)
  } catch (error) {
    console.error('Get bindings error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 绑定账号机器码
router.post('/api/machine-id/bindings/:accountId', async (req, res) => {
  try {
    const { accountId } = req.params
    const { machineId } = req.body
    await pool.query(
      'INSERT INTO account_machine_ids (account_id, machine_id) VALUES (?, ?) ON DUPLICATE KEY UPDATE machine_id = ?',
      [accountId, machineId, machineId]
    )
    res.json({ success: true })
  } catch (error) {
    console.error('Bind machine id error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 解绑账号机器码
router.delete('/api/machine-id/bindings/:accountId', async (req, res) => {
  try {
    await pool.query('DELETE FROM account_machine_ids WHERE account_id = ?', [req.params.accountId])
    res.json({ success: true })
  } catch (error) {
    console.error('Unbind machine id error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 获取机器码历史
router.get('/api/machine-id/history', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM machine_id_history ORDER BY timestamp DESC')
    res.json(
      rows.map((row) => ({
        id: row.id,
        machineId: row.machine_id,
        timestamp: row.timestamp,
        action: row.action
      }))
    )
  } catch (error) {
    console.error('Get history error:', error)
    res.status(500).json({ error: error.message })
  }
})

// 添加机器码历史记录
router.post('/api/machine-id/history', async (req, res) => {
  try {
    const { id, machineId, timestamp, action } = req.body
    await pool.query(
      'INSERT INTO machine_id_history (id, machine_id, timestamp, action) VALUES (?, ?, ?, ?)',
      [id, machineId, timestamp, action]
    )
    res.json({ success: true })
  } catch (error) {
    console.error('Add history error:', error)
    res.status(500).json({ error: error.message })
  }
})

export default router
