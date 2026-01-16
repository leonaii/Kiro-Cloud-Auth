/**
 * Claude API 兼容路由
 * 提供 /v1/messages 等 Anthropic Claude API 标准接口
 */

import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import KiroClient, { SUPPORTED_MODELS } from '../kiro/index.js'
import AccountPool from '../openai-compat/account-pool.js'
import RequestLogger from '../openai-compat/request-logger.js'
import { validateApiKey } from '../openai-compat/auth-middleware.js'
import { generateHeaders } from '../utils/header-generator.js'
import { getClientIp, sanitizeHeaders } from '../utils/request-utils.js'
import { isRetryableError, isQuotaExhaustedError } from '../utils/retry-utils.js'
import {
  estimateTokens,
  estimateInputTokens,
  estimateOutputTokens,
  countTokens as countTokensUtil,
  getContentText
} from '../openai-compat/token-counter.js'
import {
  convertClaudeMessages,
  convertClaudeTools,
  processSystemPrompt,
  processToolChoice
} from './claude-converter.js'
import {
  validateAnthropicVersion,
  buildClaudeError,
  buildClaudeResponse,
  buildSSEEvent
} from './claude-response.js'

const router = Router()
let accountPool = null
let requestLogger = null
let systemLogger = null
let dbPool = null

// 从环境变量读取最大重试次数，默认5次
const MAX_ACCOUNT_RETRIES = parseInt(process.env.MAX_ACCOUNT_RETRIES || '5', 10)

/**
 * 初始化路由
 */
export function initClaudeRoutes(pool, sysLogger = null, externalAccountPool = null) {
  dbPool = pool
  systemLogger = sysLogger
  accountPool = externalAccountPool || new AccountPool(dbPool, systemLogger)
  requestLogger = new RequestLogger(dbPool)
  requestLogger.startCleanup()
  return router
}

/**
 * 获取当前使用的账号池实例
 */
export function getAccountPool() {
  return accountPool
}

// ==================== API 路由 ====================

/**
 * POST /v1/messages - Claude Messages API 主端点
 */
