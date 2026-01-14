#!/usr/bin/env node
/**
 * V2 API 测试脚本
 * 
 * 用于验证重构后的 v2 API 和数据库迁移功能
 * 
 * 使用方法:
 *   node scripts/test-v2-api.js [options]
 * 
 * 选项:
 *   --base-url <url>    API 基础 URL (默认: http://localhost:3000)
 *   --token <token>     认证 Token (如果启用了认证)
 *   --skip-migration    跳过数据库迁移测试
 *   --verbose           显示详细输出
 */

const http = require('http')
const https = require('https')
const { URL } = require('url')

// 解析命令行参数
const args = process.argv.slice(2)
const options = {
  baseUrl: 'http://localhost:3000',
  token: null,
  skipMigration: false,
  verbose: false
}

for (let i = 0; i < args.length; i++) {
  switch (args[i]) {
    case '--base-url':
      options.baseUrl = args[++i]
      break
    case '--token':
      options.token = args[++i]
      break
    case '--skip-migration':
      options.skipMigration = true
      break
    case '--verbose':
      options.verbose = true
      break
    case '--help':
      console.log(`
V2 API 测试脚本

使用方法:
  node scripts/test-v2-api.js [options]

选项:
  --base-url <url>    API 基础 URL (默认: http://localhost:3000)
  --token <token>     认证 Token (如果启用了认证)
  --skip-migration    跳过数据库迁移测试
  --verbose           显示详细输出
  --help              显示帮助信息
`)
      process.exit(0)
  }
}

// 测试结果统计
const results = {
  passed: 0,
  failed: 0,
  skipped: 0,
  errors: []
}

// HTTP 请求工具函数
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, options.baseUrl)
    const isHttps = url.protocol === 'https:'
    const lib = isHttps ? https : http

    const reqOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    }

    if (options.token) {
      reqOptions.headers['Authorization'] = `Bearer ${options.token}`
    }

    if (body) {
      const bodyStr = JSON.stringify(body)
      reqOptions.headers['Content-Length'] = Buffer.byteLength(bodyStr)
    }

    const req = lib.request(reqOptions, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => {
        try {
          const json = data ? JSON.parse(data) : null
          resolve({ status: res.statusCode, data: json, headers: res.headers })
        } catch (e) {
          resolve({ status: res.statusCode, data: data, headers: res.headers })
        }
      })
    })

    req.on('error', reject)

    if (body) {
      req.write(JSON.stringify(body))
    }
    req.end()
  })
}

// 测试辅助函数
function log(message, level = 'info') {
  const prefix = {
    info: '\x1b[36mℹ\x1b[0m',
    success: '\x1b[32m✓\x1b[0m',
    error: '\x1b[31m✗\x1b[0m',
    warn: '\x1b[33m⚠\x1b[0m',
    debug: '\x1b[90m·\x1b[0m'
  }
  if (level === 'debug' && !options.verbose) return
  console.log(`${prefix[level] || '·'} ${message}`)
}

async function test(name, fn) {
  try {
    log(`测试: ${name}`, 'info')
    await fn()
    results.passed++
    log(`通过: ${name}`, 'success')
  } catch (error) {
    results.failed++
    results.errors.push({ name, error: error.message })
    log(`失败: ${name} - ${error.message}`, 'error')
    if (options.verbose) {
      console.error(error)
    }
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed')
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `Expected ${expected}, got ${actual}`)
  }
}

function assertOk(response, message) {
  if (!response.data?.success && response.status >= 400) {
    throw new Error(message || `Request failed with status ${response.status}: ${JSON.stringify(response.data)}`)
  }
}

