
/**
 * Claude API 兼容路由
 * 提供 /v1/messages 等 Anthropic Claude API 标准接口
 * 
 * 实现 Claude Messages API 协议：
 * - POST /v1/messages - 主聊天完成端点
 * - POST /v1/messages (stream: true) - SSE 流式传输
 * - POST /v1/messages/count_tokens - Token 计数
 */

import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import KiroClient, { SUPPORTED_MODELS, checkThinkingMode } from './kiro-client.js'
import AccountPool from './account-pool.js'
import RequestLogger from './request-logger.js'
import { validateApiKey } from './auth-middleware.js'
import { generateHeaders } from '../utils/header-generator.js'
import {
  estimateTokens,
  estimateInputTokens,
  estimateOutputTokens,
  countTokens as countTokensUtil,
  getContentText
} from './token-counter.js'

const router = Router()
let accountPool = null
let requestLogger = null
let systemLogger = null
let dbPool = null

// Claude API 版本常量
const CLAUDE_API_VERSIONS = ['2023-06-01', '2023-01-01', '2024-01-01']
const DEFAULT_API_VERSION = '2023-06-01'

/**
 * 初始化路由
 * @param {object} pool - 数据库连接池
 * @param {object} sysLogger - 系统日志实例
 * @param {AccountPool} externalAccountPool - 外部账号池实例（可选，用于共享活跃池）
 */
export function initClaudeRoutes(pool, sysLogger = null, externalAccountPool = null) {
  dbPool = pool
  systemLogger = sysLogger
  // 如果提供了外部账号池，使用它；否则创建新实例
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

/**
 * 获取客户端 IP
 */
function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || req.socket?.remoteAddress
}

/**
 * 脱敏请求头（移除敏感信息）
 */
function sanitizeHeaders(headers) {
  if (!headers) return {}
  const sanitized = { ...headers }
  // 脱敏 Authorization 头
  if (sanitized.authorization) {
    sanitized.authorization = sanitized.authorization.substring(0, 20) + '...[REDACTED]'
  }
  if (sanitized['x-api-key']) {
    sanitized['x-api-key'] = sanitized['x-api-key'].substring(0, 10) + '...[REDACTED]'
  }
  // 移除 cookie
  delete sanitized.cookie
  return sanitized
}

/**
 * 验证 anthropic-version 头部
 */
function validateAnthropicVersion(req, res, next) {
  const version = req.headers['anthropic-version']
  if (version && !CLAUDE_API_VERSIONS.includes(version)) {
    return res.status(400).json({
      type: 'error',
      error: {
        type: 'invalid_request_error',
        message: `Invalid anthropic-version header: ${version}. Supported versions: ${CLAUDE_API_VERSIONS.join(', ')}`
      }
    })
  }
  req.anthropicVersion = version || DEFAULT_API_VERSION
  next()
}

/**
 * 构建 Claude 格式的错误响应
 */
function buildClaudeError(type, message, status = 400) {
  return {
    status,
    body: {
      type: 'error',
      error: {
        type,
        message
      }
    }
  }
}

/**
 * 转换 Claude 消息格式到内部格式
 * 支持多模态内容（文本 + 图片）和工具使用
 */
function convertClaudeMessages(messages) {
  return messages.map((msg) => {
    // Claude API 的 role 只有 "user" 和 "assistant"
    const role = msg.role
    
    // 处理 content - 可以是字符串或内容块数组
    let content = msg.content
    
    if (typeof content === 'string') {
      // 简单字符串内容
      content = [{ type: 'text', text: content }]
    } else if (Array.isArray(content)) {
      // 内容块数组 - 转换格式
      content = content.map(block => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text }
        } else if (block.type === 'image') {
          // 处理图像块
          if (block.source?.type === 'base64') {
            return {
              type: 'image',
              source: {
                type: 'base64',
                media_type: block.source.media_type,
                data: block.source.data
              }
            }
          } else if (block.source?.type === 'url') {
            return {
              type: 'image',
              source: {
                type: 'url',
                url: block.source.url
              }
            }
          }
        } else if (block.type === 'tool_use') {
          return {
            type: 'tool_use',
            id: block.id,
            name: block.name,
            input: block.input
          }
        } else if (block.type === 'tool_result') {
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content,
            is_error: block.is_error
          }
        }
        return block
      })
    }
    
    return { role, content }
  })
}

