/**
 * OpenAI 兼容 API 路由
 * 提供 /v1/chat/completions 等标准接口
 */

import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import KiroClient, { SUPPORTED_MODELS, checkThinkingMode } from '../kiro/index.js'
import AccountPool from './account-pool.js'
import RequestLogger from './request-logger.js'
import { validateApiKey } from './auth-middleware.js'
import { getClientIp } from '../utils/request-utils.js'
import { isRetryableError, isQuotaExhaustedError, isBannedError } from '../utils/retry-utils.js'
import { convertMessages, extractSystemPrompt, estimateTokens } from './openai-converter.js'
import { buildOpenAIResponse, buildStreamChunk, buildToolCallChunk } from './openai-response.js'

const router = Router()
let accountPool = null
let requestLogger = null
let systemLogger = null
let dbPool = null

// 从环境变量读取最大重试次数，默认5次
const MAX_ACCOUNT_RETRIES = parseInt(process.env.MAX_ACCOUNT_RETRIES || '5', 10)

/**
 * 初始化路由
 * @param {object} pool - 数据库连接池
 * @param {object} sysLogger - 系统日志实例
 * @param {object} sharedAccountPool - 共享的账号池实例（可选，如果不传则创建新实例）
 */
export function initOpenAIRoutes(pool, sysLogger = null, sharedAccountPool = null) {
  dbPool = pool
  systemLogger = sysLogger
  // 使用共享的 accountPool，如果没有则创建新的
  accountPool = sharedAccountPool || new AccountPool(dbPool, systemLogger)
  requestLogger = new RequestLogger(dbPool)
  requestLogger.startCleanup()
  return router
}

// ==================== API 路由 ====================

/**
 * GET /v1/models - 列出可用模型
 */
router.get('/v1/models', validateApiKey, async (req, res) => {
  const models = SUPPORTED_MODELS.map((id) => ({
    id,
    object: 'model',
    created: 1700000000,
    owned_by: 'kiro-proxy',
    permission: [],
    root: id,
    parent: null
  }))

  res.json({ object: 'list', data: models })
})

/**
 * GET /v1/models/:model - 获取模型详情
 */
router.get('/v1/models/:model', validateApiKey, async (req, res) => {
  const { model } = req.params

  if (!SUPPORTED_MODELS.includes(model)) {
    return res.status(404).json({
      error: {
        message: `Model '${model}' not found`,
        type: 'invalid_request_error',
        code: 'model_not_found'
      }
    })
  }

  res.json({
    id: model,
    object: 'model',
    created: 1700000000,
    owned_by: 'kiro-proxy',
    permission: [],
    root: model,
    parent: null
  })
})

// ==================== API 路由 ====================

/**
 * GET /v1/models - 列出可用模型
 */
