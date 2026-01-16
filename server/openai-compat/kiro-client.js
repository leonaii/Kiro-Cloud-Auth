/**
 * Kiro API 客户端
 * 基于 claude-kiro-demo.js 简化实现，专注于 OpenAI 兼容转换
 */

import { v4 as uuidv4 } from 'uuid'
import * as crypto from 'crypto'
import * as os from 'os'
import * as http from 'http'
import * as https from 'https'
import { generateHeaders, getEndpointUrl } from '../utils/header-generator.js'
import SystemLogger from './system-logger.js'

// Thinking 模式常量
const THINKING_START_TAG = '<thinking>';
const THINKING_END_TAG = '</thinking>';
const KIRO_MAX_OUTPUT_TOKENS = 32000;
const KIRO_MAX_TOOL_DESC_LEN = 10237;
const KIRO_MAX_TOOL_NAME_LEN = 64;

const KIRO_CONSTANTS = {
  REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
  REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
  // V1: codewhisperer.{{region}}.amazonaws.com
  BASE_URL_V1: 'https://codewhisperer.{{region}}.amazonaws.com/generateAssistantResponse',
  // V2: q.{{region}}.amazonaws.com
  BASE_URL_V2: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse',
  AXIOS_TIMEOUT: 120000,
  CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
  ORIGIN_AI_EDITOR: 'AI_EDITOR',
}

// 模型映射
const MODEL_MAPPING = {
  'claude-opus-4-5': 'claude-opus-4.5',
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-sonnet-4-5': 'CLAUDE_SONNET_4_5_20250929_V1_0',
}

const SUPPORTED_MODELS = Object.keys(MODEL_MAPPING)

// 移除 getMacAddressSha256 函数
// Kiro_New 使用的是随机生成的机器 ID (UUID v4)，而不是基于 MAC 地址生成的
// 使用 MAC 地址会暴露真实硬件信息，且容易导致指纹不一致

// HTTP Agent 复用 - 针对 12核12G 服务器优化
// 增加超时时间以支持大上下文请求（200k tokens）
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 500, // 高并发连接数
  maxFreeSockets: 50, // 保持更多空闲连接
  timeout: 600000, // 10分钟，支持大上下文
  scheduling: 'fifo'
})
const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 500,
  maxFreeSockets: 50,
  timeout: 600000, // 10分钟，支持大上下文
  scheduling: 'fifo',
  // TLS 会话复用
  maxCachedSessions: 100
})

// 默认请求超时时间（毫秒）- 用于 AbortController
const DEFAULT_REQUEST_TIMEOUT = 600000 // 10分钟

// 创建带超时的 fetch 请求
async function fetchWithTimeout(url, options, timeoutMs = DEFAULT_REQUEST_TIMEOUT) {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    })
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}

// 检查是否启用了 Thinking 模式
function checkThinkingMode(requestBody) {
  let enabled = false;
  let budgetTokens = 16000;

  // Claude API 格式
  if (requestBody.thinking?.type === 'enabled') {
    enabled = true;
    if (requestBody.thinking.budget_tokens > 0) {
      budgetTokens = requestBody.thinking.budget_tokens;
    }
  }

  // OpenAI 格式 (reasoning_effort)
  if (!enabled && requestBody.reasoning_effort) {
    const effort = requestBody.reasoning_effort;
    if (effort && effort !== 'none') {
      enabled = true;
      switch (effort) {
        case 'low': budgetTokens = 8000; break;
        case 'medium': budgetTokens = 16000; break;
        case 'high': budgetTokens = 24000; break;
        default: budgetTokens = 16000;
      }
    }
  }

  // AMP/Cursor 格式 - 检查系统提示中的 thinking_mode 标签
  if (!enabled && requestBody.system) {
    const systemStr = typeof requestBody.system === 'string'
      ? requestBody.system
      : JSON.stringify(requestBody.system);
    if (systemStr.includes('<thinking_mode>') && systemStr.includes('</thinking_mode>')) {
      const startIdx = systemStr.indexOf('<thinking_mode>') + 15;
      const endIdx = systemStr.indexOf('</thinking_mode>', startIdx);
      if (endIdx > startIdx) {
        const thinkingMode = systemStr.substring(startIdx, endIdx);
        if (thinkingMode === 'interleaved' || thinkingMode === 'enabled') {
          enabled = true;
          const lengthMatch = systemStr.match(/<max_thinking_length>(\d+)<\/max_thinking_length>/);
          if (lengthMatch) budgetTokens = parseInt(lengthMatch[1], 10);
        }
      }
    }
  }

  return { enabled, budgetTokens };
}

