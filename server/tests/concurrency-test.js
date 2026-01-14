/**
 * 并发控制测试脚本
 * 测试分布式锁、轮询索引原子操作、版本冲突处理等功能
 * 
 * 使用方法:
 *   node server/tests/concurrency-test.js [test-name]
 * 
 * 可用测试:
 *   - round-robin: 测试轮询索引并发更新
 *   - distributed-lock: 测试分布式锁
 *   - version-conflict: 测试版本冲突处理
 *   - all: 运行所有测试
 */

import { pool, getConnectionWithRetry, getPoolStats } from '../config/database.js'
import { acquireLock, releaseLock, withLock, LockNames, getLockStats } from '../utils/distributed-lock.js'

// 测试配置
const TEST_CONFIG = {
  // 轮询索引测试
  ROUND_ROBIN: {
    CONCURRENT_REQUESTS: 50,
    TEST_GROUP_ID: 'test-group-' + Date.now(),
    ACCOUNT_COUNT: 5
  },
  // 分布式锁测试
  DISTRIBUTED_LOCK: {
    CONCURRENT_WORKERS: 10,
    LOCK_NAME: 'test:lock:' + Date.now(),
    LOCK_TIMEOUT: 5,
    WORK_DURATION_MS: 100
  },
  // 版本冲突测试
  VERSION_CONFLICT: {
    CONCURRENT_UPDATES: 20,
    TEST_ACCOUNT_ID: 'test-account-' + Date.now()
  }
}

// 测试结果收集器
class TestResults {
  constructor(testName) {
    this.testName = testName
    this.startTime = Date.now()
    this.results = []
    this.errors = []
    this.stats = {}
  }

  addResult(result) {
    this.results.push(result)
  }

  addError(error) {
    this.errors.push(error)
  }

  setStats(stats) {
    this.stats = { ...this.stats, ...stats }
  }

  getSummary() {
    const duration = Date.now() - this.startTime
    const successCount = this.results.filter(r => r.success).length
    const failCount = this.results.filter(r => !r.success).length

    return {
      testName: this.testName,
      duration,
      total: this.results.length,
      success: successCount,
      failed: failCount,
      errors: this.errors,
      stats: this.stats
    }
  }

  print() {
    const summary = this.getSummary()
    console.log('\n' + '='.repeat(60))
    console.log(`测试: ${summary.testName}`)
    console.log('='.repeat(60))
    console.log(`耗时: ${summary.duration}ms`)
    console.log(`总数: ${summary.total}`)
    console.log(`成功: ${summary.success}`)
    console.log(`失败: ${summary.failed}`)
    
    if (Object.keys(summary.stats).length > 0) {
      console.log('\n统计信息:')
      console.log(JSON.stringify(summary.stats, null, 2))
    }
    
    if (summary.errors.length > 0) {
      console.log('\n错误列表:')
      summary.errors.forEach((err, i) => {
        console.log(`  ${i + 1}. ${err}`)
      })
    }
    
    console.log('='.repeat(60) + '\n')
    
    return summary.failed === 0
  }
}

// ==================== 轮询索引测试 ====================

async function testRoundRobin() {
  const results = new TestResults('轮询索引并发测试')
  const config = TEST_CONFIG.ROUND_ROBIN
  
  console.log(`\n开始轮询索引测试: ${config.CONCURRENT_REQUESTS} 个并发请求`)
  
  // 初始化测试数据
  const conn = await getConnectionWithRetry({ operationName: 'testRoundRobin' })
  try {
    // 插入测试轮询索引记录
    await conn.query(
      `INSERT INTO pool_round_robin (group_id, current_index, account_count, updated_at)
       VALUES (?, 0, ?, ?)
       ON DUPLICATE KEY UPDATE current_index = 0, account_count = ?, updated_at = ?`,
      [config.TEST_GROUP_ID, config.ACCOUNT_COUNT, Date.now(), config.ACCOUNT_COUNT, Date.now()]
    )
  } finally {
    conn.release()
  }
  
  // 记录每个索引被选中的次数
  const indexCounts = new Map()
  for (let i = 0; i < config.ACCOUNT_COUNT; i++) {
    indexCounts.set(i, 0)
  }
  
  // 并发执行轮询索引更新
  const promises = []
  for (let i = 0; i < config.CONCURRENT_REQUESTS; i++) {
    promises.push(
      (async () => {
        const startTime = Date.now()
        try {
          const conn = await getConnectionWithRetry({ operationName: `roundRobin-${i}` })
          try {
            await conn.beginTransaction()
            
            // 获取并锁定当前索引
            const [rows] = await conn.query(
              `SELECT current_index, account_count FROM pool_round_robin 
               WHERE group_id = ? FOR UPDATE`,
              [config.TEST_GROUP_ID]
            )
            
            if (rows.length === 0) {
              throw new Error('轮询索引记录不存在')
            }
            
            const currentIndex = rows[0].current_index
            const accountCount = rows[0].account_count
            const nextIndex = (currentIndex + 1) % accountCount
            
            // 更新索引
            await conn.query(
              `UPDATE pool_round_robin SET current_index = ?, updated_at = ? WHERE group_id = ?`,
              [nextIndex, Date.now(), config.TEST_GROUP_ID]
            )
            
            await conn.commit()
            
            // 记录选中的索引
            indexCounts.set(currentIndex, (indexCounts.get(currentIndex) || 0) + 1)
            
            results.addResult({
              success: true,
              index: currentIndex,
              duration: Date.now() - startTime
            })
          } catch (error) {
            await conn.rollback()
            throw error
          } finally {
            conn.release()
          }
        } catch (error) {
          results.addResult({
            success: false,
            error: error.message,
            duration: Date.now() - startTime
          })
          results.addError(error.message)
        }
      })()
    )
  }
  
  await Promise.all(promises)
  
  // 计算分布统计
  const expectedCount = config.CONCURRENT_REQUESTS / config.ACCOUNT_COUNT
  const distribution = {}
  let maxDeviation = 0
  
  for (const [index, count] of indexCounts) {
    distribution[`index_${index}`] = count
    const deviation = Math.abs(count - expectedCount) / expectedCount
    maxDeviation = Math.max(maxDeviation, deviation)
  }
  
  results.setStats({
    distribution,
    expectedCountPerIndex: expectedCount,
    maxDeviationPercent: (maxDeviation * 100).toFixed(2) + '%',
    isBalanced: maxDeviation < 0.3 // 允许30%的偏差
  })
  
  // 清理测试数据
  const cleanupConn = await getConnectionWithRetry({ operationName: 'cleanup' })
  try {
    await cleanupConn.query('DELETE FROM pool_round_robin WHERE group_id = ?', [config.TEST_GROUP_ID])
  } finally {
    cleanupConn.release()
  }
  
  return results.print()
}