router.post('/v1/messages', validateApiKey, validateAnthropicVersion, async (req, res) => {
  const requestId = uuidv4()
  const startTime = Date.now()
  const clientIp = getClientIp(req)
  const userAgent = req.headers['user-agent']

  const {
    model = 'claude-sonnet-4-5',
    messages,
    max_tokens,
    system,
    temperature,
    top_p,
    top_k,
    stop_sequences,
    stream = false,
    tools,
    tool_choice,
    metadata,
    account_id
  } = req.body

  // 验证必需参数
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    const error = buildClaudeError('invalid_request_error', 'messages is required and must be a non-empty array')
    return res.status(error.status).json(error.body)
  }

  if (!max_tokens || typeof max_tokens !== 'number' || max_tokens <= 0) {
    const error = buildClaudeError('invalid_request_error', 'max_tokens is required and must be a positive integer')
    return res.status(error.status).json(error.body)
  }

  // 估算输入 token
  const inputText = messages
    ?.map((m) => {
      if (typeof m.content === 'string') return m.content
      if (Array.isArray(m.content)) {
        return m.content
          .map(block => {
            if (block.type === 'text') return block.text
            if (block.type === 'tool_result') return JSON.stringify(block.content)
            return ''
          })
          .join('')
      }
      return ''
    })
    .join('')
  const inputTokens = estimateTokens(inputText)

  // 提取思考模式信息
  const thinking = req.body.thinking
  const isThinking = thinking?.type === 'enabled'
  const thinkingBudget = thinking?.budget_tokens || 0

  let account = null
  let retryCount = 0
  const maxRetries = MAX_ACCOUNT_RETRIES // 从环境变量读取，默认5次

  try {
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
          const error = buildClaudeError('invalid_request_error', `Account '${account_id}' not found or not available`, 404)
          return res.status(error.status).json(error.body)
        }
        if (groupId && account.groupId !== groupId) {
          const error = buildClaudeError('invalid_request_error', `Account '${account_id}' does not belong to the authorized group`, 403)
          return res.status(error.status).json(error.body)
        }
      } else {
        account = await accountPool.getNextAccount(groupId)
      }
    } catch (error) {
      console.error('[Claude API] No available account:', error.message)
      const err = buildClaudeError('api_error', 'No available accounts in pool', 503)
      return res.status(err.status).json(err.body)
    }

    console.log(`[Claude API] Using account: ${account.email} for model: ${model}`)
    await accountPool.incrementApiCall(account.id)

    // 处理请求参数
    const systemPrompt = processSystemPrompt(system)
    const convertedMessages = convertClaudeMessages(messages)
    const convertedTools = convertClaudeTools(tools)
    const processedToolChoice = processToolChoice(tool_choice)

    const requestBody = {
      system: systemPrompt,
      thinking: thinking,
      max_tokens,
      temperature,
      top_p,
      top_k,
      stop_sequences,
      tool_choice: processedToolChoice
    }

    const kiroHeaders = generateHeaders(account, account.credentials.accessToken)

    if (stream) {
      // 流式响应处理
      await handleStreamResponse(req, res, {
        account, convertedMessages, model, systemPrompt, convertedTools,
        requestBody, kiroHeaders, requestId, startTime, inputTokens,
        clientIp, userAgent, isThinking, thinkingBudget, groupId, account_id, maxRetries
      })
    } else {
      // 非流式响应处理
      await handleNonStreamResponse(req, res, {
        account, convertedMessages, model, systemPrompt, convertedTools,
        requestBody, kiroHeaders, requestId, startTime, inputTokens,
        clientIp, userAgent, isThinking, thinkingBudget, groupId, account_id, maxRetries
      })
    }
  } catch (error) {
    console.error('[Claude API] Unexpected error:', error)
    const err = buildClaudeError('api_error', error.message, 500)
    res.status(err.status).json(err.body)
  }
})

/**
 * 处理流式响应
 */
