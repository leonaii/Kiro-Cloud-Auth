/**
 * OpenAI 兼容 API 路由
 * 提供 /v1/chat/completions 等标准接口
 */

import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import KiroClient, { SUPPORTED_MODELS, checkThinkingMode } from './kiro-client.js'
import AccountPool from './account-pool.js'
import RequestLogger from './request-logger.js'
import { validateApiKey } from './auth-middleware.js'

const router = Router()
let accountPool = null
let requestLogger = null
let systemLogger = null
let dbPool = null

/**
 * 初始化路由
 */
export function initOpenAIRoutes(pool, sysLogger = null) {
  dbPool = pool
  systemLogger = sysLogger
  accountPool = new AccountPool(dbPool, systemLogger)
  requestLogger = new RequestLogger(dbPool)
  requestLogger.startCleanup()
  return router
}

/**
 * 估算 token 数量（简单实现）
 */
function estimateTokens(text) {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/**
 * 转换 OpenAI 消息格式到内部格式
 * 支持多模态内容（文本 + 图片）
 */
function convertMessages(messages) {
  return messages.map((msg) => {
    const role = msg.role === 'system' ? 'user' : msg.role
    // 保持原始 content 格式，支持 string 或 array（多模态）
    return { role, content: msg.content }
  })
}

/**
 * 提取 system prompt
 */
function extractSystemPrompt(messages) {
  const systemMsgs = messages.filter((m) => m.role === 'system')
  if (systemMsgs.length === 0) return null
  return systemMsgs
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')
}

/**
 * 构建 OpenAI 格式的响应
 * @param {string} content - 响应内容
 * @param {string} model - 模型名称
 * @param {number} inputTokens - 输入 token 数
 * @param {number} outputTokens - 输出 token 数
 * @param {string} finishReason - 结束原因
 * @param {Array} contentBlocks - 内容块（包含 text/thinking 类型）
 */
function buildOpenAIResponse(content, model, inputTokens, outputTokens, finishReason = 'stop', contentBlocks = null) {
  const response = {
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content },
        logprobs: null,
        finish_reason: finishReason
      }
    ],
    usage: {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens
    }
  }

  // 如果有 thinking 内容，添加 reasoning_content
  if (contentBlocks && contentBlocks.length > 0) {
    const thinkingBlocks = contentBlocks.filter(b => b.type === 'thinking')
    if (thinkingBlocks.length > 0) {
      response.choices[0].message.reasoning_content = thinkingBlocks.map(b => b.thinking).join('\n')
    }
  }

  return response
}

/**
 * 构建 SSE 流式响应块
 * @param {string} content - 内容
 * @param {string} model - 模型名称
 * @param {string|null} finishReason - 结束原因
 * @param {string} deltaType - delta 类型：'content' 或 'thinking'
 */
function buildStreamChunk(content, model, finishReason = null, deltaType = 'content') {
  const chunk = {
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: finishReason ? {} : (
          deltaType === 'thinking'
            ? { reasoning_content: content }
            : { content }
        ),
        logprobs: null,
        finish_reason: finishReason
      }
    ]
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/**
 * 获取客户端 IP
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress
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

/**
 * 延迟函数
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 判断是否为可重试的错误
 */
function isRetryableError(error) {
  const msg = error.message || ''
  return (
    msg === 'TOKEN_EXPIRED' ||
    msg.includes('403') ||
    msg.includes('401') ||
    msg.includes('token') ||
    msg.includes('expired') ||
    msg.includes('unauthorized')
  )
}

