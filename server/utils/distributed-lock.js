/**
 * 分布式锁工具模块
 * 基于MySQL GET_LOCK()/RELEASE_LOCK() 实现分布式锁
 *
 * MySQL的GET_LOCK()是跨连接的，天然支持分布式场景
 * 锁超时后自动释放，防止死锁
 */

import { pool } from '../db/index.js'

// 锁统计信息
const lockStats = {
  acquired: 0,
  released: 0,
  failed: 0,
  timeout: 0,
  errors: 0
}

/**
 * 获取分布式锁
 * @param {string} lockName - 锁名称，建议格式：kiro:refresh:{accountId} 或 kiro:pool:{groupId}
 * @param {number} timeout - 锁超时时间（秒），默认60秒
 * @returns {Promise<{success: boolean, connection: any}>} - 返回是否成功获取锁和连接对象
 */
export async function acquireLock(lockName, timeout = 60) {
  let connection = null
  
  try {
    // 获取独立连接，避免事务回滚时锁被释放
    connection = await pool.getConnection()
    
    // 使用GET_LOCK获取命名锁
    // 返回值：1=成功获取锁，0=超时未获取到锁，NULL=发生错误
    const [rows] = await connection.query('SELECT GET_LOCK(?, ?) as lockResult', [lockName, timeout])
    const lockResult = rows[0]?.lockResult
    
    if (lockResult === 1) {
      lockStats.acquired++
      return { success: true, connection }
    } else if (lockResult === 0) {
      // 超时未获取到锁
      lockStats.timeout++
      connection.release()
      return { success: false, connection: null }
    } else {
      // NULL表示发生错误
      lockStats.errors++
      connection.release()
      return { success: false, connection: null }
    }
  } catch (error) {
    lockStats.errors++
    if (connection) {
      connection.release()
    }
    console.error(`[DistributedLock] 获取锁失败 (${lockName}):`, error.message)
    return { success: false, connection: null }
  }
}

/**
 * 释放分布式锁
 * @param {string} lockName - 锁名称
 * @param {any} connection - 获取锁时返回的连接对象
 * @returns {Promise<boolean>} - 返回是否成功释放锁
 */
export async function releaseLock(lockName, connection) {
  if (!connection) {
    console.warn(`[DistributedLock] 释放锁失败 (${lockName}): 连接为空`)
    return false
  }
  
  try {
    // 使用RELEASE_LOCK释放锁
    // 返回值：1=成功释放，0=锁不是由当前连接持有，NULL=锁不存在
    const [rows] = await connection.query('SELECT RELEASE_LOCK(?) as releaseResult', [lockName])
    const releaseResult = rows[0]?.releaseResult
    
    if (releaseResult === 1) {
      lockStats.released++
      return true
    } else {
      console.warn(`[DistributedLock] 释放锁异常 (${lockName}): 结果=${releaseResult}`)
      return false
    }
  } catch (error) {
    lockStats.errors++
    console.error(`[DistributedLock] 释放锁失败 (${lockName}):`, error.message)
    return false
  } finally {
    // 无论如何都要释放连接
    try {
      connection.release()
    } catch (e) {
      // 忽略连接释放错误
    }
  }
}

/**
 * 使用分布式锁执行回调函数
 * 自动获取锁、执行回调、释放锁，并处理异常
 * 
 * @param {string} lockName - 锁名称
 * @param {number} timeout - 锁超时时间（秒），默认60秒
 * @param {Function} callback - 要执行的异步回调函数
 * @returns {Promise<{success: boolean, result?: any, error?: Error, lockAcquired: boolean}>}
 */
export async function withLock(lockName, timeout, callback) {
  const startTime = Date.now()
  
  // 获取锁
  const { success: lockAcquired, connection } = await acquireLock(lockName, timeout)
  
  if (!lockAcquired) {
    return {
      success: false,
      lockAcquired: false,
      error: new Error(`无法获取锁: ${lockName}`)
    }
  }
  
  const lockAcquireTime = Date.now() - startTime
  
  try {
    // 执行回调
    const result = await callback()
    
    return {
      success: true,
      lockAcquired: true,
      result,
      lockAcquireTime
    }
  } catch (error) {
    return {
      success: false,
      lockAcquired: true,
      error,
      lockAcquireTime
    }
  } finally {
    // 释放锁
    await releaseLock(lockName, connection)
  }
}

/**
 * 尝试获取锁，如果获取失败则立即返回（非阻塞）
 * @param {string} lockName - 锁名称
 * @returns {Promise<{success: boolean, connection: any}>}
 */
export async function tryAcquireLock(lockName) {
  return acquireLock(lockName, 0) // timeout=0 表示立即返回
}

/**
 * 检查锁是否被持有（不获取锁）
 * @param {string} lockName - 锁名称
 * @returns {Promise<boolean>} - 返回锁是否空闲（true=空闲，false=被持有）
 */
export async function isLockFree(lockName) {
  try {
    // IS_FREE_LOCK返回：1=锁空闲，0=锁被持有，NULL=发生错误
    const [rows] = await pool.query('SELECT IS_FREE_LOCK(?) as isFree', [lockName])
    return rows[0]?.isFree === 1
  } catch (error) {
    console.error(`[DistributedLock] 检查锁状态失败 (${lockName}):`, error.message)
    return false
  }
}

/**
 * 检查当前连接是否持有指定锁
 * @param {string} lockName - 锁名称
 * @param {any} connection - 连接对象
 * @returns {Promise<boolean>}
 */
export async function isLockHeld(lockName, connection) {
  if (!connection) {
    return false
  }
  
  try {
    // IS_USED_LOCK返回持有锁的连接ID，如果锁未被持有则返回NULL
    const [rows] = await connection.query('SELECT IS_USED_LOCK(?) as holderId, CONNECTION_ID() as currentId', [lockName])
    const { holderId, currentId } = rows[0] || {}
    return holderId === currentId
  } catch (error) {
    console.error(`[DistributedLock] 检查锁持有状态失败 (${lockName}):`, error.message)
    return false
  }
}

/**
 * 获取锁统计信息
 * @returns {Object} 锁统计信息
 */
export function getLockStats() {
  return {
    ...lockStats,
    successRate: lockStats.acquired > 0 
      ? ((lockStats.acquired / (lockStats.acquired + lockStats.failed + lockStats.timeout)) * 100).toFixed(2) + '%'
      : 'N/A'
  }
}

/**
 * 重置锁统计信息
 */
export function resetLockStats() {
  lockStats.acquired = 0
  lockStats.released = 0
  lockStats.failed = 0
  lockStats.timeout = 0
  lockStats.errors = 0
}

/**
 * 锁命名工具函数
 */
export const LockNames = {
  /**
   * Token刷新锁
   * @param {string|number} accountId - 账号ID
   * @returns {string}
   */
  tokenRefresh: (accountId) => `kiro:refresh:${accountId}`,
  
  /**
   * 账号池轮询锁
   * @param {string} groupId - 分组ID
   * @returns {string}
   */
  poolRoundRobin: (groupId) => `kiro:pool:${groupId}`,
  
  /**
   * 账号更新锁
   * @param {string|number} accountId - 账号ID
   * @returns {string}
   */
  accountUpdate: (accountId) => `kiro:account:${accountId}`,
  
  /**
   * 批量操作锁
   * @param {string} operationId - 操作ID
   * @returns {string}
   */
  batchOperation: (operationId) => `kiro:batch:${operationId}`
}

export default {
  acquireLock,
  releaseLock,
  withLock,
  tryAcquireLock,
  isLockFree,
  isLockHeld,
  getLockStats,
  resetLockStats,
  LockNames
}