async function handleStreamResponse(req, res, options) {
  const {
    account, convertedMessages, model, systemPrompt, convertedTools,
    requestBody, kiroHeaders, requestId, startTime, inputTokens,
    clientIp, userAgent, isThinking, thinkingBudget, groupId, account_id, maxRetries
  } = options

  let retryCount = 0
  let currentAccount = account

  const executeStreamRequest = async (acc) => {
    const client = new KiroClient(acc, systemLogger)
    return {
      stream: client.streamApi(convertedMessages, model, {
        system: systemPrompt,
        tools: convertedTools,
        requestBody
      }),
      account: acc
    }
  }

  let streamResult
  try {
    streamResult = await executeStreamRequest(currentAccount)
  } catch (error) {
    // 402 错误：配额耗尽，标记账号并尝试切换账号重试
    if (isQuotaExhaustedError(error)) {
      console.log(`[Claude API] Quota exhausted (402) for account ${currentAccount.email}, marking and switching...`)
      accountPool.markAccountQuotaExhausted(currentAccount.id, error.message)
      
      // 尝试切换账号重试
      if (retryCount < maxRetries && !account_id) {
        retryCount++
        
        const newAccount = await accountPool.getNextAccount(groupId)
        if (newAccount && newAccount.id !== currentAccount.id) {
          console.log(`[Claude API] Retry stream with new account after 402: ${newAccount.email}`)
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
      await accountPool.markAccountError(currentAccount.id)
      retryCount++
      
      const newAccount = await accountPool.getNextAccount(groupId)
      if (newAccount && newAccount.id !== currentAccount.id) {
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

  // 设置 SSE 响应头
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  const messageId = `msg_${uuidv4().replace(/-/g, '')}`
  let fullContent = ''
  let thinkingContent = ''
  let outputTokens = 0
  let contentBlockIndex = 0
  let thinkingBlockStarted = false
  let textBlockStarted = false
  let timeToFirstByte = null  // 首字响应时间

  // 发送 message_start 事件
  res.write(buildSSEEvent('message_start', {
    type: 'message_start',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: 0 }
    }
  }))

  try {
    for await (const event of streamResult.stream) {
      if (event.type === 'thinking_start') {
        // 记录首字响应时间（thinking_start 也算首字）
        if (timeToFirstByte === null) {
          timeToFirstByte = Date.now() - startTime
        }
        if (!thinkingBlockStarted) {
          res.write(buildSSEEvent('content_block_start', {
            type: 'content_block_start',
            index: contentBlockIndex,
            content_block: { type: 'thinking', thinking: '' }
          }))
          thinkingBlockStarted = true
        }
      } else if (event.type === 'thinking' && event.thinking) {
        // 记录首字响应时间
        if (timeToFirstByte === null) {
          timeToFirstByte = Date.now() - startTime
        }
        thinkingContent += event.thinking
        res.write(buildSSEEvent('content_block_delta', {
          type: 'content_block_delta',
          index: contentBlockIndex,
          delta: { type: 'thinking_delta', thinking: event.thinking }
        }))
      } else if (event.type === 'thinking_end') {
        if (thinkingBlockStarted) {
          res.write(buildSSEEvent('content_block_stop', {
            type: 'content_block_stop',
            index: contentBlockIndex
          }))
          contentBlockIndex++
          thinkingBlockStarted = false
        }
      } else if (event.type === 'content' && event.content) {
        // 记录首字响应时间
        if (timeToFirstByte === null) {
          timeToFirstByte = Date.now() - startTime
        }
        if (!textBlockStarted) {
          res.write(buildSSEEvent('content_block_start', {
            type: 'content_block_start',
            index: contentBlockIndex,
            content_block: { type: 'text', text: '' }
          }))
          textBlockStarted = true
        }
        fullContent += event.content
        res.write(buildSSEEvent('content_block_delta', {
          type: 'content_block_delta',
          index: contentBlockIndex,
          delta: { type: 'text_delta', text: event.content }
        }))
      } else if (event.type === 'token_refreshed' && event.newTokens) {
        const expiresAt = Date.now() + (event.newTokens.expiresIn || 3600) * 1000
        await accountPool.updateAccountToken(
          currentAccount.id,
          event.newTokens.accessToken,
          event.newTokens.refreshToken,
          expiresAt
        )
      }
    }

    if (textBlockStarted) {
      res.write(buildSSEEvent('content_block_stop', {
        type: 'content_block_stop',
        index: contentBlockIndex
      }))
    }

    outputTokens = estimateTokens(fullContent) + estimateTokens(thinkingContent)

    res.write(buildSSEEvent('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: outputTokens }
    }))

    res.write(buildSSEEvent('message_stop', { type: 'message_stop' }))

    accountPool.markAccountSuccess(currentAccount.id)

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
      requestHeaders: kiroHeaders,
      apiProtocol: 'claude'
    })
  } catch (error) {
    console.error('[Claude API] Stream error:', error.message)

    // 检查是否为 TOKEN_EXPIRED 错误且未指定账号 ID（允许切换账号）
    if (error.message === 'TOKEN_EXPIRED' && !account_id && retryCount < maxRetries) {
      console.log(`[Claude API] TOKEN_EXPIRED during stream, attempting account switch... (${retryCount + 1}/${maxRetries})`)

      await accountPool.markAccountError(currentAccount.id)
      retryCount++

      try {
        // 获取新账号
        
        const newAccount = await accountPool.getNextAccount(groupId)

        if (newAccount && newAccount.id !== currentAccount.id) {
          console.log(`[Claude API] Switching to new account: ${newAccount.email}`)
          await accountPool.incrementApiCall(newAccount.id)

          // 使用新账号重新开始流式请求
          const newClient = new KiroClient(newAccount, systemLogger)
          const newStream = newClient.streamApi(convertedMessages, model, {
            system: systemPrompt,
            tools: convertedTools,
            requestBody
          })

          currentAccount = newAccount
          fullContent = ''
          thinkingContent = ''
          let retryContentBlockIndex = 0
          let retryThinkingBlockStarted = false
          let retryTextBlockStarted = false
          let retryTimeToFirstByte = null
          const retryStartTime = Date.now()

          // 重新处理新流
          for await (const event of newStream) {
            if (event.type === 'thinking_start') {
              if (retryTimeToFirstByte === null) {
                retryTimeToFirstByte = Date.now() - retryStartTime
              }
              if (!retryThinkingBlockStarted) {
                res.write(buildSSEEvent('content_block_start', {
                  type: 'content_block_start',
                  index: retryContentBlockIndex,
                  content_block: { type: 'thinking', thinking: '' }
                }))
                retryThinkingBlockStarted = true
              }
            } else if (event.type === 'thinking' && event.thinking) {
              if (retryTimeToFirstByte === null) {
                retryTimeToFirstByte = Date.now() - retryStartTime
              }
              thinkingContent += event.thinking
              res.write(buildSSEEvent('content_block_delta', {
                type: 'content_block_delta',
                index: retryContentBlockIndex,
                delta: { type: 'thinking_delta', thinking: event.thinking }
              }))
            } else if (event.type === 'thinking_end') {
              if (retryThinkingBlockStarted) {
                res.write(buildSSEEvent('content_block_stop', {
                  type: 'content_block_stop',
                  index: retryContentBlockIndex
                }))
                retryContentBlockIndex++
                retryThinkingBlockStarted = false
              }
            } else if (event.type === 'content' && event.content) {
              if (retryTimeToFirstByte === null) {
                retryTimeToFirstByte = Date.now() - retryStartTime
              }
              if (!retryTextBlockStarted) {
                res.write(buildSSEEvent('content_block_start', {
                  type: 'content_block_start',
                  index: retryContentBlockIndex,
                  content_block: { type: 'text', text: '' }
                }))
                retryTextBlockStarted = true
              }
              fullContent += event.content
              res.write(buildSSEEvent('content_block_delta', {
                type: 'content_block_delta',
                index: retryContentBlockIndex,
                delta: { type: 'text_delta', text: event.content }
              }))
            } else if (event.type === 'token_refreshed' && event.newTokens) {
              const expiresAt = Date.now() + (event.newTokens.expiresIn || 3600) * 1000
              await accountPool.updateAccountToken(
                currentAccount.id,
                event.newTokens.accessToken,
                event.newTokens.refreshToken,
                expiresAt
              )
              console.log(`[Claude API] Stream token refreshed for ${currentAccount.email} (after switch)`)
            }
          }

          if (retryTextBlockStarted) {
            res.write(buildSSEEvent('content_block_stop', {
              type: 'content_block_stop',
              index: retryContentBlockIndex
            }))
          }

          outputTokens = estimateTokens(fullContent) + estimateTokens(thinkingContent)

          res.write(buildSSEEvent('message_delta', {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: { output_tokens: outputTokens }
          }))

          res.write(buildSSEEvent('message_stop', { type: 'message_stop' }))

          accountPool.markAccountSuccess(currentAccount.id)

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
            timeToFirstByte: retryTimeToFirstByte,
            clientIp,
            userAgent,
            isThinking,
            thinkingBudget,
            headerVersion: currentAccount.headerVersion || 1,
            requestHeaders: kiroHeaders,
            apiProtocol: 'claude'
          })

          console.log(`[Claude API] Successfully recovered from TOKEN_EXPIRED by switching accounts`)
          res.end()
          return
        }
      } catch (retryError) {
        console.error('[Claude API] Account switch failed:', retryError.message)
      }
    }

    // 检查是否为 402 配额耗尽错误
    if (isQuotaExhaustedError(error)) {
      // 402 错误：异步更新使用量，不重试（次月1日才会恢复额度）
      accountPool.markAccountQuotaExhausted(currentAccount.id, error.message)
    } else if (isRetryableError(error)) {
      await accountPool.markAccountError(currentAccount.id)
    }

    // 确定错误类型
    let errorType = 'stream_error'
    if (isQuotaExhaustedError(error)) {
      errorType = 'quota_exhausted'
    } else if (isRetryableError(error)) {
      errorType = 'token_expired'
    }

    // 记录错误日志
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
      requestHeaders: kiroHeaders,
      apiProtocol: 'claude'
    })

    res.write(buildSSEEvent('error', {
      type: 'error',
      error: { type: isQuotaExhaustedError(error) ? 'quota_exhausted' : 'api_error', message: error.message }
    }))
  }

  res.end()
}