router.post('/v1/chat/completions', validateApiKey, async (req, res) => {
  const requestId = uuidv4()
  const startTime = Date.now()
  const clientIp = getClientIp(req)
  const userAgent = req.headers['user-agent']

  const { messages, model = 'claude-sonnet-4-5', stream = false, tools, account_id } = req.body

  // 估算输入 token
  const inputText = messages
    ?.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('')
  const inputTokens = estimateTokens(inputText)

  // 提取思考模式信息
  const thinkingInfo = checkThinkingMode(req.body)
  const isThinking = thinkingInfo.enabled
  const thinkingBudget = thinkingInfo.budgetTokens || 0

  let account = null
  let retryCount = 0
  const maxRetries = MAX_ACCOUNT_RETRIES // 从环境变量读取，默认5次

  try {
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      requestLogger.logError({
        requestId,
        model,
        isStream: stream,
        errorType: 'invalid_request',
        errorMessage: 'messages is required and must be a non-empty array',
        requestTokens: inputTokens,
        durationMs: Date.now() - startTime,
        clientIp,
        userAgent,
        isThinking,
        thinkingBudget,
        requestHeaders: req.headers
      })

      return res.status(400).json({
        error: {
          message: 'messages is required and must be a non-empty array',
          type: 'invalid_request_error',
          code: 'invalid_messages'
        }
      })
    }

    // 获取 groupId（由 auth-middleware 设置，分组 SK 会设置此值）
    const groupId = req.groupId || null

    // 获取账号
    try {
      if (account_id) {
        account = await accountPool.getAccountById(account_id)
        if (!account) {
          await accountPool.getAvailableAccounts(groupId)
          account = await accountPool.getAccountById(account_id)
        }
        if (!account) {
          requestLogger.logError({
            requestId,
            accountId: account_id,
            model,
            isStream: stream,
            errorType: 'account_not_found',
            errorMessage: `Account '${account_id}' not found`,
            requestTokens: inputTokens,
            durationMs: Date.now() - startTime,
            clientIp,
            userAgent,
            isThinking,
            thinkingBudget,
            requestHeaders: req.headers
          })

          return res.status(404).json({
            error: {
              message: `Account '${account_id}' not found or not available`,
              type: 'invalid_request_error',
              code: 'account_not_found'
            }
          })
        }
        // 如果使用分组 SK，验证账号是否属于该分组
        if (groupId && account.groupId !== groupId) {
          requestLogger.logError({
            requestId,
            accountId: account_id,
            model,
            isStream: stream,
            errorType: 'account_not_in_group',
            errorMessage: `Account '${account_id}' does not belong to the authorized group`,
            requestTokens: inputTokens,
            durationMs: Date.now() - startTime,
            clientIp,
            userAgent,
            isThinking,
            thinkingBudget,
            requestHeaders: req.headers
          })

          return res.status(403).json({
            error: {
              message: `Account '${account_id}' does not belong to the authorized group`,
              type: 'invalid_request_error',
              code: 'account_not_in_group'
            }
          })
        }
      } else {
        account = await accountPool.getNextAccount(groupId)
      }
    } catch (error) {
      console.error('[OpenAI API] No available account:', error.message)

      requestLogger.logError({
        requestId,
        model,
        isStream: stream,
        errorType: 'no_available_accounts',
        errorMessage: error.message,
        requestTokens: inputTokens,
        durationMs: Date.now() - startTime,
        clientIp,
        userAgent,
        isThinking,
        thinkingBudget,
        requestHeaders: req.headers
      })

      return res.status(503).json({
        error: {
          message: 'No available accounts in pool',
          type: 'server_error',
          code: 'no_available_accounts'
        }
      })
    }

    console.log(`[OpenAI API] Using account: ${account.email} for model: ${model}`)
    await accountPool.incrementApiCall(account.id)

    const systemPrompt = extractSystemPrompt(messages)
    const filteredMessages = messages.filter((m) => m.role !== 'system')
    const convertedMessages = convertMessages(filteredMessages)

    // 从请求体中提取 thinking 相关参数
    const requestBody = {
      system: systemPrompt,
      thinking: req.body.thinking,
      reasoning_effort: req.body.reasoning_effort
    }

    // 生成发送给Kiro API的headers（用于日志记录）
    const { generateHeaders } = await import('../utils/header-generator.js')
    const kiroHeaders = generateHeaders(account, account.credentials.accessToken)

    if (stream) {
      // 流式响应（支持重试，但只能在发送响应头之前重试）
      const executeStreamRequest = async (currentAccount) => {
        const currentClient = new KiroClient(currentAccount, systemLogger)
        return {
          stream: currentClient.streamApi(convertedMessages, model, {
            system: systemPrompt,
            tools,
            requestBody
          }),
          account: currentAccount
        }
      }

      let streamResult
      let currentAccount = account

      // 尝试获取流，失败时重试
      try {
        streamResult = await executeStreamRequest(currentAccount)
      } catch (error) {
        // 402 错误：配额耗尽，标记账号并尝试切换账号重试
        if (isQuotaExhaustedError(error)) {
          console.log(`[OpenAI API] Quota exhausted (402) for account ${currentAccount.email}, marking and switching...`)
          accountPool.markAccountQuotaExhausted(currentAccount.id, error.message)
          
          // 尝试切换账号重试
          if (retryCount < maxRetries && !account_id) {
            retryCount++
            
            const newAccount = await accountPool.getNextAccount(groupId)
            if (newAccount && newAccount.id !== currentAccount.id) {
              console.log(`[OpenAI API] Retry stream with new account after 402: ${newAccount.email}`)
              await accountPool.incrementApiCall(newAccount.id)
              currentAccount = newAccount
              streamResult = await executeStreamRequest(currentAccount)
            } else {
              throw error // 没有其他可用账号
            }
          } else {
            throw error
          }
        } else if (isRetryableError(error) && retryCount < maxRetries && !account_id) {
          console.log(
            `[OpenAI API] Stream init error: ${error.message}, retrying... (${retryCount + 1}/${maxRetries})`
          )
          await accountPool.markAccountError(currentAccount.id)
          retryCount++
          

          const newAccount = await accountPool.getNextAccount(groupId)
          if (newAccount && newAccount.id !== currentAccount.id) {
            console.log(`[OpenAI API] Retry stream with new account: ${newAccount.email}`)
            await accountPool.incrementApiCall(newAccount.id)
            currentAccount = newAccount
            streamResult = await executeStreamRequest(currentAccount)
          } else {
            throw error
          }
        } else {
          throw error
        }
      }

      // 设置响应头
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')

      let fullContent = ''
      let hasError = false
      let accountSwitched = false

      let thinkingContent = ''  // 累积 thinking 内容
      let isFirstChunk = true   // 跟踪是否为首个 chunk
      let timeToFirstByte = null  // 首字响应时间
      let toolCalls = []  // 累积工具调用
      let hasToolCalls = false  // 是否有工具调用

      try {
        for await (const event of streamResult.stream) {
          if (event.type === 'content' && event.content) {
            // 记录首字响应时间
            if (timeToFirstByte === null) {
              timeToFirstByte = Date.now() - startTime
            }
            fullContent += event.content
            res.write(buildStreamChunk(event.content, model, null, 'content', isFirstChunk))
            isFirstChunk = false
          } else if (event.type === 'thinking_start') {
            // Thinking 开始，可选：发送空的 thinking chunk 作为开始标记
            // 这里不发送任何内容，等待实际的 thinking 内容
          } else if (event.type === 'thinking' && event.thinking) {
            // 记录首字响应时间（thinking 也算首字）
            if (timeToFirstByte === null) {
              timeToFirstByte = Date.now() - startTime
            }
            // 发送 thinking 内容片段
            thinkingContent += event.thinking
            res.write(buildStreamChunk(event.thinking, model, null, 'thinking', isFirstChunk))
            isFirstChunk = false
          } else if (event.type === 'thinking_end') {
            // Thinking 结束，可选：发送结束标记
            // 这里不发送额外内容，thinking 内容已经通过 thinking 事件发送
          } else if (event.type === 'tool_use') {
            // 工具调用事件
            hasToolCalls = true
            toolCalls.push({
              id: event.id,
              name: event.name,
              input: event.input
            })
            // 发送工具调用 chunk
            res.write(buildToolCallChunk(event.id, event.name, event.input, model, isFirstChunk))
            isFirstChunk = false
          } else if (event.type === 'token_refreshed' && event.newTokens) {
            // Token 刷新成功，更新数据库
            const expiresAt = Date.now() + (event.newTokens.expiresIn || 3600) * 1000
            await accountPool.updateAccountToken(
              currentAccount.id,
              event.newTokens.accessToken,
              event.newTokens.refreshToken,
              expiresAt
            )
            console.log(`[OpenAI API] Stream token refreshed for ${currentAccount.email}`)
          }
        }

        // 发送结束 chunk，如果有工具调用则 finish_reason 为 'tool_calls'
        res.write(buildStreamChunk('', model, hasToolCalls ? 'tool_calls' : 'stop'))
        res.write('data: [DONE]\n\n')

        const outputTokens = estimateTokens(fullContent)
        requestLogger.logSuccess({
          requestId,
          accountId: currentAccount.id,
          accountEmail: currentAccount.email,
          accountIdp: currentAccount.idp,
          model,
          isStream: true,
          requestTokens: inputTokens,
          responseTokens: outputTokens,
          durationMs: Date.now() - startTime,
          timeToFirstByte,
          clientIp,
          userAgent,
          isThinking,
          thinkingBudget,
          headerVersion: currentAccount.headerVersion || 1,
          requestHeaders: kiroHeaders
        })
      } catch (error) {
        hasError = true
        console.error('[OpenAI API] Stream error:', error.message)

        // 检查是否为 TOKEN_EXPIRED 错误且未指定账号 ID（允许切换账号）
        if (error.message === 'TOKEN_EXPIRED' && !account_id && retryCount < maxRetries) {
          console.log(`[OpenAI API] TOKEN_EXPIRED during stream, attempting account switch... (${retryCount + 1}/${maxRetries})`)

          await accountPool.markAccountError(currentAccount.id)
          retryCount++

          try {
            // 获取新账号
            
            const newAccount = await accountPool.getNextAccount(groupId)

            if (newAccount && newAccount.id !== currentAccount.id) {
              console.log(`[OpenAI API] Switching to new account: ${newAccount.email}`)
              await accountPool.incrementApiCall(newAccount.id)

              // 使用新账号重新开始流式请求
              const newClient = new KiroClient(newAccount, systemLogger)
              const newStream = newClient.streamApi(convertedMessages, model, {
                system: systemPrompt,
                tools,
                requestBody
              })

              currentAccount = newAccount
              accountSwitched = true
              hasError = false
              fullContent = ''

              // 重新处理新流
              thinkingContent = ''  // 重置 thinking 内容
              let isFirstChunkRetry = true  // 重试时重置首个 chunk 标志
              let retryStartTime = Date.now()  // 重试开始时间
              let timeToFirstByteRetry = null  // 重试的首字响应时间
              for await (const event of newStream) {
                if (event.type === 'content' && event.content) {
                  if (timeToFirstByteRetry === null) {
                    timeToFirstByteRetry = Date.now() - retryStartTime
                  }
                  fullContent += event.content
                  res.write(buildStreamChunk(event.content, model, null, 'content', isFirstChunkRetry))
                  isFirstChunkRetry = false
                } else if (event.type === 'thinking' && event.thinking) {
                  if (timeToFirstByteRetry === null) {
                    timeToFirstByteRetry = Date.now() - retryStartTime
                  }
                  thinkingContent += event.thinking
                  res.write(buildStreamChunk(event.thinking, model, null, 'thinking', isFirstChunkRetry))
                  isFirstChunkRetry = false
                } else if (event.type === 'token_refreshed' && event.newTokens) {
                  const expiresAt = Date.now() + (event.newTokens.expiresIn || 3600) * 1000
                  await accountPool.updateAccountToken(
                    currentAccount.id,
                    event.newTokens.accessToken,
                    event.newTokens.refreshToken,
                    expiresAt
                  )
                  console.log(`[OpenAI API] Stream token refreshed for ${currentAccount.email} (after switch)`)
                }
              }

              res.write(buildStreamChunk('', model, 'stop'))
              res.write('data: [DONE]\n\n')

              const outputTokens = estimateTokens(fullContent)
              requestLogger.logSuccess({
                requestId,
                accountId: currentAccount.id,
                accountEmail: currentAccount.email,
                accountIdp: currentAccount.idp,
                model,
                isStream: true,
                requestTokens: inputTokens,
                responseTokens: outputTokens,
                durationMs: Date.now() - startTime,
                timeToFirstByte: timeToFirstByteRetry,
                clientIp,
                userAgent,
                isThinking,
                thinkingBudget,
                headerVersion: currentAccount.headerVersion || 1,
                requestHeaders: kiroHeaders
              })

              console.log(`[OpenAI API] Successfully recovered from TOKEN_EXPIRED by switching accounts`)
            } else {
              throw new Error('No alternative account available')
            }
          } catch (retryError) {
            console.error('[OpenAI API] Account switch failed:', retryError.message)
            // 账号切换失败，继续按原错误处理
            hasError = true
          }
        }

        if (hasError) {
          // 检查是否为封禁错误（Bad credentials 或 BANNED:TEMPORARILY_SUSPENDED）
          if (isBannedError(error)) {
            // 封禁错误：永久移除账号并标记为封禁状态
            await accountPool.banAccount(currentAccount.id, error.message)
          } else if (isQuotaExhaustedError(error)) {
            // 402 错误：异步更新使用量，不重试（次月1日才会恢复额度）
            accountPool.markAccountQuotaExhausted(currentAccount.id, error.message)
          } else if (isRetryableError(error)) {
            await accountPool.markAccountError(currentAccount.id)
          }

          // 确定错误类型
          let errorType = 'stream_error'
          if (isBannedError(error)) {
            errorType = 'account_banned'
          } else if (isQuotaExhaustedError(error)) {
            errorType = 'quota_exhausted'
          } else if (isRetryableError(error)) {
            errorType = 'token_expired'
          }

          requestLogger.logError({
            requestId,
            accountId: currentAccount.id,
            accountEmail: currentAccount.email,
            accountIdp: currentAccount.idp,
            model,
            isStream: true,
            errorType,
            errorMessage: error.message,
            requestTokens: inputTokens,
            responseTokens: estimateTokens(fullContent),
            durationMs: Date.now() - startTime,
            timeToFirstByte,
            clientIp,
            userAgent,
            isThinking,
            thinkingBudget,
            headerVersion: currentAccount.headerVersion || 1,
            requestHeaders: kiroHeaders
          })

          res.write(`data: ${JSON.stringify({ error: { message: error.message } })}\n\n`)
          res.write('data: [DONE]\n\n')
        }
      }

      res.end()
    } else {
      // 非流式响应（支持重试）
      const executeNonStreamRequest = async (currentAccount, isRetry = false) => {
        const currentClient = new KiroClient(currentAccount, systemLogger)
        const { response, newTokens } = await currentClient.callApi(convertedMessages, model, {
          system: systemPrompt,
          tools,
          requestBody
        })

        if (newTokens) {
          const expiresAt = Date.now() + (newTokens.expiresIn || 3600) * 1000
          await accountPool.updateAccountToken(
            currentAccount.id,
            newTokens.accessToken,
            newTokens.refreshToken,
            expiresAt
          )
        }

        const responseText = await response.text()
        const parsed = currentClient.parseResponse(responseText)
        return { parsed, account: currentAccount }
      }

      try {
        let result
        try {
          result = await executeNonStreamRequest(account)
        } catch (error) {
          // 402 错误：配额耗尽，标记账号并尝试切换账号重试
          if (isQuotaExhaustedError(error)) {
            console.log(`[OpenAI API] Quota exhausted (402) for account ${account.email}, marking and switching...`)
            accountPool.markAccountQuotaExhausted(account.id, error.message)
            
            // 尝试切换账号重试
            if (retryCount < maxRetries && !account_id) {
              retryCount++
              
              const newAccount = await accountPool.getNextAccount(groupId)
              if (newAccount && newAccount.id !== account.id) {
                console.log(`[OpenAI API] Retry with new account after 402: ${newAccount.email}`)
                await accountPool.incrementApiCall(newAccount.id)
                result = await executeNonStreamRequest(newAccount, true)
                account = newAccount
              } else {
                throw error // 没有其他可用账号
              }
            } else {
              throw error
            }
          } else if (isRetryableError(error) && retryCount < maxRetries && !account_id) {
            console.log(
              `[OpenAI API] Retryable error: ${error.message}, retrying... (${retryCount + 1}/${maxRetries})`
            )
            await accountPool.markAccountError(account.id)
            retryCount++

            // 获取新账号重试
            

            // 获取新账号重试
            const newAccount = await accountPool.getNextAccount(groupId)
            if (newAccount && newAccount.id !== account.id) {
              console.log(`[OpenAI API] Retry with new account: ${newAccount.email}`)
              await accountPool.incrementApiCall(newAccount.id)
              result = await executeNonStreamRequest(newAccount, true)
              account = newAccount
            } else {
              throw error // 没有其他可用账号，抛出原错误
            }
          } else {
            throw error
          }
        }

        const outputTokens = estimateTokens(result.parsed.content)
        requestLogger.logSuccess({
          requestId,
          accountId: result.account.id,
          accountEmail: result.account.email,
          accountIdp: result.account.idp,
          model,
          isStream: false,
          requestTokens: inputTokens,
          responseTokens: outputTokens,
          durationMs: Date.now() - startTime,
          clientIp,
          userAgent,
          isThinking,
          thinkingBudget,
          headerVersion: result.account.headerVersion || 1,
          requestHeaders: kiroHeaders
        })

        // 传递 contentBlocks 和 toolCalls 以支持 thinking 内容和工具调用
        res.json(buildOpenAIResponse(
          result.parsed.content,
          model,
          inputTokens,
          outputTokens,
          'stop',
          result.parsed.contentBlocks,
          result.parsed.toolCalls
        ))
      } catch (error) {
        console.error('[OpenAI API] Error:', error.message)

        // 检查是否为封禁错误（Bad credentials 或 BANNED:TEMPORARILY_SUSPENDED）
        if (isBannedError(error)) {
          // 封禁错误：永久移除账号并标记为封禁状态
          await accountPool.banAccount(account.id, error.message)
        } else if (isQuotaExhaustedError(error)) {
          // 402 错误：异步更新使用量，不重试（次月1日才会恢复额度）
          accountPool.markAccountQuotaExhausted(account.id, error.message)
        } else if (isRetryableError(error)) {
          await accountPool.markAccountError(account.id)
        }

        // 确定错误类型
        let errorType = 'api_error'
        if (isBannedError(error)) {
          errorType = 'account_banned'
        } else if (isQuotaExhaustedError(error)) {
          errorType = 'quota_exhausted'
        } else if (error.message.includes('403')) {
          errorType = 'forbidden'
        }

        requestLogger.logError({
          requestId,
          accountId: account.id,
          accountEmail: account.email,
          accountIdp: account.idp,
          model,
          isStream: false,
          errorType,
          errorMessage: error.message,
          requestTokens: inputTokens,
          durationMs: Date.now() - startTime,
          clientIp,
          userAgent,
          isThinking,
          thinkingBudget,
          headerVersion: account.headerVersion || 1,
          requestHeaders: kiroHeaders
        })

        // 402 错误返回 402 状态码
        const statusCode = isQuotaExhaustedError(error) ? 402 : 500
        res.status(statusCode).json({
          error: {
            message: error.message,
            type: isQuotaExhaustedError(error) ? 'quota_exhausted' : 'api_error',
            code: isQuotaExhaustedError(error) ? 'quota_exhausted' : 'internal_error'
          }
        })
      }
    }
  } catch (error) {
    console.error('[OpenAI API] Unexpected error:', error)

    requestLogger.logError({
      requestId,
      accountId: account?.id,
      accountEmail: account?.email,
      accountIdp: account?.idp,
      model,
      isStream: stream,
      errorType: 'unexpected_error',
      errorMessage: error.message,
      requestTokens: inputTokens,
      durationMs: Date.now() - startTime,
      clientIp,
      userAgent,
      isThinking,
      thinkingBudget,
      headerVersion: account?.headerVersion || 1,
      requestHeaders: account ? kiroHeaders : req.headers
    })

    res.status(500).json({
      error: {
        message: error.message,
        type: 'api_error',
        code: 'internal_error'
      }
    })
  }
})

