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
 * @returns {object}
 */
export function buildOpenAIResponse(content, model, inputTokens, outputTokens, finishReason = 'stop', contentBlocks = null) {
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