/**
 * 转换 Claude 工具格式到内部格式
 */
function convertClaudeTools(tools) {
  if (!tools || !Array.isArray(tools)) return null
  
  return tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema
  }))
}

/**
 * 处理 system prompt
 * Claude API 的 system 可以是字符串或内容块数组
 */
function processSystemPrompt(system) {
  if (!system) return null
  
  if (typeof system === 'string') {
    return system
  }
  
  if (Array.isArray(system)) {
    return system
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n')
  }
  
  return null
}

/**
 * 处理 tool_choice 参数
 */
function processToolChoice(toolChoice) {
  if (!toolChoice) return null
  
  if (toolChoice.type === 'auto') {
    return { type: 'auto' }
  } else if (toolChoice.type === 'any') {
    return { type: 'any' }
  } else if (toolChoice.type === 'tool' && toolChoice.name) {
    return { type: 'tool', name: toolChoice.name }
  }
  
  return null
}

/**
 * 构建 Claude 格式的非流式响应
 */
function buildClaudeResponse(content, model, inputTokens, outputTokens, stopReason = 'end_turn', contentBlocks = null) {
  const response = {
    id: `msg_${uuidv4().replace(/-/g, '')}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    }
  }

  // 处理内容块
  if (contentBlocks && Array.isArray(contentBlocks)) {
    response.content = contentBlocks.map(block => {
      if (block.type === 'thinking') {
        return {
          type: 'thinking',
          thinking: block.thinking
        }
      } else if (block.type === 'text') {
        return {
          type: 'text',
          text: block.text
        }
      } else if (block.type === 'tool_use') {
        return {
          type: 'tool_use',
          id: block.id,
          name: block.name,
          input: block.input
        }
      }
      return block
    })
  } else if (content) {
    response.content = [{ type: 'text', text: content }]
  }

  return response
}

/**
 * 构建 SSE 流式事件
 */
function buildSSEEvent(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`
}

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

  // 提取思考模式信息（从 Claude 的 thinking 参数）
  const thinking = req.body.thinking
  const isThinking = thinking?.type === 'enabled'
  const thinkingBudget = thinking?.budget_tokens || 0

  let account = null
  let retryCount = 0
  const maxRetries = 1

  try {
    // 获取 groupId（由 auth-middleware 设置）
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
            requestHeaders: req.headers,
            apiProtocol: 'claude'
          })

          const error = buildClaudeError('invalid_request_error', `Account '${account_id}' not found or not available`, 404)
          return res.status(error.status).json(error.body)
        }
        // 验证账号是否属于该分组
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
            requestHeaders: req.headers,
            apiProtocol: 'claude'
          })

          const error = buildClaudeError('invalid_request_error', `Account '${account_id}' does not belong to the authorized group`, 403)
          return res.status(error.status).json(error.body)
        }
      } else {
        account = await accountPool.getNextAccount(groupId)
      }
    } catch (error) {
      console.error('[Claude API] No available account:', error.message)

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
        requestHeaders: req.headers,
        apiProtocol: 'claude'
      })

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

    // 构建请求体
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

    // 生成发送给 Kiro API 的 headers（用于日志记录）
    const kiroHeaders = generateHeaders(account, account.credentials.accessToken)

    if (stream) {
      // 流式响应
      const executeStreamRequest = async (currentAccount) => {
        const currentClient = new KiroClient(currentAccount, systemLogger)
        return {
          stream: currentClient.streamApi(convertedMessages, model, {
            system: systemPrompt,
            tools: convertedTools,
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
            `[Claude API] Stream init error: ${error.message}, retrying in 1s... (${retryCount + 1}/${maxRetries})`
          )
          await accountPool.markAccountError(currentAccount.id)
          retryCount++
          await delay(1000)

          const newAccount = await accountPool.getNextAccount(groupId)
          if (newAccount && newAccount.id !== currentAccount.id) {
            console.log(`[Claude API] Retry stream with new account: ${newAccount.email}`)
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
      let hasError = false
      let outputTokens = 0
      let contentBlockIndex = 0
      let thinkingBlockStarted = false
      let textBlockStarted = false

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
          usage: {
            input_tokens: inputTokens,
            output_tokens: 0
          }
        }
      }))

      try {
        for await (const event of streamResult.stream) {
          if (event.type === 'thinking_start') {
            // Thinking 开始
            if (!thinkingBlockStarted) {
              res.write(buildSSEEvent('content_block_start', {
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: { type: 'thinking', thinking: '' }
              }))
              thinkingBlockStarted = true
            }
          } else if (event.type === 'thinking' && event.thinking) {
            // Thinking 内容
            thinkingContent += event.thinking
            res.write(buildSSEEvent('content_block_delta', {
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'thinking_delta', thinking: event.thinking }
            }))
          } else if (event.type === 'thinking_end') {
            // Thinking 结束
            if (thinkingBlockStarted) {
              res.write(buildSSEEvent('content_block_stop', {
                type: 'content_block_stop',
                index: contentBlockIndex
              }))
              contentBlockIndex++
              thinkingBlockStarted = false
            }
          } else if (event.type === 'content' && event.content) {
            // 文本内容
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
            // Token 刷新成功，更新数据库
            const expiresAt = Date.now() + (event.newTokens.expiresIn || 3600) * 1000
            await accountPool.updateAccountToken(
              currentAccount.id,
              event.newTokens.accessToken,
              event.newTokens.refreshToken,
              expiresAt
            )
            console.log(`[Claude API] Stream token refreshed for ${currentAccount.email}`)
          }
        }

        // 结束文本块
        if (textBlockStarted) {
          res.write(buildSSEEvent('content_block_stop', {
            type: 'content_block_stop',
            index: contentBlockIndex
          }))
        }

        outputTokens = estimateTokens(fullContent) + estimateTokens(thinkingContent)

        // 发送 message_delta 事件
        res.write(buildSSEEvent('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: 'end_turn',
            stop_sequence: null
          },
          usage: {
            output_tokens: outputTokens
          }
        }))

        // 发送 message_stop 事件
        res.write(buildSSEEvent('message_stop', {
          type: 'message_stop'
        }))

        // 标记账号调用成功（重置错误计数）
        accountPool.markAccountSuccess(currentAccount.id)

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
          requestHeaders: kiroHeaders,
          apiProtocol: 'claude'
        })
      } catch (error) {
        hasError = true
        console.error('[Claude API] Stream error:', error.message)

        // P0 修复：流式响应中的账号切换重试逻辑
        // 检查是否为 TOKEN_EXPIRED 错误且未指定账号 ID（允许切换账号）
        if (error.message === 'TOKEN_EXPIRED' && !account_id && retryCount < maxRetries) {
          console.log(`[Claude API] TOKEN_EXPIRED during stream, attempting account switch... (${retryCount + 1}/${maxRetries})`)

          await accountPool.markAccountError(currentAccount.id)
          retryCount++

          try {
            // 等待 1 秒后获取新账号
            await delay(1000)
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
              hasError = false
              fullContent = ''
              thinkingContent = ''

              // 重新处理新流
              for await (const event of newStream) {
                if (event.type === 'thinking' && event.thinking) {
                  thinkingContent += event.thinking
                  res.write(buildSSEEvent('content_block_delta', {
                    type: 'content_block_delta',
                    index: contentBlockIndex,
                    delta: { type: 'thinking_delta', thinking: event.thinking }
                  }))
                } else if (event.type === 'content' && event.content) {
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
                  console.log(`[Claude API] Stream token refreshed for ${currentAccount.email} (after switch)`)
                }
              }

              // 结束文本块
              if (textBlockStarted) {
                res.write(buildSSEEvent('content_block_stop', {
                  type: 'content_block_stop',
                  index: contentBlockIndex
                }))
              }

              outputTokens = estimateTokens(fullContent) + estimateTokens(thinkingContent)

              // 发送 message_delta 事件
              res.write(buildSSEEvent('message_delta', {
                type: 'message_delta',
                delta: {
                  stop_reason: 'end_turn',
                  stop_sequence: null
                },
                usage: {
                  output_tokens: outputTokens
                }
              }))

              // 发送 message_stop 事件
              res.write(buildSSEEvent('message_stop', {
                type: 'message_stop'
              }))

              // 标记新账号调用成功（重置错误计数）
              accountPool.markAccountSuccess(currentAccount.id)

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
                requestHeaders: kiroHeaders,
                apiProtocol: 'claude'
              })

              console.log(`[Claude API] Successfully recovered from TOKEN_EXPIRED by switching accounts`)
            } else {
              throw new Error('No alternative account available')
            }
          } catch (retryError) {
            console.error('[Claude API] Account switch failed:', retryError.message)
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
            requestHeaders: kiroHeaders,
            apiProtocol: 'claude'
          })

          // 发送错误事件
          res.write(buildSSEEvent('error', {
            type: 'error',
            error: {
              type: 'api_error',
              message: error.message
            }
          }))
        }
      }

      res.end()
    } else {
      // 非流式响应
      const executeNonStreamRequest = async (currentAccount) => {
        const currentClient = new KiroClient(currentAccount, systemLogger)
        const { response, newTokens } = await currentClient.callApi(convertedMessages, model, {
          system: systemPrompt,
          tools: convertedTools,
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
              `[Claude API] Retryable error: ${error.message}, retrying in 1s... (${retryCount + 1}/${maxRetries})`
            )
            await accountPool.markAccountError(account.id)
            retryCount++

            await delay(1000)

            const newAccount = await accountPool.getNextAccount(groupId)
            if (newAccount && newAccount.id !== account.id) {
              console.log(`[Claude API] Retry with new account: ${newAccount.email}`)
              await accountPool.incrementApiCall(newAccount.id)
              result = await executeNonStreamRequest(newAccount)
              account = newAccount
            } else {
              throw error
            }
          } else {
            throw error
          }
        }

        // 标记账号调用成功（重置错误计数）
        accountPool.markAccountSuccess(result.account.id)

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
          requestHeaders: kiroHeaders,
          apiProtocol: 'claude'
        })

        // 构建 Claude 格式响应
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
          requestHeaders: kiroHeaders,
          apiProtocol: 'claude'
        })

        const err = buildClaudeError('api_error', error.message, 500)
        res.status(err.status).json(err.body)
      }
    }
  } catch (error) {
    console.error('[Claude API] Unexpected error:', error)

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
      requestHeaders: sanitizeHeaders(req.headers),
      apiProtocol: 'claude'
    })

    const err = buildClaudeError('api_error', error.message, 500)
    res.status(err.status).json(err.body)
  }
})