// ==================== 分布式锁测试 ====================

async function testDistributedLock() {
  const results = new TestResults('分布式锁并发测试')
  const config = TEST_CONFIG.DISTRIBUTED_LOCK
  
  console.log(`\n开始分布式锁测试: ${config.CONCURRENT_WORKERS} 个并发工作者`)
  
  // 共享计数器（用于验证锁的互斥性）
  let sharedCounter = 0
  let maxConcurrent = 0
  let currentConcurrent = 0
  const executionOrder = []
  
  // 并发执行带锁的操作
  const promises = []
  for (let i = 0; i < config.CONCURRENT_WORKERS; i++) {
    promises.push(
      (async () => {
        const workerId = i
        const startTime = Date.now()
        
        try {
          const result = await withLock(
            config.LOCK_NAME,
            config.LOCK_TIMEOUT,
            async () => {
              // 记录并发数
              currentConcurrent++
              maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
              
              // 记录执行顺序
              executionOrder.push(workerId)
              
              // 模拟工作
              await new Promise(resolve => setTimeout(resolve, config.WORK_DURATION_MS))
              
              // 更新共享计数器
              sharedCounter++
              
              currentConcurrent--
              
              return { workerId, counter: sharedCounter }
            }
          )
          
          results.addResult({
            success: true,
            workerId,
            counter: result.counter,
            duration: Date.now() - startTime
          })
        } catch (error) {
          results.addResult({
            success: false,
            workerId,
            error: error.message,
            duration: Date.now() - startTime
          })
          results.addError(`Worker ${workerId}: ${error.message}`)
        }
      })()
    )
  }
  
  await Promise.all(promises)
  
  // 验证结果
  const isSerialExecution = maxConcurrent === 1
  const allWorkersCompleted = sharedCounter === config.CONCURRENT_WORKERS
  
  results.setStats({
    sharedCounter,
    expectedCounter: config.CONCURRENT_WORKERS,
    maxConcurrentExecutions: maxConcurrent,
    isSerialExecution,
    allWorkersCompleted,
    executionOrder: executionOrder.slice(0, 10).join(' -> ') + (executionOrder.length > 10 ? '...' : ''),
    lockStats: getLockStats()
  })
  
  return results.print()
}

// ==================== 版本冲突测试 ====================

