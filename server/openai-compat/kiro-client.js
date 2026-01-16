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

// Helper functions for tool calls and JSON parsing (参照 claude-kiro.js)

function isQuoteCharAt(text, index) {
  if (index < 0 || index >= text.length) return false
  const ch = text[index]
  return ch === '"' || ch === "'" || ch === '`'
}

function findRealTag(text, tag, startIndex = 0) {
  let searchStart = Math.max(0, startIndex)
  while (true) {
    const pos = text.indexOf(tag, searchStart)
    if (pos === -1) return -1
    
    const hasQuoteBefore = isQuoteCharAt(text, pos - 1)
    const hasQuoteAfter = isQuoteCharAt(text, pos + tag.length)
    if (!hasQuoteBefore && !hasQuoteAfter) {
      return pos
    }
    
    searchStart = pos + 1
  }
}

/**
 * 通用的括号匹配函数 - 支持多种括号类型
 */
function findMatchingBracket(text, startPos, openChar = '[', closeChar = ']') {
  if (!text || startPos >= text.length || text[startPos] !== openChar) {
    return -1
  }

  let bracketCount = 1
  let inString = false
  let escapeNext = false

  for (let i = startPos + 1; i < text.length; i++) {
    const char = text[i]

    if (escapeNext) {
      escapeNext = false
      continue
    }

    if (char === '\\' && inString) {
      escapeNext = true
      continue
    }

    if (char === '"' && !escapeNext) {
      inString = !inString
      continue
    }

    if (!inString) {
      if (char === openChar) {
        bracketCount++
      } else if (char === closeChar) {
        bracketCount--
        if (bracketCount === 0) {
          return i
        }
      }
    }
  }
  return -1
}

/**
 * 尝试修复常见的 JSON 格式问题
 */
function repairJson(jsonStr) {
  let repaired = jsonStr
  // 移除尾部逗号
  repaired = repaired.replace(/,\s*([}\]])/g, '$1')
  // 为未引用的键添加引号
  repaired = repaired.replace(/([{,]\s*)([a-zA-Z0-9_]+?)\s*:/g, '$1"$2":')
  // 确保字符串值被正确引用
  repaired = repaired.replace(/:\s*([a-zA-Z0-9_]+)(?=[,\}\]])/g, ':"$1"')
  return repaired
}

/**
 * 解析单个工具调用文本
 */