/**
 * POST /v1/messages/count_tokens - Token 计数端点
 */
router.post('/v1/messages/count_tokens', validateApiKey, validateAnthropicVersion, async (req, res) => {
  const { model, messages, system, tools } = req.body

  // 验证必需参数
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    const error = buildClaudeError('invalid_request_error', 'messages is required and must be a non-empty array')
    return res.status(error.status).json(error.body)
  }

  try {
    let totalTokens = 0

    // 计算 system prompt tokens
    if (system) {
      const systemText = processSystemPrompt(system)
      totalTokens += estimateTokens(systemText)
    }

    // 计算 messages tokens
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
            // 图像固定 token 成本（约 1600 tokens）
            totalTokens += 1600
          }
        }
      }
    }

    // 计算 tools tokens
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
    console.error('[Claude API] Count tokens error:', error.message)
    const err = buildClaudeError('api_error', error.message, 500)
    res.status(err.status).json(err.body)
  }
})

/**
 * GET /v1/models - 列出可用模型（Claude 格式）
 */
router.get('/v1/models', validateApiKey, async (req, res) => {
  const models = SUPPORTED_MODELS.map((id) => ({
    id,
    object: 'model',
    created: 1700000000,
    owned_by: 'anthropic'
  }))

  res.json({
    object: 'list',
    data: models
  })
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

  res.json({
    id: model,
    object: 'model',
    created: 1700000000,
    owned_by: 'anthropic'
  })
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
 * P0 修复：添加认证保护
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
 * P0 修复：添加认证保护
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
 * P0 修复：添加认证保护
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