async function testVersionConflict() {
  const results = new TestResults('版本冲突处理测试')
  const config = TEST_CONFIG.VERSION_CONFLICT
  
  console.log(`\n开始版本冲突测试: ${config.CONCURRENT_UPDATES} 个并发更新`)
  
  // 创建测试账号
  const conn = await getConnectionWithRetry({ operationName: 'createTestAccount' })
  try {
    await conn.query(
      `INSERT INTO accounts (id, email, idp, credentials, subscription, \`usage\`, status, created_at, last_used_at, version)
       VALUES (?, ?, 'BuilderId', '{}', '{}', '{}', 'active', ?, ?, 1)
       ON DUPLICATE KEY UPDATE version = 1, modified_at = ?`,
      [config.TEST_ACCOUNT_ID, `test-${Date.now()}@example.com`, Date.now(), Date.now(), Date.now()]
    )
  } finally {
    conn.release()
  }
  
  // 记录版本冲突和重试统计
  let conflictCount = 0
  let retryCount = 0
  let successfulUpdates = 0
  
  // 并发执行更新操作
  const promises = []
  for (let i = 0; i < config.CONCURRENT_UPDATES; i++) {
    promises.push(
      (async () => {
        const updateId = i
        const startTime = Date.now()
        let attempts = 0
        const maxAttempts = 3
        
        while (attempts < maxAttempts) {
          attempts++
          
          try {
            const conn = await getConnectionWithRetry({ operationName: `update-${updateId}` })
            try {
              await conn.beginTransaction()
              
              // 获取当前版本
              const [rows] = await conn.query(
                'SELECT version FROM accounts WHERE id = ? FOR UPDATE',
                [config.TEST_ACCOUNT_ID]
              )
              
              if (rows.length === 0) {
                throw new Error('账号不存在')
              }
              
              const currentVersion = rows[0].version
              
              // 模拟一些处理时间
              await new Promise(resolve => setTimeout(resolve, Math.random() * 50))
              
              // 尝试更新（使用乐观锁）
              const [result] = await conn.query(
                `UPDATE accounts SET version = version + 1, modified_at = ?
                 WHERE id = ? AND version = ?`,
                [Date.now(), config.TEST_ACCOUNT_ID, currentVersion]
              )
              
              if (result.affectedRows === 0) {
                // 版本冲突
                conflictCount++
                await conn.rollback()
                
                if (attempts < maxAttempts) {
                  retryCount++
                  // 等待随机时间后重试
                  await new Promise(resolve => setTimeout(resolve, Math.random() * 100))
                  continue
                } else {
                  throw new Error('版本冲突，重试次数耗尽')
                }
              }
              
              await conn.commit()
              successfulUpdates++
              
              results.addResult({
                success: true,
                updateId,
                attempts,
                duration: Date.now() - startTime
              })
              
              return
            } catch (error) {
              await conn.rollback()
              throw error
            } finally {
              conn.release()
            }
          } catch (error) {
            if (attempts >= maxAttempts) {
              results.addResult({
                success: false,
                updateId,
                attempts,
                error: error.message,
                duration: Date.now() - startTime
              })
              results.addError(`Update ${updateId}: ${error.message}`)
            }
          }
        }
      })()
    )
  }
  
  await Promise.all(promises)
  
  // 获取最终版本号
  const finalConn = await getConnectionWithRetry({ operationName: 'getFinalVersion' })
  let finalVersion = 0
  try {
    const [rows] = await finalConn.query(
      'SELECT version FROM accounts WHERE id = ?',
      [config.TEST_ACCOUNT_ID]
    )
    finalVersion = rows[0]?.version || 0
  } finally {
    finalConn.release()
  }
  
  // 清理测试数据
  const cleanupConn = await getConnectionWithRetry({ operationName: 'cleanup' })
  try {
    await cleanupConn.query('DELETE FROM accounts WHERE id = ?', [config.TEST_ACCOUNT_ID])
  } finally {
    cleanupConn.release()
  }
  
  results.setStats({
    totalConflicts: conflictCount,
    totalRetries: retryCount,
    successfulUpdates,
    finalVersion,
    expectedVersion: 1 + successfulUpdates,
    versionCorrect: finalVersion === 1 + successfulUpdates
  })
  
  return results.print()
}

// ==================== 主函数 ====================

async function runTests(testName) {
  console.log('\n' + '='.repeat(60))
  console.log('并发控制测试套件')
  console.log('='.repeat(60))
  console.log(`时间: ${new Date().toISOString()}`)
  console.log(`测试: ${testName || 'all'}`)
  
  const allResults = []
  
  try {
    // 检查数据库连接
    console.log('\n检查数据库连接...')
    const conn = await getConnectionWithRetry({ operationName: 'healthCheck' })
    await conn.query('SELECT 1')
    conn.release()
    console.log('数据库连接正常')
    
    // 运行测试
    if (testName === 'round-robin' || testName === 'all') {
      allResults.push(await testRoundRobin())
    }
    
    if (testName === 'distributed-lock' || testName === 'all') {
      allResults.push(await testDistributedLock())
    }
    
    if (testName === 'version-conflict' || testName === 'all') {
      allResults.push(await testVersionConflict())
    }
    
    // 打印连接池统计
    console.log('\n连接池统计:')
    console.log(JSON.stringify(getPoolStats(), null, 2))
    
    // 总结
    console.log('\n' + '='.repeat(60))
    console.log('测试总结')
    console.log('='.repeat(60))
    const passedCount = allResults.filter(r => r).length
    const totalCount = allResults.length
    console.log(`通过: ${passedCount}/${totalCount}`)
    console.log('='.repeat(60) + '\n')
    
    // 退出码
    process.exit(passedCount === totalCount ? 0 : 1)
  } catch (error) {
    console.error('\n测试执行失败:', error)
    process.exit(1)
  } finally {
    // 关闭连接池
    await pool.end()
  }
}

// 解析命令行参数
const testName = process.argv[2] || 'all'
const validTests = ['round-robin', 'distributed-lock', 'version-conflict', 'all']

if (!validTests.includes(testName)) {
  console.error(`无效的测试名称: ${testName}`)
  console.error(`可用测试: ${validTests.join(', ')}`)
  process.exit(1)
}

runTests(testName)