/**
 * 处理非流式响应
 */
async function handleNonStreamResponse(req, res, options) {
  const {
    account, convertedMessages, model, systemPrompt, convertedTools,
    requestBody, kiroHeaders, requestId, startTime, inputTokens,
    clientIp, userAgent, isThinking, thinkingBudget, groupId, account_id, maxRetries
  } = options

  let retryCount = 0
  let currentAccount = account

  const executeRequest = async (acc) => {
    const client = new KiroClient(acc, systemLogger)
    const { response, newTokens } = await client.callApi(convertedMessages, model, {
      system: systemPrompt,
      tools: convertedTools,
      requestBody
    })

    if (newTokens) {
      const expiresAt = Date.now() + (newTokens.expiresIn || 3600) * 1000
      await accountPool.updateAccountToken(acc.id, newTokens.accessToken, newTokens.refreshToken, expiresAt)
    }

    const responseText = await response.text()
    const parsed = client.parseResponse(responseText)
    return { parsed, account: acc }
  }

  try {
    let result
    try {
      result = await executeRequest(currentAccount)
    } catch (error) {
      // 402 错误：配额耗尽，标记账号并尝试切换账号重试
      if (isQuotaExhaustedError(error)) {
        console.log(`[Claude API] Quota exhausted (402) for account ${currentAccount.email}, marking and switching...`)
        accountPool.markAccountQuotaExhausted(currentAccount.id, error.message)
        
        // 尝试切换账号重试
        if (retryCount < maxRetries && !account_id) {
          retryCount++
          
          const newAccount = await accountPool.getNextAccount(groupId)
          if (newAccount && newAccount.id !== currentAccount.id) {
            console.log(`[Claude API] Retry with new account after 402: ${newAccount.email}`)
            await accountPool.incrementApiCall(newAccount.id)
            result = await executeRequest(newAccount)
            currentAccount = newAccount
          } else {
            throw error // 没有其他可用账号
          }
        } else {
          throw error
        }
      } else if (isRetryableError(error) && retryCount < maxRetries && !account_id) {
        await accountPool.markAccountError(currentAccount.id)
        retryCount++
        
        const newAccount = await accountPool.getNextAccount(groupId)
        if (newAccount && newAccount.id !== currentAccount.id) {
          await accountPool.incrementApiCall(newAccount.id)
          result = await executeRequest(newAccount)
          currentAccount = newAccount
        } else {
          throw error
        }
      } else {
        throw error
      }
    }

    accountPool.markAccountSuccess(result.account.id)

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
      requestHeaders: kiroHeaders,
      apiProtocol: 'claude'
    })

    const response = buildClaudeResponse(
      result.parsed.content,
      model,
      inputTokens,
      outputTokens,
      'end_turn',
      result.parsed.contentBlocks
    )

    res.json(response)
  } catch (error) {
    console.error('[Claude API] Error:', error.message)
    
    // 检查是否为 402 配额耗尽错误
    if (isQuotaExhaustedError(error)) {
      // 402 错误：异步更新使用量，不重试（次月1日才会恢复额度）
      accountPool.markAccountQuotaExhausted(currentAccount.id, error.message)
    } else if (isRetryableError(error)) {
      await accountPool.markAccountError(currentAccount.id)
    }
    
    // 402 错误返回 402 状态码
    const statusCode = isQuotaExhaustedError(error) ? 402 : 500
    const errorType = isQuotaExhaustedError(error) ? 'quota_exhausted' : 'api_error'
    const err = buildClaudeError(errorType, error.message, statusCode)
    res.status(err.status).json(err.body)
  }
}