/**
 * POST /v1/chat/completions - 聊天补全
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
  const maxRetries = 1 // 最多重试 1 次

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
        if (isRetryableError(error) && retryCount < maxRetries && !account_id) {
          console.log(
            `[OpenAI API] Stream init error: ${error.message}, retrying in 1s... (${retryCount + 1}/${maxRetries})`
          )
          await accountPool.markAccountError(currentAccount.id)
          retryCount++
          await delay(1000)

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

      try {
        for await (const event of streamResult.stream) {
          if (event.type === 'content' && event.content) {
            fullContent += event.content
            res.write(buildStreamChunk(event.content, model))
          } else if (event.type === 'thinking_start') {
            // Thinking 开始，可选：发送空的 thinking chunk 作为开始标记
            // 这里不发送任何内容，等待实际的 thinking 内容
          } else if (event.type === 'thinking' && event.thinking) {
            // 发送 thinking 内容片段
            thinkingContent += event.thinking
            res.write(buildStreamChunk(event.thinking, model, null, 'thinking'))
          } else if (event.type === 'thinking_end') {
            // Thinking 结束，可选：发送结束标记
            // 这里不发送额外内容，thinking 内容已经通过 thinking 事件发送
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

        res.write(buildStreamChunk('', model, 'stop'))
        res.write('data: [DONE]\n\n')

        const outputTokens = estimateTokens(fullContent)
        requestLogger.logSuccess({
          requestId,
          accountId: currentAccount.id,
          accountEmail: currentAccount.email,
          model,
          isStream: true,
          requestTokens: inputTokens,
          responseTokens: outputTokens,
          durationMs: Date.now() - startTime,
          clientIp,
          userAgent,
          isThinking,
          thinkingBudget,
          headerVersion: currentAccount.header_version || 1,
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
            // 等待 1 秒后获取新账号
            await delay(1000)
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
              for await (const event of newStream) {
                if (event.type === 'content' && event.content) {
                  fullContent += event.content
                  res.write(buildStreamChunk(event.content, model))
                } else if (event.type === 'thinking' && event.thinking) {
                  thinkingContent += event.thinking
                  res.write(buildStreamChunk(event.thinking, model, null, 'thinking'))
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
                model,
                isStream: true,
                requestTokens: inputTokens,
                responseTokens: outputTokens,
                durationMs: Date.now() - startTime,
                clientIp,
                userAgent,
                isThinking,
                thinkingBudget,
                headerVersion: currentAccount.header_version || 1,
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
          if (isRetryableError(error)) {
            await accountPool.markAccountError(currentAccount.id)
          }

          requestLogger.logError({
            requestId,
            accountId: currentAccount.id,
            accountEmail: currentAccount.email,
            model,
            isStream: true,
            errorType: isRetryableError(error) ? 'token_expired' : 'stream_error',
            errorMessage: error.message,
            requestTokens: inputTokens,
            responseTokens: estimateTokens(fullContent),
            durationMs: Date.now() - startTime,
            clientIp,
            userAgent,
            isThinking,
            thinkingBudget,
            headerVersion: currentAccount.header_version || 1,
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
          // 检查是否可重试
          if (isRetryableError(error) && retryCount < maxRetries && !account_id) {
            console.log(
              `[OpenAI API] Retryable error: ${error.message}, retrying in 1s... (${retryCount + 1}/${maxRetries})`
            )
            await accountPool.markAccountError(account.id)
            retryCount++

            // 等待 1 秒
            await delay(1000)

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
          model,
          isStream: false,
          requestTokens: inputTokens,
          responseTokens: outputTokens,
          durationMs: Date.now() - startTime,
          clientIp,
          userAgent,
          isThinking,
          thinkingBudget,
          headerVersion: result.account.header_version || 1,
          requestHeaders: kiroHeaders
        })

        // 传递 contentBlocks 以支持 thinking 内容
        res.json(buildOpenAIResponse(
          result.parsed.content,
          model,
          inputTokens,
          outputTokens,
          'stop',
          result.parsed.contentBlocks
        ))
      } catch (error) {
        console.error('[OpenAI API] Error:', error.message)

        if (isRetryableError(error)) {
          await accountPool.markAccountError(account.id)
        }

        requestLogger.logError({
          requestId,
          accountId: account.id,
          accountEmail: account.email,
          model,
          isStream: false,
          errorType: error.message.includes('403') ? 'forbidden' : 'api_error',
          errorMessage: error.message,
          requestTokens: inputTokens,
          durationMs: Date.now() - startTime,
          clientIp,
          userAgent,
          isThinking,
          thinkingBudget,
          headerVersion: account.header_version || 1,
          requestHeaders: kiroHeaders
        })

        res.status(500).json({
          error: {
            message: error.message,
            type: 'api_error',
            code: 'internal_error'
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
      headerVersion: account?.header_version || 1,
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
