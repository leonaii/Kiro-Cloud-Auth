/**
 * Kiro API 客户端
 * 基于 claude-kiro-demo.js 简化实现，专注于 OpenAI 兼容转换
 */

import { v4 as uuidv4 } from 'uuid'
import { generateHeaders } from '../utils/header-generator.js'
import { fetchWithTimeout, DEFAULT_REQUEST_TIMEOUT } from '../utils/fetch-utils.js'
import { checkThinkingMode, extractThinkingFromContent, THINKING_START_TAG, THINKING_END_TAG } from '../utils/thinking-utils.js'
import { KIRO_CONSTANTS, MODEL_MAPPING } from './constants.js'
import { httpAgent, httpsAgent } from './http-agent.js'
import { shortenToolNameIfNeeded, processToolDescription } from './tool-utils.js'

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
    const { enabled: thinkingEnabled, budgetTokens } = checkThinkingMode(requestBody || {})

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
    let finalSystemPrompt = systemPrompt
    if (thinkingEnabled) {
      const thinkingHint = `<thinking_mode>interleaved</thinking_mode><max_thinking_length>${budgetTokens}</max_thinking_length>`
      finalSystemPrompt = finalSystemPrompt ? finalSystemPrompt + '\n' + thinkingHint : thinkingHint
      console.log(`[KiroClient] Thinking mode enabled, budget_tokens: ${budgetTokens}`)
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
        const userInputMessage = {
          content: '',
          modelId: kiroModel,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        }
        const toolResults = []
        const images = []

        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text') {
              userInputMessage.content += part.text
            } else if (part.type === 'tool_result') {
              toolResults.push({
                content: [{ text: typeof part.content === 'string' ? part.content : JSON.stringify(part.content) }],
                status: 'success',
                toolUseId: part.tool_use_id
              })
            } else if (part.type === 'image' && part.source) {
              images.push({
                format: part.source.media_type?.split('/')[1] || 'png',
                source: { bytes: part.source.data }
              })
            }
          }
        } else {
          userInputMessage.content = this.getContentText(msg)
        }

        // 添加图片
        if (images.length > 0) {
          userInputMessage.images = images
        }

        // 添加工具结果（去重）
        if (toolResults.length > 0) {
          const uniqueToolResults = []
          const seenIds = new Set()
          for (const tr of toolResults) {
            if (!seenIds.has(tr.toolUseId)) {
              seenIds.add(tr.toolUseId)
              uniqueToolResults.push(tr)
            }
          }
          userInputMessage.userInputMessageContext = { toolResults: uniqueToolResults }
        }

        history.push({ userInputMessage })
      } else if (msg.role === 'assistant') {
        const assistantResponseMessage = { content: '' }
        const toolUses = []
        let thinkingText = ''

        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'text') {
              assistantResponseMessage.content += part.text
            } else if (part.type === 'thinking') {
              thinkingText += (part.thinking ?? part.text ?? '')
            } else if (part.type === 'tool_use') {
              toolUses.push({
                input: part.input,
                name: part.name,
                toolUseId: part.id
              })
            }
          }
        } else {
          assistantResponseMessage.content = this.getContentText(msg)
        }

        // 将 thinking 内容包装到 content 中
        if (thinkingText) {
          assistantResponseMessage.content = assistantResponseMessage.content
            ? `${THINKING_START_TAG}${thinkingText}${THINKING_END_TAG}\n\n${assistantResponseMessage.content}`
            : `${THINKING_START_TAG}${thinkingText}${THINKING_END_TAG}`
        }

        // 添加工具调用
        if (toolUses.length > 0) {
          assistantResponseMessage.toolUses = toolUses
        }

        history.push({ assistantResponseMessage })
      }
    }

    // 当前消息处理
    const currentMsg = mergedMessages[mergedMessages.length - 1]
    let currentContent = ''
    let currentToolResults = []
    let currentImages = []

    // 如果最后一条消息是 assistant，需要将其加入 history，然后创建一个 user 类型的 currentMessage
    // 因为 Kiro API 的 currentMessage 必须是 userInputMessage 类型
    if (currentMsg.role === 'assistant') {
      console.log('[KiroClient] Last message is assistant, moving it to history and creating user currentMessage')

      // 构建 assistant 消息
      const assistantResponseMessage = { content: '' }
      const toolUses = []
      let thinkingText = ''

      if (Array.isArray(currentMsg.content)) {
        for (const part of currentMsg.content) {
          if (part.type === 'text') {
            assistantResponseMessage.content += part.text
          } else if (part.type === 'thinking') {
            thinkingText += (part.thinking ?? part.text ?? '')
          } else if (part.type === 'tool_use') {
            toolUses.push({
              input: part.input,
              name: part.name,
              toolUseId: part.id
            })
          }
        }
      } else {
        assistantResponseMessage.content = this.getContentText(currentMsg)
      }

      if (thinkingText) {
        assistantResponseMessage.content = assistantResponseMessage.content
          ? `${THINKING_START_TAG}${thinkingText}${THINKING_END_TAG}\n\n${assistantResponseMessage.content}`
          : `${THINKING_START_TAG}${thinkingText}${THINKING_END_TAG}`
      }

      if (toolUses.length > 0) {
        assistantResponseMessage.toolUses = toolUses
      }

      history.push({ assistantResponseMessage })
      // 设置 currentContent 为 "Continue"，因为我们需要一个 user 消息来触发 AI 继续
      currentContent = 'Continue'
    } else {
      // 最后一条消息是 user
      // Kiro API 要求 history 必须以 assistantResponseMessage 结尾
      if (history.length > 0) {
        const lastHistoryItem = history[history.length - 1]
        if (!lastHistoryItem.assistantResponseMessage) {
          // 最后一个不是 assistantResponseMessage，需要补全一个空的
          console.log('[KiroClient] History does not end with assistantResponseMessage, adding empty one')
          history.push({
            assistantResponseMessage: { content: 'Continue' }
          })
        }
      }

      // 处理 user 消息内容
      if (Array.isArray(currentMsg.content)) {
        for (const part of currentMsg.content) {
          if (part.type === 'text') {
            currentContent += part.text
          } else if (part.type === 'tool_result') {
            currentToolResults.push({
              content: [{ text: typeof part.content === 'string' ? part.content : JSON.stringify(part.content) }],
              status: 'success',
              toolUseId: part.tool_use_id
            })
          } else if (part.type === 'image' && part.source) {
            currentImages.push({
              format: part.source.media_type?.split('/')[1] || 'png',
              source: { bytes: part.source.data }
            })
          }
        }
      } else {
        currentContent = this.getContentText(currentMsg)
      }
    }

    // Kiro API 要求 content 不能为空，即使有 toolResults
    if (!currentContent) {
      currentContent = currentToolResults.length > 0 ? 'Tool results provided.' : 'Continue'
    }

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

    // 添加图片到当前消息
    if (currentImages.length > 0) {
      request.conversationState.currentMessage.userInputMessage.images = currentImages
    }

    // 构建 userInputMessageContext
    const userInputMessageContext = {}

    // 添加工具结果（去重）
    if (currentToolResults.length > 0) {
      const uniqueToolResults = []
      const seenToolUseIds = new Set()
      for (const tr of currentToolResults) {
        if (!seenToolUseIds.has(tr.toolUseId)) {
          seenToolUseIds.add(tr.toolUseId)
          uniqueToolResults.push(tr)
        }
      }
      userInputMessageContext.toolResults = uniqueToolResults
    }

    // 添加工具定义（处理名称和描述的截断）
    if (tools && tools.length > 0) {
      userInputMessageContext.tools = tools.map(tool => ({
        toolSpecification: {
          name: shortenToolNameIfNeeded(tool.function?.name || tool.name),
          description: processToolDescription(tool.function?.description || tool.description || ''),
          inputSchema: { json: tool.function?.parameters || tool.parameters || {} }
        }
      }))
    }

    // 只有当 userInputMessageContext 有内容时才添加
    if (Object.keys(userInputMessageContext).length > 0) {
      request.conversationState.currentMessage.userInputMessage.userInputMessageContext = userInputMessageContext
    }

    if (history.length > 0) {
      request.conversationState.history = history
    }

    return request
  }

  /**
   * 获取消息的文本内容
   * 支持多模态内容（文本 + 图片 + 工具调用）
   */
  getContentText(message) {
    if (!message) return ''
    if (typeof message === 'string') return message
    if (typeof message.content === 'string') return message.content
    if (Array.isArray(message.content)) {
      const parts = []
      for (const block of message.content) {
        if (block.type === 'text') {
          parts.push(block.text)
        } else if (block.type === 'tool_result') {
          // 工具结果
          parts.push(`[Tool Result ${block.tool_use_id}]: ${typeof block.content === 'string' ? block.content : JSON.stringify(block.content)}`)
        } else if (block.type === 'tool_use') {
          // 工具调用（assistant 消息中）
          parts.push(`[Tool Call ${block.id}]: ${block.name}(${JSON.stringify(block.input)})`)
        }
        // 图片块不转换为文本，但会在 buildRequest 中单独处理
      }
      return parts.join('\n')
    }
    return String(message.content || message)
  }

  /**
   * 获取消息的完整内容块（包括图片）
   * 用于构建 Kiro 请求
   */
  getContentBlocks(message) {
    if (!message) return []
    if (typeof message === 'string') return [{ type: 'text', text: message }]
    if (typeof message.content === 'string') return [{ type: 'text', text: message.content }]
    if (Array.isArray(message.content)) {
      return message.content.map(block => {
        if (block.type === 'text') {
          return { type: 'text', text: block.text }
        } else if (block.type === 'image') {
          // 图片块
          return {
            type: 'image',
            source: block.source
          }
        } else if (block.type === 'tool_result') {
          return {
            type: 'tool_result',
            tool_use_id: block.tool_use_id,
            content: block.content
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
    }
    return [{ type: 'text', text: String(message.content || message) }]
  }

  mergeContent(content1, content2) {
    const text1 = typeof content1 === 'string' ? content1 : this.getContentText({ content: content1 })
    const text2 = typeof content2 === 'string' ? content2 : this.getContentText({ content: content2 })
    return text1 + '\n' + text2
  }

  /**
   * 解析响应
   * 支持文本内容、thinking 块和工具调用
   */
  parseResponse(rawData) {
    const rawStr = Buffer.isBuffer(rawData) ? rawData.toString('utf8') : String(rawData)
    let fullContent = ''
    const toolCalls = []

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

    // 提取 thinking 块和工具调用
    const contentBlocks = extractThinkingFromContent(fullContent)

    // 解析工具调用（格式：<tool_use>{"id":"...","name":"...","input":{...}}</tool_use>）
    const toolUseRegex = /<tool_use>([\s\S]*?)<\/tool_use>/g
    let toolMatch
    while ((toolMatch = toolUseRegex.exec(fullContent)) !== null) {
      try {
        const toolData = JSON.parse(toolMatch[1])
        toolCalls.push({
          type: 'tool_use',
          id: toolData.id || `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
          name: toolData.name,
          input: toolData.input || {}
        })
      } catch (e) {
        console.warn('[KiroClient] Tool use parse failed:', e.message)
      }
    }

    // 如果有工具调用，从内容中移除工具调用标签
    let cleanContent = fullContent
    if (toolCalls.length > 0) {
      cleanContent = fullContent.replace(/<tool_use>[\s\S]*?<\/tool_use>/g, '').trim()
    }

    return {
      content: cleanContent,
      contentBlocks: contentBlocks,
      toolCalls: toolCalls.length > 0 ? toolCalls : null
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
    const { enabled: thinkingEnabled } = checkThinkingMode(options.requestBody || {})

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
    let inThinkingBlock = false
    let thinkingBuffer = ''
    let contentBuffer = ''

    // 工具调用状态跟踪
    let inToolUseBlock = false
    let toolUseBuffer = ''
    const TOOL_USE_START_TAG = '<tool_use>'
    const TOOL_USE_END_TAG = '</tool_use>'

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
              let chunk = parsed.content

              // 处理工具调用标签
              let remaining = chunk
              while (remaining.length > 0) {
                if (inToolUseBlock) {
                  // 在工具调用块中，查找结束标签
                  const toolEndIdx = remaining.indexOf(TOOL_USE_END_TAG)
                  if (toolEndIdx === -1) {
                    toolUseBuffer += remaining
                    remaining = ''
                  } else {
         toolUseBuffer += remaining.substring(0, toolEndIdx)
                    inToolUseBlock = false
                    // 解析并发送工具调用事件
                    try {
                      const toolData = JSON.parse(toolUseBuffer)
                      yield {
                        type: 'tool_use',
                        id: toolData.id || `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
                        name: toolData.name,
                        input: toolData.input || {}
                      }
                    } catch (e) {
                      console.warn('[KiroClient] Tool use parse failed:', e.message)
                    }
                    toolUseBuffer = ''
                    remaining = remaining.substring(toolEndIdx + TOOL_USE_END_TAG.length)
                  }
                } else {
                  // 不在工具调用块中，查找开始标签
                  const toolStartIdx = remaining.indexOf(TOOL_USE_START_TAG)
                  if (toolStartIdx === -1) {
                    // 没有工具调用标签，处理普通内容
                    if (thinkingEnabled) {
                      // 处理 thinking 标签
                      let thinkRemaining = remaining
                      while (thinkRemaining.length > 0) {
                        if (!inThinkingBlock) {
                          const thinkStartIdx = thinkRemaining.indexOf(THINKING_START_TAG)
                          if (thinkStartIdx === -1) {
                            contentBuffer += thinkRemaining
                            if (contentBuffer.length > 0) {
                              yield { type: 'content', content: contentBuffer }
                              contentBuffer = ''
                            }
                            thinkRemaining = ''
                          } else {
                            if (thinkStartIdx > 0) {
                              yield { type: 'content', content: thinkRemaining.substring(0, thinkStartIdx) }
                            }
                            inThinkingBlock = true
                            thinkRemaining = thinkRemaining.substring(thinkStartIdx + THINKING_START_TAG.length)
                            yield { type: 'thinking_start' }
                          }
                        } else {
                          const thinkEndIdx = thinkRemaining.indexOf(THINKING_END_TAG)
                          if (thinkEndIdx === -1) {
                            thinkingBuffer += thinkRemaining
                            yield { type: 'thinking', thinking: thinkRemaining }
                            thinkRemaining = ''
                          } else {
                            if (thinkEndIdx > 0) {
                              const thinkContent = thinkRemaining.substring(0, thinkEndIdx)
                              thinkingBuffer += thinkContent
                              yield { type: 'thinking', thinking: thinkContent }
                            }
                            inThinkingBlock = false
                            yield { type: 'thinking_end', thinking: thinkingBuffer }
                            thinkingBuffer = ''
                            thinkRemaining = thinkRemaining.substring(thinkEndIdx + THINKING_END_TAG.length)
                          }
                        }
                      }
                    } else {
                      yield { type: 'content', content: remaining }
                    }
                    remaining = ''
                  } else {
                    // 找到工具调用开始标签
                    if (toolStartIdx > 0) {
                      // 标签前有内容，先处理
                      const beforeTool = remaining.substring(0, toolStartIdx)
                      if (thinkingEnabled) {
                        // 简化处理：直接输出
                        yield { type: 'content', content: beforeTool }
                      } else {
                        yield { type: 'content', content: beforeTool }
                      }
                    }
                    inToolUseBlock = true
                    remaining = remaining.substring(toolStartIdx + TOOL_USE_START_TAG.length)
                  }
                }
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
        yield { type: 'content', content: contentBuffer }
      }
    } finally {
      reader.releaseLock()
    }
  }

  static getSupportedModels() {
    return Object.keys(MODEL_MAPPING)
  }

  static getModelMapping() {
    return MODEL_MAPPING
  }
}

export default KiroClient
