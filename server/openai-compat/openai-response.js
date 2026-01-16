/**
 * OpenAI 响应构建器
 */

import { v4 as uuidv4 } from 'uuid'

/**
 * 构建 OpenAI 格式的响应
 * @param {string} content - 响应内容
 * @param {string} model - 模型名称
 * @param {number} inputTokens - 输入 token 数
 * @param {number} outputTokens - 输出 token 数
 * @param {string} finishReason - 结束原因
 * @param {Array} contentBlocks - 内容块（包含 text/thinking 类型）
 * @param {Array} toolCalls - 工具调用列表
 * @returns {object}
 */
export function buildOpenAIResponse(content, model, inputTokens, outputTokens, finishReason = 'stop', contentBlocks = null, toolCalls = null) {
  const message = { role: 'assistant', content }

  // 如果有 thinking 内容，添加 reasoning_content
  if (contentBlocks && contentBlocks.length > 0) {
    const thinkingBlocks = contentBlocks.filter(b => b.type === 'thinking')
    if (thinkingBlocks.length > 0) {
      message.reasoning_content = thinkingBlocks.map(b => b.thinking).join('\n')
    }
  }

  // 如果有工具调用，添加 tool_calls
  if (toolCalls && toolCalls.length > 0) {
    message.tool_calls = toolCalls.map(tc => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
      }
    }))
    // 工具调用时，finish_reason 应该是 'tool_calls'
    finishReason = 'tool_calls'
    // 如果只有工具调用没有文本内容，content 可以为 null
    if (!content || content.trim() === '') {
      message.content = null
    }
  }

  const response = {
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
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

  return response
}

/**
 * 构建 SSE 流式响应块
 * @param {string} content - 内容
 * @param {string} model - 模型名称
 * @param {string|null} finishReason - 结束原因
 * @param {string} deltaType - delta 类型：'content' 或 'thinking'
 * @param {boolean} isFirst - 是否为首个 chunk（首个 chunk 需要包含 role: 'assistant'）
 * @returns {string}
 */
export function buildStreamChunk(content, model, finishReason = null, deltaType = 'content', isFirst = false) {
  let delta = {}

  if (finishReason) {
    // 结束 chunk，delta 为空
    delta = {}
  } else if (isFirst) {
    // 第一个 chunk，包含 role 和 content
    if (deltaType === 'thinking') {
      delta = { role: 'assistant', reasoning_content: content }
    } else {
      delta = { role: 'assistant', content }
    }
  } else {
    // 后续 chunk，只包含 content
    if (deltaType === 'thinking') {
      delta = { reasoning_content: content }
    } else {
      delta = { content }
    }
  }

  const chunk = {
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: finishReason
      }
    ]
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}

/**
 * 构建工具调用的流式响应块
 * @param {string} toolCallId - 工具调用 ID
 * @param {string} functionName - 函数名称
 * @param {object} functionArgs - 函数参数
 * @param {string} model - 模型名称
 * @param {boolean} isFirst - 是否为首个 chunk
 * @returns {string}
 */
export function buildToolCallChunk(toolCallId, functionName, functionArgs, model, isFirst = false) {
  const argsStr = typeof functionArgs === 'string' ? functionArgs : JSON.stringify(functionArgs)

  const delta = {
    tool_calls: [{
      index: 0,
      id: toolCallId,
      type: 'function',
      function: {
        name: functionName,
        arguments: argsStr
      }
    }]
  }

  // 首个 chunk 需要包含 role
  if (isFirst) {
    delta.role = 'assistant'
  }

  const chunk = {
    id: `chatcmpl-${uuidv4()}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta,
        logprobs: null,
        finish_reason: null
      }
    ]
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}