/**
 * GET /v1/pool/status - 获取账号池状态
 */
router.get('/v1/pool/status', validateApiKey, async (req, res) => {
  try {
    const groupId = req.groupId || null
    const status = await accountPool.getPoolStatus(groupId)
    res.json(status)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * POST /v1/pool/refresh - 刷新账号池缓存
 */
router.post('/v1/pool/refresh', validateApiKey, async (req, res) => {
  try {
    const groupId = req.groupId || null
    await accountPool.getAvailableAccounts(groupId)
    const status = await accountPool.getPoolStatus(groupId)
    res.json({ success: true, ...status })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/logs - 获取请求日志列表
 */
router.get('/api/logs', async (req, res) => {
  try {
    const { page = 1, pageSize = 50, status, accountId, serverId, startTime, endTime } = req.query
    const result = await requestLogger.getLogs({
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      status,
      accountId,
      serverId,
      startTime,
      endTime
    })
    res.json(result)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * GET /api/logs/stats - 获取请求日志统计
 */
router.get('/api/logs/stats', async (req, res) => {
  try {
    const stats = await requestLogger.getStats()
    res.json(stats)
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

/**
 * DELETE /api/logs - 清空请求日志
 */
router.delete('/api/logs', async (req, res) => {
  try {
    const [result] = await dbPool.query('DELETE FROM api_request_logs')
    res.json({ success: true, deleted: result.affectedRows })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

export default router