/**
 * POST /v1/messages/count_tokens - Token 计数端点
 */
router.post('/v1/messages/count_tokens', validateApiKey, validateAnthropicVersion, async (req, res) => {
  const { model, messages, system, tools } = req.body

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    const error = buildClaudeError('invalid_request_error', 'messages is required and must be a non-empty array')
    return res.status(error.status).json(error.body)
  }

  try {
    let totalTokens = 0

    if (system) {
      const systemText = processSystemPrompt(system)
      totalTokens += estimateTokens(systemText)
    }

    for (const message of messages) {
      if (typeof message.content === 'string') {
        totalTokens += estimateTokens(message.content)
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            totalTokens += estimateTokens(block.text)
          } else if (block.type === 'tool_use') {
            totalTokens += estimateTokens(block.name || '')
            totalTokens += estimateTokens(JSON.stringify(block.input || {}))
          } else if (block.type === 'tool_result') {
            const resultContent = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content)
            totalTokens += estimateTokens(resultContent)
          } else if (block.type === 'image') {
            totalTokens += 1600
          }
        }
      }
    }

    if (tools && Array.isArray(tools)) {
      for (const tool of tools) {
        totalTokens += estimateTokens(tool.name || '')
        totalTokens += estimateTokens(tool.description || '')
        if (tool.input_schema) {
          totalTokens += estimateTokens(JSON.stringify(tool.input_schema))
        }
      }
    }

    res.json({ input_tokens: totalTokens })
  } catch (error) {
    const err = buildClaudeError('api_error', error.message, 500)
    res.status(err.status).json(err.body)
  }
})