// 从响应内容中提取 thinking 块
function extractThinkingFromContent(content) {
  const blocks = [];
  if (!content) return blocks;
  if (!content.includes(THINKING_START_TAG)) {
    return [{ type: 'text', text: content }];
  }

  let remaining = content;
  while (remaining.length > 0) {
    const startIdx = remaining.indexOf(THINKING_START_TAG);
    if (startIdx === -1) {
      if (remaining.trim()) blocks.push({ type: 'text', text: remaining });
      break;
    }
    if (startIdx > 0) {
      const textBefore = remaining.substring(0, startIdx);
      if (textBefore.trim()) blocks.push({ type: 'text', text: textBefore });
    }
    remaining = remaining.substring(startIdx + THINKING_START_TAG.length);
    const endIdx = remaining.indexOf(THINKING_END_TAG);
    if (endIdx === -1) {
      if (remaining.trim()) blocks.push({ type: 'thinking', thinking: remaining });
      break;
    }
    const thinkContent = remaining.substring(0, endIdx);
    if (thinkContent.trim()) blocks.push({ type: 'thinking', thinking: thinkContent });
    remaining = remaining.substring(endIdx + THINKING_END_TAG.length);
  }
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return blocks;
}

// 截断工具名称（Kiro 限制 64 字符）
function shortenToolNameIfNeeded(name) {
  if (!name || name.length <= KIRO_MAX_TOOL_NAME_LEN) return name;
  // 保留前32和后31字符，中间用_连接
  return name.substring(0, 32) + '_' + name.substring(name.length - 31);
}

// 处理工具描述（空描述默认值，长度截断）
function processToolDescription(description) {
  if (!description || description.trim() === '') {
    return 'No description provided';
  }
  if (description.length > KIRO_MAX_TOOL_DESC_LEN) {
    return description.substring(0, KIRO_MAX_TOOL_DESC_LEN - 3) + '...';
  }
  return description;
}

class KiroClient {
  constructor(account, systemLogger = null) {
    this.account = account
    this.accessToken = account.credentials.accessToken
    this.refreshToken = account.credentials.refreshToken
    this.region = account.credentials.region || 'us-east-1'
    this.authMethod = account.credentials.authMethod
    this.clientId = account.credentials.clientId
    this.clientSecret = account.credentials.clientSecret
    this.headerVersion = account.headerVersion || 1
    this.systemLogger = systemLogger

    // 根据 headerVersion 选择对应的端点URL
    const baseUrlTemplate = this.headerVersion === 2
      ? KIRO_CONSTANTS.BASE_URL_V2
      : KIRO_CONSTANTS.BASE_URL_V1
    this.baseUrl = baseUrlTemplate.replace('{{region}}', this.region)
    
    this.refreshUrl = KIRO_CONSTANTS.REFRESH_URL.replace('{{region}}', this.region)
    this.refreshIdcUrl = KIRO_CONSTANTS.REFRESH_IDC_URL.replace('{{region}}', this.region)
    
    console.log(`[KiroClient] Initialized for ${account.email} with Header V${this.headerVersion}, endpoint: ${this.baseUrl}`)
  }