// 生成测试数据
function generateTestId() {
  return `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
}

// ==================== 测试用例 ====================

async function testHealthCheck() {
  const res = await request('GET', '/api/health')
  assert(res.status === 200, `Health check failed with status ${res.status}`)
}

async function testV1DataEndpoint() {
  // 测试旧的 /api/data 接口仍然可用
  const res = await request('GET', '/api/data')
  assert(res.status === 200 || res.status === 401, `V1 /api/data endpoint failed with status ${res.status}`)
  if (res.status === 200) {
    assert(res.data.accounts !== undefined, 'V1 /api/data should return accounts')
    assert(res.data.groups !== undefined, 'V1 /api/data should return groups')
    assert(res.data.tags !== undefined, 'V1 /api/data should return tags')
  }
}

async function testSyncSnapshot() {
  const res = await request('GET', '/api/v2/sync/snapshot')
  if (res.status === 401) {
    log('需要认证，跳过 sync/snapshot 测试', 'warn')
    results.skipped++
    return
  }
  assertOk(res, 'Sync snapshot failed')
  assert(res.data.data?.serverTime, 'Snapshot should include serverTime')
  assert(res.data.data?.snapshotVersion, 'Snapshot should include snapshotVersion')
  log(`Snapshot version: ${res.data.data.snapshotVersion}`, 'debug')
}

async function testSyncChanges() {
  const modifiedSince = Date.now() - 24 * 60 * 60 * 1000 // 24小时前
  const res = await request('GET', `/api/v2/sync/changes?modifiedSince=${modifiedSince}`)
  if (res.status === 401) {
    log('需要认证，跳过 sync/changes 测试', 'warn')
    results.skipped++
    return
  }
  assertOk(res, 'Sync changes failed')
  assert(res.data.data?.serverTime, 'Changes should include serverTime')
  assert(res.data.data?.modifiedSince === modifiedSince, 'Changes should echo modifiedSince')
}

async function testAccountsV2List() {
  const res = await request('GET', '/api/v2/accounts')
  if (res.status === 401) {
    log('需要认证，跳过 accounts list 测试', 'warn')
    results.skipped++
    return
  }
  assertOk(res, 'Accounts list failed')
  assert(Array.isArray(res.data.data?.accounts), 'Should return accounts array')
  assert(res.data.data?.pagination, 'Should include pagination info')
  log(`Found ${res.data.data.accounts.length} accounts`, 'debug')
}

async function testAccountsV2Pagination() {
  const res = await request('GET', '/api/v2/accounts?page=1&pageSize=5')
  if (res.status === 401) {
    log('需要认证，跳过 accounts pagination 测试', 'warn')
    results.skipped++
    return
  }
  assertOk(res, 'Accounts pagination failed')
  assert(res.data.data?.pagination?.page === 1, 'Page should be 1')
  assert(res.data.data?.pagination?.pageSize === 5, 'PageSize should be 5')
}

async function testAccountsV2CRUD() {
  const testId = generateTestId()
  const testEmail = `test-${testId}@example.com`

  // 创建账号
  const createRes = await request('POST', '/api/v2/accounts', {
    id: testId,
    email: testEmail,
    idp: 'Google',
    credentials: {
      accessToken: 'test-token',
      refreshToken: 'test-refresh',
      expiresAt: Date.now() + 3600000
    },
    subscription: { type: 'Free' },
    usage: { current: 0, limit: 25, percentUsed: 0, lastUpdated: Date.now() },
    status: 'active',
    tags: []
  })

  if (createRes.status === 401) {
    log('需要认证，跳过 accounts CRUD 测试', 'warn')
    results.skipped++
    return
  }

  assertOk(createRes, 'Create account failed')
  assertEqual(createRes.data.data?.version, 1, 'New account should have version 1')
  log(`Created account: ${testId}`, 'debug')

  // 获取账号
  const getRes = await request('GET', `/api/v2/accounts/${testId}`)
  assertOk(getRes, 'Get account failed')
  assertEqual(getRes.data.data?.email, testEmail, 'Email should match')

  // 更新账号（带版本号）
  const updateRes = await request('PUT', `/api/v2/accounts/${testId}`, {
    version: 1,
    nickname: 'Test User'
  })
  assertOk(updateRes, 'Update account failed')
  assertEqual(updateRes.data.data?.version, 2, 'Updated account should have version 2')
  log(`Updated account: ${testId}, new version: 2`, 'debug')

  // 删除账号
  const deleteRes = await request('DELETE', `/api/v2/accounts/${testId}`)
  assertOk(deleteRes, 'Delete account failed')
  assert(deleteRes.data.data?.deleted, 'Account should be marked as deleted')
  log(`Deleted account: ${testId}`, 'debug')
}

async function testVersionConflict() {
  const testId = generateTestId()
  const testEmail = `conflict-${testId}@example.com`

  // 创建账号
  const createRes = await request('POST', '/api/v2/accounts', {
    id: testId,
    email: testEmail,
    idp: 'Google',
    credentials: {
      accessToken: 'test-token',
      refreshToken: 'test-refresh',
      expiresAt: Date.now() + 3600000
    },
    subscription: { type: 'Free' },
    usage: { current: 0, limit: 25, percentUsed: 0, lastUpdated: Date.now() },
    status: 'active',
    tags: []
  })

  if (createRes.status === 401) {
    log('需要认证，跳过版本冲突测试', 'warn')
    results.skipped++
    return
  }

  assertOk(createRes, 'Create account failed')

  // 第一次更新（成功）
  const update1Res = await request('PUT', `/api/v2/accounts/${testId}`, {
    version: 1,
    nickname: 'First Update'
  })
  assertOk(update1Res, 'First update failed')

  // 第二次更新使用旧版本号（应该失败，返回 409）
  const update2Res = await request('PUT', `/api/v2/accounts/${testId}`, {
    version: 1, // 使用旧版本号
    nickname: 'Second Update'
  })
  assertEqual(update2Res.status, 409, 'Should return 409 for version conflict')
  assertEqual(update2Res.data?.error, 'VERSION_CONFLICT', 'Should return VERSION_CONFLICT error')
  assert(update2Res.data?.serverData, 'Should return server data on conflict')
  log(`Version conflict detected correctly`, 'debug')

  // 清理：删除测试账号
  await request('DELETE', `/api/v2/accounts/${testId}`)
}

async function testGroupsV2() {
  const testId = generateTestId()

  // 创建分组
  const createRes = await request('POST', '/api/v2/groups', {
    id: testId,
    name: 'Test Group',
    color: '#ff0000',
    order: 0
  })

  if (createRes.status === 401) {
    log('需要认证，跳过 groups 测试', 'warn')
    results.skipped++
    return
  }

  assertOk(createRes, 'Create group failed')
  assertEqual(createRes.data.data?.version, 1, 'New group should have version 1')

  // 获取分组列表
  const listRes = await request('GET', '/api/v2/groups')
  assertOk(listRes, 'List groups failed')
  assert(Array.isArray(listRes.data.data?.groups), 'Should return groups array')

  // 更新分组
  const updateRes = await request('PUT', `/api/v2/groups/${testId}`, {
    version: 1,
    name: 'Updated Group'
  })
  assertOk(updateRes, 'Update group failed')

  // 删除分组
  const deleteRes = await request('DELETE', `/api/v2/groups/${testId}`)
  assertOk(deleteRes, 'Delete group failed')
}

async function testTagsV2() {
  const testId = generateTestId()

  // 创建标签
  const createRes = await request('POST', '/api/v2/tags', {
    id: testId,
    name: 'Test Tag',
    color: '#00ff00'
  })

  if (createRes.status === 401) {
    log('需要认证，跳过 tags 测试', 'warn')
    results.skipped++
    return
  }

  assertOk(createRes, 'Create tag failed')
  assertEqual(createRes.data.data?.version, 1, 'New tag should have version 1')

  // 获取标签列表
  const listRes = await request('GET', '/api/v2/tags')
  assertOk(listRes, 'List tags failed')
  assert(Array.isArray(listRes.data.data?.tags), 'Should return tags array')

  // 更新标签
  const updateRes = await request('PUT', `/api/v2/tags/${testId}`, {
    version: 1,
    name: 'Updated Tag'
  })
  assertOk(updateRes, 'Update tag failed')

  // 删除标签
  const deleteRes = await request('DELETE', `/api/v2/tags/${testId}`)
  assertOk(deleteRes, 'Delete tag failed')
}

async function testSettingsV2() {
  const testKey = `test-setting-${Date.now()}`

  // 创建/更新设置
  const updateRes = await request('PUT', `/api/v2/settings/${testKey}`, {
    value: { test: true, timestamp: Date.now() }
  })

  if (updateRes.status === 401) {
    log('需要认证，跳过 settings 测试', 'warn')
    results.skipped++
    return
  }

  assertOk(updateRes, 'Update setting failed')

  // 获取设置
  const getRes = await request('GET', `/api/v2/settings/${testKey}`)
  assertOk(getRes, 'Get setting failed')
  assert(getRes.data.data?.value?.test === true, 'Setting value should match')

  // 获取所有设置
  const listRes = await request('GET', '/api/v2/settings')
  assertOk(listRes, 'List settings failed')
}

async function testBatchOperations() {
  const testIds = [generateTestId(), generateTestId()]

  // 批量创建账号
  const batchRes = await request('POST', '/api/v2/accounts/batch', {
    operations: testIds.map(id => ({
      action: 'create',
      data: {
        id,
        email: `batch-${id}@example.com`,
        idp: 'Google',
        credentials: {
          accessToken: 'test-token',
          refreshToken: 'test-refresh',
          expiresAt: Date.now() + 3600000
        },
        subscription: { type: 'Free' },
        usage: { current: 0, limit: 25, percentUsed: 0, lastUpdated: Date.now() },
        status: 'active',
        tags: []
      }
    })),
    stopOnError: false
  })

  if (batchRes.status === 401) {
    log('需要认证，跳过批量操作测试', 'warn')
    results.skipped++
    return
  }

  assertOk(batchRes, 'Batch create failed')
  assertEqual(batchRes.data.data?.summary?.succeeded, 2, 'Should create 2 accounts')
  log(`Batch created ${batchRes.data.data?.summary?.succeeded} accounts`, 'debug')

  // 清理：批量删除
  const deleteRes = await request('POST', '/api/v2/accounts/batch', {
    operations: testIds.map(id => ({
      action: 'delete',
      data: { id }
    }))
  })
  assertOk(deleteRes, 'Batch delete failed')
}

async function testSyncPush() {
  const testId = generateTestId()

  // 推送变更
  const pushRes = await request('POST', '/api/v2/sync/push', {
    changes: {
      accounts: {
        created: [{
          id: testId,
          email: `push-${testId}@example.com`,
          idp: 'Google',
          credentials: {
            accessToken: 'test-token',
            refreshToken: 'test-refresh',
            expiresAt: Date.now() + 3600000
          },
          subscription: { type: 'Free' },
          usage: { current: 0, limit: 25, percentUsed: 0, lastUpdated: Date.now() },
          status: 'active',
          tags: []
        }],
        updated: [],
        deleted: []
      }
    },
    clientTime: Date.now()
  })

  if (pushRes.status === 401) {
    log('需要认证，跳过 sync/push 测试', 'warn')
    results.skipped++
    return
  }

  assertOk(pushRes, 'Sync push failed')
  assert(pushRes.data.data?.serverTime, 'Push response should include serverTime')
  assert(pushRes.data.data?.results?.accounts, 'Push response should include results')
  log(`Push succeeded: ${pushRes.data.data?.summary?.accounts?.succeeded || 0} accounts`, 'debug')

  // 清理
  await request('DELETE', `/api/v2/accounts/${testId}`)
}

// ==================== 主函数 ====================

async function main() {
  console.log('\n\x1b[1m========================================\x1b[0m')
  console.log('\x1b[1m  V2 API 测试脚本\x1b[0m')
  console.log('\x1b[1m========================================\x1b[0m\n')
  console.log(`基础 URL: ${options.baseUrl}`)
  console.log(`认证: ${options.token ? '已配置' : '未配置'}`)
  console.log('')

  // 健康检查
  await test('健康检查', testHealthCheck)

  // 向后兼容性测试
  console.log('\n\x1b[1m--- 向后兼容性测试 ---\x1b[0m')
  await test('V1 /api/data 接口', testV1DataEndpoint)

  // V2 同步接口测试
  console.log('\n\x1b[1m--- V2 同步接口测试 ---\x1b[0m')
  await test('同步快照 (GET /api/v2/sync/snapshot)', testSyncSnapshot)
  await test('增量变更 (GET /api/v2/sync/changes)', testSyncChanges)
  await test('推送变更 (POST /api/v2/sync/push)', testSyncPush)

  // V2 账号接口测试
  console.log('\n\x1b[1m--- V2 账号接口测试 ---\x1b[0m')
  await test('账号列表 (GET /api/v2/accounts)', testAccountsV2List)
  await test('账号分页', testAccountsV2Pagination)
  await test('账号 CRUD', testAccountsV2CRUD)
  await test('版本冲突检测 (409 响应)', testVersionConflict)
  await test('批量操作', testBatchOperations)

  // V2 分组接口测试
  console.log('\n\x1b[1m--- V2 分组接口测试 ---\x1b[0m')
  await test('分组 CRUD', testGroupsV2)

  // V2 标签接口测试
  console.log('\n\x1b[1m--- V2 标签接口测试 ---\x1b[0m')
  await test('标签 CRUD', testTagsV2)

  // V2 设置接口测试
  console.log('\n\x1b[1m--- V2 设置接口测试 ---\x1b[0m')
  await test('设置 CRUD', testSettingsV2)

  // 输出结果
  console.log('\n\x1b[1m========================================\x1b[0m')
  console.log('\x1b[1m  测试结果\x1b[0m')
  console.log('\x1b[1m========================================\x1b[0m\n')
  console.log(`\x1b[32m通过: ${results.passed}\x1b[0m`)
  console.log(`\x1b[31m失败: ${results.failed}\x1b[0m`)
  console.log(`\x1b[33m跳过: ${results.skipped}\x1b[0m`)

  if (results.errors.length > 0) {
    console.log('\n\x1b[31m失败的测试:\x1b[0m')
    for (const { name, error } of results.errors) {
      console.log(`  - ${name}: ${error}`)
    }
  }

  console.log('')

  // 退出码
  process.exit(results.failed > 0 ? 1 : 0)
}

main().catch(error => {
  console.error('\x1b[31m测试脚本执行失败:\x1b[0m', error)
  process.exit(1)
})