/**
 * GET /v1/models - 列出可用模型
 */
router.get('/v1/models', validateApiKey, async (req, res) => {
  const models = SUPPORTED_MODELS.map((id) => ({
    id,
    object: 'model',
    created: 1700000000,
    owned_by: 'anthropic'
  }))
  res.json({ object: 'list', data: models })
})

/**
 * GET /v1/models/:model - 获取模型详情
 */
router.get('/v1/models/:model', validateApiKey, async (req, res) => {
  const { model } = req.params
  if (!SUPPORTED_MODELS.includes(model)) {
    const error = buildClaudeError('not_found_error', `Model '${model}' not found`, 404)
    return res.status(error.status).json(error.body)
  }
  res.json({ id: model, object: 'model', created: 1700000000, owned_by: 'anthropic' })
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
    const err = buildClaudeError('api_error', error.message, 500)
    res.status(err.status).json(err.body)
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
    const err = buildClaudeError('api_error', error.message, 500)
    res.status(err.status).json(err.body)
  }
})

/**
 * GET /api/logs - 获取请求日志列表
 */
router.get('/api/logs', validateApiKey, async (req, res) => {
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
    const err = buildClaudeError('api_error', error.message, 500)
    res.status(err.status).json(err.body)
  }
})

/**
 * GET /api/logs/stats - 获取请求日志统计
 */
router.get('/api/logs/stats', validateApiKey, async (req, res) => {
  try {
    const stats = await requestLogger.getStats()
    res.json(stats)
  } catch (error) {
    const err = buildClaudeError('api_error', error.message, 500)
    res.status(err.status).json(err.body)
  }
})

/**
 * DELETE /api/logs - 清空请求日志
 */
router.delete('/api/logs', validateApiKey, async (req, res) => {
  try {
    const [result] = await dbPool.query('DELETE FROM api_request_logs')
    res.json({ success: true, deleted: result.affectedRows })
  } catch (error) {
    const err = buildClaudeError('api_error', error.message, 500)
    res.status(err.status).json(err.body)
  }
})

export default router