  /**
   * 刷新 Token
   * 严格匹配 Rust 实现 (kiro_auth_client.rs / aws_sso_client.rs)
   */
  async refreshAccessToken() {
    let url, headers, body

    if (this.authMethod === 'social') {
      // 社交登录：使用 Kiro Auth Service 刷新
      // 严格匹配 kiro_auth_client.rs：只发送 User-Agent: KiroBatchLoginCLI/1.0.0
      url = this.refreshUrl
      headers = {
        'Content-Type': 'application/json',
        'User-Agent': 'KiroBatchLoginCLI/1.0.0'
      }
      body = { refreshToken: this.refreshToken }
    } else {
      // IdC/BuilderId：使用 AWS OIDC 刷新
      // 严格匹配 aws_sso_client.rs：只发送 Content-Type (不发送自定义 User-Agent)
      url = this.refreshIdcUrl
      headers = {
        'Content-Type': 'application/json'
      }
      body = {
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        refreshToken: this.refreshToken,
        grantType: 'refresh_token'
      }
    }

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    }, 60000) // Token 刷新使用 60 秒超时

    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`)
    }

    const data = await response.json()
    this.accessToken = data.accessToken
    if (data.refreshToken) this.refreshToken = data.refreshToken

    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken || this.refreshToken,
      expiresIn: data.expiresIn
    }
  }

  /**
   * 构建 Kiro 请求
   * @param {Array} messages - 消息列表
   * @param {string} model - 模型名称
   * @param {Array} tools - 工具列表
   * @param {string} systemPrompt - 系统提示
   * @param {Object} requestBody - 原始请求体（用于检测 thinking 模式）
   */
  buildRequest(messages, model, tools = null, systemPrompt = null, requestBody = null) {
    const conversationId = uuidv4()
    const kiroModel = MODEL_MAPPING[model] || MODEL_MAPPING['claude-sonnet-4-5']

    // 检查 thinking 模式
    const { enabled: thinkingEnabled, budgetTokens } = checkThinkingMode(requestBody || {});

    // 处理消息
    const processedMessages = [...messages]

    // 合并相邻相同 role 的消息
    const mergedMessages = []
    for (const msg of processedMessages) {
      if (mergedMessages.length === 0) {
        mergedMessages.push({ ...msg })
      } else {
        const last = mergedMessages[mergedMessages.length - 1]
        if (msg.role === last.role) {
          last.content = this.mergeContent(last.content, msg.content)
        } else {
          mergedMessages.push({ ...msg })
        }
      }
    }

    const history = []
    let startIndex = 0

    // 处理 system prompt，如果启用了 thinking 模式则注入提示
    let finalSystemPrompt = systemPrompt;
    if (thinkingEnabled) {
      const thinkingHint = `<thinking_mode>interleaved</thinking_mode><max_thinking_length>${budgetTokens}</max_thinking_length>`;
      finalSystemPrompt = finalSystemPrompt ? finalSystemPrompt + '\n' + thinkingHint : thinkingHint;
      console.log(`[KiroClient] Thinking mode enabled, budget_tokens: ${budgetTokens}`);
    }

    if (finalSystemPrompt) {
      const systemText = this.getContentText(finalSystemPrompt)
      if (mergedMessages[0]?.role === 'user') {
        const firstContent = this.getContentText(mergedMessages[0])
        history.push({
          userInputMessage: {
            content: `${systemText}\n\n${firstContent}`,
            modelId: kiroModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
          }
        })
        startIndex = 1
      } else {
        history.push({
          userInputMessage: {
            content: systemText,
            modelId: kiroModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
          }
        })
      }
    }

    // 构建历史消息
    for (let i = startIndex; i < mergedMessages.length - 1; i++) {
      const msg = mergedMessages[i]
      if (msg.role === 'user') {
        history.push({
          userInputMessage: {
            content: this.getContentText(msg),
            modelId: kiroModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
          }
        })
      } else if (msg.role === 'assistant') {
        history.push({
          assistantResponseMessage: { content: this.getContentText(msg) }
        })
      }
    }

    // 当前消息
    const currentMsg = mergedMessages[mergedMessages.length - 1]
    let currentContent = this.getContentText(currentMsg)
    if (!currentContent) currentContent = 'Continue'

    const request = {
      conversationState: {
        chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
        conversationId,
        currentMessage: {
          userInputMessage: {
            content: currentContent,
            modelId: kiroModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
          }
        }
      }
    }

    if (history.length > 0) {
      request.conversationState.history = history
    }

    // 添加工具（处理名称和描述的截断）
    if (tools && tools.length > 0) {
      request.conversationState.currentMessage.userInputMessage.userInputMessageContext = {
        tools: tools.map(tool => ({
          toolSpecification: {
            name: shortenToolNameIfNeeded(tool.function?.name || tool.name),
            description: processToolDescription(tool.function?.description || tool.description || ''),
            inputSchema: { json: tool.function?.parameters || tool.parameters || {} }
          }
        }))
      }
    }

    return request
  }

  getContentText(message) {
    if (!message) return ''
    if (typeof message === 'string') return message
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) {
      return message.content
        .filter(p => p.type === 'text')
        .map(p => p.text)
        .join('')
    }
    return String(message.content || message)
  }

  mergeContent(content1, content2) {
    const text1 = typeof content1 === 'string' ? content1 : this.getContentText({ content: content1 })
    const text2 = typeof content2 === 'string' ? content2 : this.getContentText({ content: content2 })
    return text1 + '\n' + text2
  }

  /**
   * 解析响应
   */
  parseResponse(rawData) {
    const rawStr = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData)
    let fullContent = ''

    // Kiro API 返回的是多个 JSON 对象拼接在一起，每个包含 {"content":"..."}
    let pos = 0
    while (pos < rawStr.length) {
      const startMarker = '{"content":"'
      const startIdx = rawStr.indexOf(startMarker, pos)
      if (startIdx === -1) break

      const contentStart = startIdx + startMarker.length

      // 找到字符串结束的位置（正确处理转义）
      let contentEnd = contentStart
      while (contentEnd < rawStr.length) {
        if (rawStr[contentEnd] === '"') {
          // 计算前面连续的反斜杠数量
          let backslashCount = 0
          let checkPos = contentEnd - 1
          while (checkPos >= contentStart && rawStr[checkPos] === '\\') {
            backslashCount++
            checkPos--
          }
          // 偶数个反斜杠意味着引号没有被转义
          if (backslashCount % 2 === 0) {
            break
          }
        }
        contentEnd++
      }

      if (contentEnd < rawStr.length) {
        const jsonStr = rawStr.substring(startIdx, contentEnd + 2) // 包含 "}
        try {
          const parsed = JSON.parse(jsonStr)
          if (parsed.content) {
            fullContent += parsed.content
          }
        } catch (e) {
          // JSON 解析失败时，记录错误但继续处理
          console.warn('[KiroClient] JSON parse failed:', e.message, 'Raw:', jsonStr.substring(0, 100))
        }
        pos = contentEnd + 2
      } else {
        break
      }
    }

    // 提取 thinking 块
    const contentBlocks = extractThinkingFromContent(fullContent);

    return {
      content: fullContent,
      contentBlocks: contentBlocks  // 新增：结构化的内容块
    }
  }

  /**
   * 调用 API
   */
  async callApi(messages, model, options = {}) {
    const requestData = this.buildRequest(messages, model, options.tools, options.system, options.requestBody)
    const requestStartTime = Date.now()

    // 使用统一的 header 生成器，根据账号的 headerVersion 自动选择版本
    const headers = generateHeaders(this.account, this.accessToken)

    const response = await fetchWithTimeout(this.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestData),
      agent: this.baseUrl.startsWith('https') ? httpsAgent : httpAgent
    }, DEFAULT_REQUEST_TIMEOUT)

    const requestDuration = Date.now() - requestStartTime

    // 记录API调用日志（包含headers、状态码和耗时）
    if (this.systemLogger) {
      await this.systemLogger.logApiCall({
        accountId: this.account.id,
        accountEmail: this.account.email,
        endpoint: this.baseUrl,
        method: 'POST',
        statusCode: response.status,
        durationMs: requestDuration,
        errorType: response.ok ? null : 'kiro_api_error',
        requestHeaders: headers
      }).catch(() => {})
    }

    if (response.status === 403) {
      // Token 过期，尝试刷新
      const newTokens = await this.refreshAccessToken()
      headers['Authorization'] = `Bearer ${newTokens.accessToken}`

      const retryResponse = await fetchWithTimeout(this.baseUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(requestData),
        agent: this.baseUrl.startsWith('https') ? httpsAgent : httpAgent
      }, DEFAULT_REQUEST_TIMEOUT)

      if (!retryResponse.ok) {
        throw new Error(`API call failed after token refresh: ${retryResponse.status}`)
      }

      return {
        response: retryResponse,
        newTokens
      }
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`API call failed: ${response.status} - ${errorText}`)
    }

    return { response, newTokens: null }
  }

  /**
   * 流式调用 API
   * @param {Array} messages - 消息列表
   * @param {string} model - 模型名称
   * @param {Object} options - 选项
   * @returns {AsyncGenerator} 流式响应生成器，可能包含 newTokens 事件和 thinking 事件
   */
  async *streamApi(messages, model, options = {}) {
    const requestData = this.buildRequest(messages, model, options.tools, options.system, options.requestBody)
    const requestStartTime = Date.now()

    // 检查是否启用了 thinking 模式
    const { enabled: thinkingEnabled } = checkThinkingMode(options.requestBody || {});

    // 使用统一的 header 生成器，根据账号的 headerVersion 自动选择版本
    let headers = generateHeaders(this.account, this.accessToken)

    let response = await fetchWithTimeout(this.baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestData),
      agent: this.baseUrl.startsWith('https') ? httpsAgent : httpAgent
    }, DEFAULT_REQUEST_TIMEOUT)

    const requestDuration = Date.now() - requestStartTime

    // 记录API调用日志（包含headers、状态码和耗时）
    if (this.systemLogger) {
      await this.systemLogger.logApiCall({
        accountId: this.account.id,
        accountEmail: this.account.email,
        endpoint: this.baseUrl,
        method: 'POST',
        statusCode: response.status,
        durationMs: requestDuration,
        errorType: response.ok ? null : 'kiro_stream_api_error',
        requestHeaders: headers
      }).catch(() => {})
    }

    // 403 时尝试刷新 token 并重试一次
    if (response.status === 403) {
      console.log('[KiroClient] Stream got 403, attempting token refresh...')
      try {
        const newTokens = await this.refreshAccessToken()
        // 更新 accessToken 后重新生成完整的 headers
        this.accessToken = newTokens.accessToken
        headers = generateHeaders(this.account, newTokens.accessToken)

        // 等待 1 秒后重试
        await new Promise(resolve => setTimeout(resolve, 1000))

        response = await fetchWithTimeout(this.baseUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestData),
          agent: this.baseUrl.startsWith('https') ? httpsAgent : httpAgent
        }, DEFAULT_REQUEST_TIMEOUT)

        // 如果刷新成功，先 yield 新 token 信息供调用方更新数据库
        if (response.ok) {
          console.log('[KiroClient] Stream token refresh successful, retrying request...')
          yield { type: 'token_refreshed', newTokens }
        }
      } catch (refreshError) {
        console.error('[KiroClient] Stream token refresh failed:', refreshError.message)
        throw new Error('TOKEN_EXPIRED')
      }
    }

    if (!response.ok) {
      // 读取错误响应体以获取详细错误信息
      let errorBody = ''
      try {
        errorBody = await response.text()
        console.error(`[KiroClient] Stream API error response (${response.status}):`, errorBody.substring(0, 500))
      } catch (e) {
        console.error('[KiroClient] Failed to read error response body:', e.message)
      }
      
      if (response.status === 403) {
        throw new Error('TOKEN_EXPIRED')
      }
      
      // 尝试解析错误信息
      let errorMessage = `API call failed: ${response.status}`
      try {
        const errorJson = JSON.parse(errorBody)
        if (errorJson.message) {
          errorMessage = `API call failed: ${response.status} - ${errorJson.message}`
        } else if (errorJson.error) {
          errorMessage = `API call failed: ${response.status} - ${typeof errorJson.error === 'string' ? errorJson.error : JSON.stringify(errorJson.error)}`
        }
      } catch (e) {
        // 如果不是 JSON，使用原始错误体
        if (errorBody) {
          errorMessage = `API call failed: ${response.status} - ${errorBody.substring(0, 200)}`
        }
      }
      
      throw new Error(errorMessage)
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    // Thinking 模式状态跟踪
    let inThinkingBlock = false;
    let thinkingBuffer = '';
    let contentBuffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // 解析 buffer 中所有完整的 {"content":"..."} 对象
        const startMarker = '{"content":"'
        let pos = 0
        let lastProcessedEnd = 0

        while (pos < buffer.length) {
          const startIdx = buffer.indexOf(startMarker, pos)
          if (startIdx === -1) break

          const contentStart = startIdx + startMarker.length

          // 找到字符串结束的位置
          let contentEnd = contentStart
          let foundEnd = false
          while (contentEnd < buffer.length) {
            if (buffer[contentEnd] === '"') {
              // 检查是否是转义的引号
              let backslashCount = 0
              let checkPos = contentEnd - 1
              while (checkPos >= contentStart && buffer[checkPos] === '\\') {
                backslashCount++
                checkPos--
              }
              // 偶数个反斜杠意味着引号没有被转义
              if (backslashCount % 2 === 0) {
                foundEnd = true
                break
              }
            }
            contentEnd++
          }

          if (!foundEnd) {
            // 没找到结束引号，保留这部分到下次处理
            break
          }

          const jsonStr = buffer.substring(startIdx, contentEnd + 2) // 包含 "}
          try {
            const parsed = JSON.parse(jsonStr)
            if (parsed.content) {
              const chunk = parsed.content;

              // 如果启用了 thinking 模式，处理 thinking 标签
              if (thinkingEnabled) {
                // 将 chunk 添加到适当的缓冲区并检测标签
                let remaining = chunk;

                while (remaining.length > 0) {
                  if (!inThinkingBlock) {
                    // 不在 thinking 块中，查找开始标签
                    const thinkStartIdx = remaining.indexOf(THINKING_START_TAG);
                    if (thinkStartIdx === -1) {
                      // 没有开始标签，全部是普通内容
                      contentBuffer += remaining;
                      if (contentBuffer.length > 0) {
                        yield { type: 'content', content: contentBuffer };
                        contentBuffer = '';
                      }
                      remaining = '';
                    } else {
                      // 找到开始标签
                      if (thinkStartIdx > 0) {
                        // 标签前有内容
                        const beforeTag = remaining.substring(0, thinkStartIdx);
                        yield { type: 'content', content: beforeTag };
                      }
                      inThinkingBlock = true;
                      remaining = remaining.substring(thinkStartIdx + THINKING_START_TAG.length);
                      // 发送 thinking 开始事件
                      yield { type: 'thinking_start' };
                    }
                  } else {
                    // 在 thinking 块中，查找结束标签
                    const thinkEndIdx = remaining.indexOf(THINKING_END_TAG);
                    if (thinkEndIdx === -1) {
                      // 没有结束标签，全部是 thinking 内容
                      thinkingBuffer += remaining;
                      yield { type: 'thinking', thinking: remaining };
                      remaining = '';
                    } else {
                      // 找到结束标签
                      if (thinkEndIdx > 0) {
                        const thinkContent = remaining.substring(0, thinkEndIdx);
                        thinkingBuffer += thinkContent;
                        yield { type: 'thinking', thinking: thinkContent };
                      }
                      inThinkingBlock = false;
                      // 发送 thinking 结束事件
                      yield { type: 'thinking_end', thinking: thinkingBuffer };
                      thinkingBuffer = '';
                      remaining = remaining.substring(thinkEndIdx + THINKING_END_TAG.length);
                    }
                  }
                }
              } else {
                // 未启用 thinking 模式，直接输出
                yield { type: 'content', content: chunk }
              }
            }
          } catch (e) {
            // JSON 解析失败时，记录错误但继续处理
            console.warn('[KiroClient] Stream JSON parse failed:', e.message)
          }

          lastProcessedEnd = contentEnd + 2
          pos = lastProcessedEnd
        }

        // 保留未处理的部分
        if (lastProcessedEnd > 0) {
          buffer = buffer.substring(lastProcessedEnd)
        }
      }

      // 处理流结束时可能残留的内容
      if (thinkingEnabled && contentBuffer.length > 0) {
        yield { type: 'content', content: contentBuffer };
      }
    } finally {
      reader.releaseLock()
    }
  }

  static getSupportedModels() {
    return SUPPORTED_MODELS
  }

  static getModelMapping() {
    return MODEL_MAPPING
  }
}

export default KiroClient
export { SUPPORTED_MODELS, MODEL_MAPPING, checkThinkingMode }