function parseSingleToolCall(toolCallText) {
  const namePattern = /\[Called\s+(\w+)\s+with\s+args:/i
  const nameMatch = toolCallText.match(namePattern)

  if (!nameMatch) {
    return null
  }

  const functionName = nameMatch[1].trim()
  const argsStartMarker = "with args:"
  const argsStartPos = toolCallText.toLowerCase().indexOf(argsStartMarker.toLowerCase())

  if (argsStartPos === -1) {
    return null
  }

  const argsStart = argsStartPos + argsStartMarker.length
  const argsEnd = toolCallText.lastIndexOf(']')

  if (argsEnd <= argsStart) {
    return null
  }

  const jsonCandidate = toolCallText.substring(argsStart, argsEnd).trim()

  try {
    const repairedJson = repairJson(jsonCandidate)
    const argumentsObj = JSON.parse(repairedJson)

    if (typeof argumentsObj !== 'object' || argumentsObj === null) {
      return null
    }

    const toolCallId = `call_${uuidv4().replace(/-/g, '').substring(0, 8)}`
    return {
      id: toolCallId,
      type: "function",
      function: {
        name: functionName,
        arguments: JSON.stringify(argumentsObj)
      }
    }
  } catch (e) {
    console.error(`[KiroClient] Failed to parse tool call arguments: ${e.message}`, jsonCandidate)
    return null
  }
}

/**
 * 解析 bracket 格式的工具调用 [Called xxx with args: {...}]
 */
function parseBracketToolCalls(responseText) {
  if (!responseText || !responseText.includes("[Called")) {
    return null
  }

  const toolCalls = []
  const callPositions = []
  let start = 0
  while (true) {
    const pos = responseText.indexOf("[Called", start)
    if (pos === -1) {
      break
    }
    callPositions.push(pos)
    start = pos + 1
  }

  for (let i = 0; i < callPositions.length; i++) {
    const startPos = callPositions[i]
    let endSearchLimit
    if (i + 1 < callPositions.length) {
      endSearchLimit = callPositions[i + 1]
    } else {
      endSearchLimit = responseText.length
    }

    const segment = responseText.substring(startPos, endSearchLimit)
    const bracketEnd = findMatchingBracket(segment, 0)

    let toolCallText
    if (bracketEnd !== -1) {
      toolCallText = segment.substring(0, bracketEnd + 1)
    } else {
      // Fallback: if no matching bracket, try to find the last ']' in the segment
      const lastBracket = segment.lastIndexOf(']')
      if (lastBracket !== -1) {
        toolCallText = segment.substring(0, lastBracket + 1)
      } else {
        continue // Skip this one if no closing bracket found
      }
    }
    
    const parsedCall = parseSingleToolCall(toolCallText)
    if (parsedCall) {
      toolCalls.push(parsedCall)
    }
  }
  return toolCalls.length > 0 ? toolCalls : null
}

/**
 * 去重工具调用
 */
function deduplicateToolCalls(toolCalls) {
  const seen = new Set()
  const uniqueToolCalls = []

  for (const tc of toolCalls) {
    const key = `${tc.function.name}-${tc.function.arguments}`
    if (!seen.has(key)) {
      seen.add(key)
      uniqueToolCalls.push(tc)
    } else {
      console.log(`[KiroClient] Skipping duplicate tool call: ${tc.function.name}`)
    }
  }
  return uniqueToolCalls
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
   * 构建 Kiro 请求（参照 claude-kiro.js 的 buildCodewhispererRequest 实现）
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

    // 处理消息 - 深拷贝以避免修改原始数据
    const processedMessages = messages.map(msg => ({
      role: msg.role,
      content: Array.isArray(msg.content) ? [...msg.content] : msg.content
    }))

    // 判断最后一条消息是否为 assistant，如果是且内容为 "{" 则移除
    if (processedMessages.length > 0) {
      const lastMessage = processedMessages[processedMessages.length - 1]
      if (lastMessage.role === 'assistant') {
        const content = Array.isArray(lastMessage.content) ? lastMessage.content : [{ type: 'text', text: lastMessage.content }]
        if (content.length > 0 && content[0].type === 'text' && content[0].text === '{') {
          console.log('[KiroClient] Removing last assistant with "{" message')
          processedMessages.pop()
        }
      }
    }

    // 合并相邻相同 role 的消息
    const mergedMessages = []
    for (const msg of processedMessages) {
      if (mergedMessages.length === 0) {
        mergedMessages.push({ ...msg, content: Array.isArray(msg.content) ? [...msg.content] : msg.content })
      } else {
        const last = mergedMessages[mergedMessages.length - 1]
        if (msg.role === last.role) {
          // 合并消息内容
          if (Array.isArray(last.content) && Array.isArray(msg.content)) {
            last.content.push(...msg.content)
          } else if (typeof last.content === 'string' && typeof msg.content === 'string') {
            last.content += '\n' + msg.content
          } else if (Array.isArray(last.content) && typeof msg.content === 'string') {
            last.content.push({ type: 'text', text: msg.content })
          } else if (typeof last.content === 'string' && Array.isArray(msg.content)) {
            last.content = [{ type: 'text', text: last.content }, ...msg.content]
          }
        } else {
          mergedMessages.push({ ...msg, content: Array.isArray(msg.content) ? [...msg.content] : msg.content })
        }
      }
    }

    const history = []
    let startIndex = 0

    // 处理 system prompt，如果启用了 thinking 模式则注入提示
    let finalSystemPrompt = systemPrompt ? this.getContentText(systemPrompt) : null;
    if (thinkingEnabled) {
      // 使用 enabled 模式（与 claude-kiro.js 一致）
      const thinkingHint = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budgetTokens}</max_thinking_length>`;
      if (!finalSystemPrompt) {
        finalSystemPrompt = thinkingHint;
      } else if (!finalSystemPrompt.includes('<thinking_mode>')) {
        finalSystemPrompt = thinkingHint + '\n' + finalSystemPrompt;
      }
      console.log(`[KiroClient] Thinking mode enabled, budget_tokens: ${budgetTokens}`);
    }

    // 处理 system prompt
    if (finalSystemPrompt) {
      if (mergedMessages[0]?.role === 'user') {
        const firstUserContent = this.getContentText(mergedMessages[0])
        history.push({
          userInputMessage: {
            content: `${finalSystemPrompt}\n\n${firstUserContent}`,
            modelId: kiroModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
          }
        })
        startIndex = 1
      } else {
        history.push({
          userInputMessage: {
            content: finalSystemPrompt,
            modelId: kiroModel,
            origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
          }
        })
      }
    }

    // 保留最近 5 条历史消息中的图片
    const keepImageThreshold = 5

    // 构建历史消息（不包括最后一条）
    for (let i = startIndex; i < mergedMessages.length - 1; i++) {
      const msg = mergedMessages[i]
      const distanceFromEnd = (mergedMessages.length - 1) - i
      const shouldKeepImages = distanceFromEnd <= keepImageThreshold

      if (msg.role === 'user') {
        const userInputMessage = this.buildUserInputMessage(msg, kiroModel, shouldKeepImages)
        history.push({ userInputMessage })
      } else if (msg.role === 'assistant') {
        const assistantResponseMessage = this.buildAssistantResponseMessage(msg)
        history.push({ assistantResponseMessage })
      }
    }

    // 处理当前消息（最后一条）
    let currentMessage = mergedMessages[mergedMessages.length - 1]
    let currentContent = ''
    let currentToolResults = []
    let currentImages = []

    // 如果最后一条消息是 assistant，需要将其加入 history，然后创建一个 user 类型的 currentMessage
    if (currentMessage && currentMessage.role === 'assistant') {
      console.log('[KiroClient] Last message is assistant, moving it to history and creating user currentMessage')
      
      const assistantResponseMessage = this.buildAssistantResponseMessage(currentMessage)
      history.push({ assistantResponseMessage })
      
      // 设置 currentContent 为 "Continue"
      currentContent = 'Continue'
    } else if (currentMessage) {
      // 最后一条消息是 user，需要确保 history 最后一个元素是 assistantResponseMessage
      if (history.length > 0) {
        const lastHistoryItem = history[history.length - 1]
        if (!lastHistoryItem.assistantResponseMessage) {
          console.log('[KiroClient] History does not end with assistantResponseMessage, adding empty one')
          history.push({
            assistantResponseMessage: {
              content: 'Continue'
            }
          })
        }
      }

      // 处理 user 消息（支持 OpenAI 和 Claude 两种格式）
      const content = currentMessage.content
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === 'text') {
            currentContent += part.text || ''
          } else if (part.type === 'tool_result') {
            // Claude 格式的工具结果
            currentToolResults.push({
              content: [{ text: this.getContentText(part.content) }],
              status: part.is_error ? 'error' : 'success',
              toolUseId: part.tool_use_id
            })
          } else if (part.type === 'image' && part.source) {
            // Claude 格式的图片
            currentImages.push({
              format: part.source.media_type?.split('/')[1] || 'png',
              source: {
                bytes: part.source.data
              }
            })
          } else if (part.type === 'image_url' && part.image_url) {
            // OpenAI 格式的图片
            const imageUrl = part.image_url.url || ''
            if (imageUrl.startsWith('data:')) {
              // Base64 格式: data:image/png;base64,xxxxx
              const matches = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/)
              if (matches) {
                currentImages.push({
                  format: matches[1] || 'png',
                  source: {
                    bytes: matches[2]
                  }
                })
              }
            }
            // URL 格式暂不支持，需要下载图片
          }
        }
      } else {
        currentContent = this.getContentText(currentMessage)
      }

      // 处理 OpenAI 格式的工具结果（role: 'tool'）
      // 注意：这种情况在 convertMessages 之后不会出现，因为 tool 角色会被转换
      // 但为了兼容性，这里也处理一下
      if (currentMessage.role === 'tool' && currentMessage.tool_call_id) {
        currentToolResults.push({
          content: [{ text: this.getContentText(currentMessage.content) }],
          status: 'success',
          toolUseId: currentMessage.tool_call_id
        })
        if (!currentContent) {
          currentContent = 'Tool results provided.'
        }
      }

      // Kiro API 要求 content 不能为空
      if (!currentContent) {
        currentContent = currentToolResults.length > 0 ? 'Tool results provided.' : 'Continue'
      }
    } else {
      currentContent = 'Continue'
    }

    // 构建请求
    const request = {
      conversationState: {
        chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
        conversationId,
        currentMessage: {}
      }
    }

    // 只有当 history 非空时才添加
    if (history.length > 0) {
      request.conversationState.history = history
    }

    // 构建 userInputMessage
    const userInputMessage = {
      content: currentContent,
      modelId: kiroModel,
      origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
    }

    // 添加图片
    if (currentImages.length > 0) {
      userInputMessage.images = currentImages
    }

    // 构建 userInputMessageContext
    const userInputMessageContext = {}

    // 添加 toolResults（去重）
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

    // 添加工具（处理名称和描述的截断，过滤 web_search）
    if (tools && tools.length > 0) {
      const filteredTools = tools.filter(tool => {
        const name = (tool.function?.name || tool.name || '').toLowerCase()
        const shouldIgnore = name === 'web_search' || name === 'websearch'
        if (shouldIgnore) {
          console.log(`[KiroClient] Ignoring tool: ${tool.function?.name || tool.name}`)
        }
        return !shouldIgnore
      })

      if (filteredTools.length > 0) {
        userInputMessageContext.tools = filteredTools.map(tool => ({
          toolSpecification: {
            name: shortenToolNameIfNeeded(tool.function?.name || tool.name),
            description: processToolDescription(tool.function?.description || tool.description || ''),
            inputSchema: { json: tool.function?.parameters || tool.input_schema || {} }
          }
        }))
      }
    }

    // 只有当 userInputMessageContext 有内容时才添加
    if (Object.keys(userInputMessageContext).length > 0) {
      userInputMessage.userInputMessageContext = userInputMessageContext
    }

    request.conversationState.currentMessage.userInputMessage = userInputMessage

    // 如果是 social 认证，添加 profileArn
    if (this.authMethod === 'social' && this.account.credentials?.profileArn) {
      request.profileArn = this.account.credentials.profileArn
    }

    return request
  }

  /**
   * 构建 user 消息（用于历史记录，支持 OpenAI 和 Claude 两种格式）
   */
  buildUserInputMessage(msg, kiroModel, shouldKeepImages = true) {
    const userInputMessage = {
      content: '',
      modelId: kiroModel,
      origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
    }
    
    let imageCount = 0
    const toolResults = []
    const images = []
    const content = msg.content

    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'text') {
          userInputMessage.content += part.text || ''
        } else if (part.type === 'tool_result') {
          // Claude 格式的工具结果
          toolResults.push({
            content: [{ text: this.getContentText(part.content) }],
            status: part.is_error ? 'error' : 'success',
            toolUseId: part.tool_use_id
          })
        } else if (part.type === 'image' && part.source) {
          // Claude 格式的图片
          if (shouldKeepImages) {
            images.push({
              format: part.source.media_type?.split('/')[1] || 'png',
              source: {
                bytes: part.source.data
              }
            })
          } else {
            imageCount++
          }
        } else if (part.type === 'image_url' && part.image_url) {
          // OpenAI 格式的图片
          const imageUrl = part.image_url.url || ''
          if (imageUrl.startsWith('data:')) {
            const matches = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/)
            if (matches) {
              if (shouldKeepImages) {
                images.push({
                  format: matches[1] || 'png',
                  source: {
                    bytes: matches[2]
                  }
                })
              } else {
                imageCount++
              }
            }
          }
        }
      }
    } else {
      userInputMessage.content = this.getContentText(msg)
    }

    // 处理 OpenAI 格式的工具结果（role: 'tool'）
    if (msg.role === 'tool' && msg.tool_call_id) {
      toolResults.push({
        content: [{ text: this.getContentText(msg.content) }],
        status: 'success',
        toolUseId: msg.tool_call_id
      })
      if (!userInputMessage.content) {
        userInputMessage.content = 'Tool results provided.'
      }
    }

    // 添加保留的图片
    if (images.length > 0) {
      userInputMessage.images = images
    }

    // 添加图片占位符
    if (imageCount > 0) {
      const imagePlaceholder = `[此消息包含 ${imageCount} 张图片，已在历史记录中省略]`
      userInputMessage.content = userInputMessage.content
        ? `${userInputMessage.content}\n${imagePlaceholder}`
        : imagePlaceholder
    }

    // 添加 toolResults（去重）
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

    return userInputMessage
  }

  /**
   * 构建 assistant 消息（用于历史记录，支持 OpenAI 和 Claude 两种格式）
   */
  buildAssistantResponseMessage(msg) {
    const assistantResponseMessage = {
      content: ''
    }
    
    const toolUses = []
    let thinkingText = ''
    const content = msg.content

    if (Array.isArray(content)) {
      for (const part of content) {
        if (part.type === 'text') {
          assistantResponseMessage.content += part.text || ''
        } else if (part.type === 'thinking') {
          thinkingText += (part.thinking || part.text || '')
        } else if (part.type === 'tool_use') {
          // Claude 格式的工具调用
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

    // 处理 OpenAI 格式的工具调用（tool_calls 数组）
    if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
      for (const toolCall of msg.tool_calls) {
        if (toolCall.type === 'function' && toolCall.function) {
          let input = {}
          try {
            input = JSON.parse(toolCall.function.arguments || '{}')
          } catch (e) {
            console.warn('[KiroClient] Failed to parse tool call arguments:', e.message)
          }
          toolUses.push({
            input,
            name: toolCall.function.name,
            toolUseId: toolCall.id
          })
        }
      }
    }

    // 将 thinking 内容包装在标签中
    if (thinkingText) {
      assistantResponseMessage.content = assistantResponseMessage.content
        ? `${THINKING_START_TAG}${thinkingText}${THINKING_END_TAG}\n\n${assistantResponseMessage.content}`
        : `${THINKING_START_TAG}${thinkingText}${THINKING_END_TAG}`
    }

    // 添加 toolUses
    if (toolUses.length > 0) {
      assistantResponseMessage.toolUses = toolUses
    }

    return assistantResponseMessage
  }

  /**
   * 提取消息内容的文本（参照 claude-kiro.js 的实现）
   * 支持多种格式：字符串、消息对象、内容块数组
   */
  getContentText(message) {
    if (message == null) {
      return ''
    }
    // 如果直接传入的是数组（内容块数组）
    if (Array.isArray(message)) {
      return message.map(part => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          if (part.type === 'text' && part.text) return part.text
          if (part.text) return part.text
        }
        return ''
      }).join('')
    }
    // 如果是字符串
    if (typeof message === 'string') {
      return message
    }
    // 如果是消息对象，检查 content 属性
    if (typeof message.content === 'string') {
      return message.content
    }
    // 如果 content 是数组
    if (Array.isArray(message.content)) {
      return message.content.map(part => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          if (part.type === 'text' && part.text) return part.text
          if (part.text) return part.text
        }
        return ''
      }).join('')
    }
    // 最后的回退：尝试转换为字符串，但避免 [object Object]
    if (message.content != null) {
      if (typeof message.content === 'object') {
        return JSON.stringify(message.content)
      }
      return String(message.content)
    }
    if (typeof message === 'object') {
      return JSON.stringify(message)
    }
    return String(message)
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
    let inThinkingBlock = false
    let thinkingBuffer = ''
    let contentBuffer = ''
    
    // 工具调用状态跟踪
    let currentToolCall = null
    let totalContent = ''
    let lastContentEvent = null // 用于检测连续重复的 content 事件

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // 解析 AWS Event Stream 格式的事件（参照 claude-kiro.js 的 parseAwsEventStreamBuffer）
        const { events, remaining } = this.parseAwsEventStreamBuffer(buffer)
        buffer = remaining

        // 处理所有解析出的事件
        for (const event of events) {
          if (event.type === 'content' && event.data) {
            // 检查是否与上一个 content 事件完全相同（Kiro API 有时会重复发送）
            if (lastContentEvent === event.data) {
              continue
            }
            lastContentEvent = event.data
            totalContent += event.data

            // 如果启用了 thinking 模式，处理 thinking 标签
            if (thinkingEnabled) {
              let remaining = event.data

              while (remaining.length > 0) {
                if (!inThinkingBlock) {
                  // 不在 thinking 块中，查找开始标签
                  const thinkStartIdx = findRealTag(remaining, THINKING_START_TAG)
                  if (thinkStartIdx === -1) {
                    // 没有开始标签，全部是普通内容
                    contentBuffer += remaining
                    if (contentBuffer.length > 0) {
                      yield { type: 'content', content: contentBuffer }
                      contentBuffer = ''
                    }
                    remaining = ''
                  } else {
                    // 找到开始标签
                    if (thinkStartIdx > 0) {
                      const beforeTag = remaining.substring(0, thinkStartIdx)
                      yield { type: 'content', content: beforeTag }
                    }
                    inThinkingBlock = true
                    remaining = remaining.substring(thinkStartIdx + THINKING_START_TAG.length)
                    yield { type: 'thinking_start' }
                  }
                } else {
                  // 在 thinking 块中，查找结束标签
                  const thinkEndIdx = findRealTag(remaining, THINKING_END_TAG)
                  if (thinkEndIdx === -1) {
                    // 没有结束标签，全部是 thinking 内容
                    thinkingBuffer += remaining
                    yield { type: 'thinking', thinking: remaining }
                    remaining = ''
                  } else {
                    // 找到结束标签
                    if (thinkEndIdx > 0) {
                      const thinkContent = remaining.substring(0, thinkEndIdx)
                      thinkingBuffer += thinkContent
                      yield { type: 'thinking', thinking: thinkContent }
                    }
                    inThinkingBlock = false
                    yield { type: 'thinking_end', thinking: thinkingBuffer }
                    thinkingBuffer = ''
                    remaining = remaining.substring(thinkEndIdx + THINKING_END_TAG.length)
                  }
                }
              }
            } else {
              // 未启用 thinking 模式，直接输出
              yield { type: 'content', content: event.data }
            }
          } else if (event.type === 'toolUse') {
            // 工具调用事件（包含 name 和 toolUseId）
            const tc = event.data
            if (tc.name && tc.toolUseId) {
              // 检查是否是同一个工具调用的续传
              if (currentToolCall && currentToolCall.toolUseId === tc.toolUseId) {
                currentToolCall.input += tc.input || ''
              } else {
                // 不同的工具调用，先保存之前的
                if (currentToolCall) {
                  yield { type: 'toolUse', toolUse: currentToolCall }
                }
                currentToolCall = {
                  toolUseId: tc.toolUseId,
                  name: tc.name,
                  input: tc.input || ''
                }
              }
              // 如果这个事件包含 stop，完成工具调用
              if (tc.stop) {
                yield { type: 'toolUse', toolUse: currentToolCall }
                currentToolCall = null
              }
            }
          } else if (event.type === 'toolUseInput') {
            // 工具调用的 input 续传事件
            if (currentToolCall) {
              currentToolCall.input += event.data.input || ''
            }
          } else if (event.type === 'toolUseStop') {
            // 工具调用结束事件
            if (currentToolCall && event.data.stop) {
              yield { type: 'toolUse', toolUse: currentToolCall }
              currentToolCall = null
            }
          } else if (event.type === 'contextUsage') {
            // 上下文使用百分比事件
            yield { type: 'contextUsage', contextUsagePercentage: event.data.contextUsagePercentage }
          }
        }
      }

      // 处理未完成的工具调用
      if (currentToolCall) {
        yield { type: 'toolUse', toolUse: currentToolCall }
        currentToolCall = null
      }

      // 处理流结束时可能残留的内容
      if (thinkingEnabled && contentBuffer.length > 0) {
        yield { type: 'content', content: contentBuffer }
      }

      // 检查文本内容中的 bracket 格式工具调用
      const bracketToolCalls = parseBracketToolCalls(totalContent)
      if (bracketToolCalls && bracketToolCalls.length > 0) {
        for (const btc of bracketToolCalls) {
          let input = {}
          try {
            input = JSON.parse(btc.function.arguments || '{}')
          } catch (e) {
            // 保持原样
          }
          yield {
            type: 'toolUse',
            toolUse: {
              toolUseId: btc.id || `tool_${uuidv4()}`,
              name: btc.function.name,
              input
            }
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  /**
   * 解析 AWS Event Stream 格式，提取所有完整的 JSON 事件
   * 参照 claude-kiro.js 的 parseAwsEventStreamBuffer 实现
   * @param {string} buffer - 原始缓冲区字符串
   * @returns {{ events: Array, remaining: string }} 解析出的事件数组和未处理完的缓冲区
   */
  parseAwsEventStreamBuffer(buffer) {
    const events = []
    let remaining = buffer
    let searchStart = 0
    
    while (true) {
      // 查找真正的 JSON payload 起始位置
      // AWS Event Stream 包含二进制头部，我们只搜索有效的 JSON 模式
      // Kiro 返回格式: {"content":"..."} 或 {"name":"xxx","toolUseId":"xxx",...} 或 {"followupPrompt":"..."}
      
      // 搜索所有可能的 JSON payload 开头模式
      const contentStart = remaining.indexOf('{"content":', searchStart)
      const nameStart = remaining.indexOf('{"name":', searchStart)
      const followupStart = remaining.indexOf('{"followupPrompt":', searchStart)
      const inputStart = remaining.indexOf('{"input":', searchStart)
      const stopStart = remaining.indexOf('{"stop":', searchStart)
      const contextUsageStart = remaining.indexOf('{"contextUsagePercentage":', searchStart)
      
      // 找到最早出现的有效 JSON 模式
      const candidates = [contentStart, nameStart, followupStart, inputStart, stopStart, contextUsageStart].filter(pos => pos >= 0)
      if (candidates.length === 0) break
      
      const jsonStart = Math.min(...candidates)
      if (jsonStart < 0) break
      
      // 正确处理嵌套的 {} - 使用括号计数法
      let braceCount = 0
      let jsonEnd = -1
      let inString = false
      let escapeNext = false
      
      for (let i = jsonStart; i < remaining.length; i++) {
        const char = remaining[i]
        
        if (escapeNext) {
          escapeNext = false
          continue
        }
        
        if (char === '\\') {
          escapeNext = true
          continue
        }
        
        if (char === '"') {
          inString = !inString
          continue
        }
        
        if (!inString) {
          if (char === '{') {
            braceCount++
          } else if (char === '}') {
            braceCount--
            if (braceCount === 0) {
              jsonEnd = i
              break
            }
          }
        }
      }
      
      if (jsonEnd < 0) {
        // 不完整的 JSON，保留在缓冲区等待更多数据
        remaining = remaining.substring(jsonStart)
        break
      }
      
      const jsonStr = remaining.substring(jsonStart, jsonEnd + 1)
      try {
        const parsed = JSON.parse(jsonStr)
        // 处理 content 事件
        if (parsed.content !== undefined && !parsed.followupPrompt) {
          events.push({ type: 'content', data: parsed.content })
        }
        // 处理结构化工具调用事件 - 开始事件（包含 name 和 toolUseId）
        else if (parsed.name && parsed.toolUseId) {
          events.push({
            type: 'toolUse',
            data: {
              name: parsed.name,
              toolUseId: parsed.toolUseId,
              input: parsed.input || '',
              stop: parsed.stop || false
            }
          })
        }
        // 处理工具调用的 input 续传事件（只有 input 字段）
        else if (parsed.input !== undefined && !parsed.name) {
          events.push({
            type: 'toolUseInput',
            data: {
              input: parsed.input
            }
          })
        }
        // 处理工具调用的结束事件（只有 stop 字段，且不包含 contextUsagePercentage）
        else if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) {
          events.push({
            type: 'toolUseStop',
            data: {
              stop: parsed.stop
            }
          })
        }
        // 处理上下文使用百分比事件（最后一条消息）
        else if (parsed.contextUsagePercentage !== undefined) {
          events.push({
            type: 'contextUsage',
            data: {
              contextUsagePercentage: parsed.contextUsagePercentage
            }
          })
        }
      } catch (e) {
        // JSON 解析失败，跳过这个位置继续搜索
      }
      
      searchStart = jsonEnd + 1
      if (searchStart >= remaining.length) {
        remaining = ''
        break
      }
    }
    
    // 如果 searchStart 有进展，截取剩余部分
    if (searchStart > 0 && remaining.length > 0) {
      remaining = remaining.substring(searchStart)
    }
    
    return { events, remaining }
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
