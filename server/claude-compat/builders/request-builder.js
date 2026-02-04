/**
 * Request Builder
 *
 * Core request builder that constructs Kiro API requests from Claude API requests.
 * Reference: kiro2api/backend/internal/logic/kiro/kiro_relay.go buildKiroRequest()
 */

import { v4 as uuidv4 } from 'uuid';
import {
  MODEL_MAPPINGS,
  DEFAULT_MODEL,
  KIRO_ORIGIN,
  KIRO_CHAT_TRIGGER_TYPE,
  THINKING_MAX_BUDGET_TOKENS,
  THINKING_DEFAULT_BUDGET_TOKENS,
  THINKING_MODE_TAG,
  THINKING_MAX_LEN_TAG,
  MAX_HISTORY_ITEMS,
  KEEP_IMAGE_THRESHOLD,
  DEFAULT_CONTINUE_CONTENT,
  DEFAULT_TOOL_RESULTS_PROVIDED
} from '../constants.js';

import {
  getContentText,
  preprocessMessages,
  mergeAdjacentMessages,
  processUserContentBlocks,
  processAssistantContentBlocks,
  buildAssistantContentWithThinking,
  truncateText,
  addImagePlaceholder
} from './message-processor.js';

import {
  convertTools,
  matchToolResults,
  deduplicateToolResults,
  formatToolUsesForKiro,
  hasToolUses
} from './tool-processor.js';

/**
 * Get Kiro model ID from Claude model name
 * @param {string} model - Claude model name
 * @returns {string} Kiro model ID
 */
export function getKiroModelId(model) {
  if (MODEL_MAPPINGS[model]) {
    return MODEL_MAPPINGS[model];
  }
  // Default model
  return MODEL_MAPPINGS[DEFAULT_MODEL] || 'anthropic.claude-sonnet-4-20250514-v1:0';
}

/**
 * Generate thinking prefix for system prompt
 * @param {Object} thinking - Thinking configuration
 * @returns {string} Thinking prefix
 */
export function generateThinkingPrefix(thinking) {
  if (!thinking || thinking.type !== 'enabled') {
    return '';
  }

  let budget = thinking.budget_tokens || thinking.budgetTokens || THINKING_DEFAULT_BUDGET_TOKENS;

  if (budget <= 0) {
    budget = THINKING_DEFAULT_BUDGET_TOKENS;
  }
  if (budget > THINKING_MAX_BUDGET_TOKENS) {
    budget = THINKING_MAX_BUDGET_TOKENS;
  }

  return `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`;
}

/**
 * Check if text already has thinking prefix
 * @param {string} text - Text to check
 * @returns {boolean} True if has thinking prefix
 */
export function hasThinkingPrefix(text) {
  if (!text) return false;
  return text.includes(THINKING_MODE_TAG) || text.includes(THINKING_MAX_LEN_TAG);
}

/**
 * Build Kiro request from Claude request
 * @param {Object} claudeRequest - Claude API request
 * @param {Object} account - Kiro account
 * @param {Object} options - Additional options
 * @returns {Object} Kiro API request
 */
export function buildKiroRequest(claudeRequest, account, options = {}) {
  const { enableHistoryCompress = false } = options;

  const modelId = getKiroModelId(claudeRequest.model);

  // Preprocess messages - separate system and convert tool messages
  const { systemPrompt: baseSystemPrompt, processedMessages: preprocessed } = preprocessMessages(
    claudeRequest.messages || [],
    claudeRequest.system
  );

  // Generate thinking prefix
  const thinkingPrefix = generateThinkingPrefix(claudeRequest.thinking);

  // Combine system prompt with thinking prefix
  let systemPrompt = baseSystemPrompt;
  if (thinkingPrefix) {
    if (!systemPrompt) {
      systemPrompt = thinkingPrefix;
    } else if (!hasThinkingPrefix(systemPrompt)) {
      systemPrompt = thinkingPrefix + '\n' + systemPrompt;
    }
  }

  // Merge adjacent same-role messages
  const mergedMessages = mergeAdjacentMessages(preprocessed);

  // Ensure we have at least one message
  let messages = mergedMessages;
  if (messages.length === 0) {
    messages = [{
      role: 'user',
      content: [{ type: 'text', text: DEFAULT_CONTINUE_CONTENT }]
    }];
  }

  // Convert tools
  const toolsContext = convertTools(claudeRequest.tools);

  // Build history
  const history = [];
  let startIndex = 0;

  // Handle system prompt - add to first user message
  if (systemPrompt) {
    if (messages[0].role === 'user') {
      // Add system prompt to first user message
      const firstUserContent = getContentText(messages[0].content);
      const combinedContent = (systemPrompt + '\n\n' + firstUserContent).trim() || DEFAULT_CONTINUE_CONTENT;

      history.push({
        userInputMessage: {
          content: combinedContent,
          modelId: modelId,
          origin: KIRO_ORIGIN
        }
      });
      startIndex = 1;
    } else {
      // System prompt as standalone user message
      history.push({
        userInputMessage: {
          content: systemPrompt,
          modelId: modelId,
          origin: KIRO_ORIGIN
        }
      });
    }
  }

  // Process history messages (all except last)
  for (let i = startIndex; i < messages.length - 1; i++) {
    const msg = messages[i];
    const distanceFromEnd = (messages.length - 1) - i;
    const shouldKeepImages = distanceFromEnd <= KEEP_IMAGE_THRESHOLD;

    if (msg.role === 'user') {
      const historyItem = buildUserHistoryItem(msg, modelId, shouldKeepImages, history, enableHistoryCompress);
      if (historyItem) {
        history.push(historyItem);
      }
    } else if (msg.role === 'assistant') {
      const historyItem = buildAssistantHistoryItem(msg, enableHistoryCompress);
      if (historyItem) {
        history.push(historyItem);
      }
    }
  }

  // Process last message
  const lastMessage = messages[messages.length - 1];
  let currentMessage;
  let additionalToolResults = [];

  if (lastMessage.role === 'assistant') {
    // Last message is assistant - add to history, use "Continue" as current
    const historyItem = buildAssistantHistoryItem(lastMessage, false);
    if (historyItem) {
      history.push(historyItem);

      // If assistant has tool uses, need to provide tool results
      if (historyItem.assistantResponseMessage && hasToolUses(historyItem.assistantResponseMessage)) {
        additionalToolResults = historyItem.assistantResponseMessage.toolUses.map(tu => ({
          content: [{ text: 'Tool execution completed.' }],
          status: 'success',
          toolUseId: tu.toolUseId
        }));
      }
    }

    currentMessage = buildCurrentMessage(
      DEFAULT_CONTINUE_CONTENT,
      [],
      additionalToolResults,
      modelId,
      toolsContext,
      history
    );
  } else {
    // Last message is user - ensure history ends with assistant
    if (history.length > 0) {
      const lastHistoryItem = history[history.length - 1];
      if (!lastHistoryItem.assistantResponseMessage) {
        // Add placeholder assistant message
        history.push({
          assistantResponseMessage: {
            content: DEFAULT_CONTINUE_CONTENT
          }
        });
      }
    }

    // Process user message content
    const { textContent, toolResults, images } = processUserContentBlocks(lastMessage.content, true);

    currentMessage = buildCurrentMessage(
      textContent,
      images,
      toolResults,
      modelId,
      toolsContext,
      history
    );
  }

  // Apply history compression if enabled
  let finalHistory = history;
  if (enableHistoryCompress && history.length > MAX_HISTORY_ITEMS) {
    finalHistory = history.slice(history.length - MAX_HISTORY_ITEMS);

    // Ensure first message is user (Kiro API requirement)
    while (finalHistory.length > 0 && finalHistory[0].assistantResponseMessage) {
      finalHistory = finalHistory.slice(1);
    }
  }

  // Final check: first user message cannot have toolResults
  if (finalHistory.length > 0 && finalHistory[0].userInputMessage) {
    if (finalHistory[0].userInputMessage.userInputMessageContext) {
      delete finalHistory[0].userInputMessage.userInputMessageContext.toolResults;
      if (Object.keys(finalHistory[0].userInputMessage.userInputMessageContext).length === 0) {
        finalHistory[0].userInputMessage.userInputMessageContext = undefined;
      }
    }
  }

  // If history is empty, current message cannot have toolResults
  if (finalHistory.length === 0 && currentMessage.userInputMessageContext) {
    delete currentMessage.userInputMessageContext.toolResults;
    if (Object.keys(currentMessage.userInputMessageContext).length === 0) {
      currentMessage.userInputMessageContext = undefined;
    }
  }

  // Build final request
  const request = {
    conversationState: {
      chatTriggerType: KIRO_CHAT_TRIGGER_TYPE,
      conversationId: uuidv4(),
      currentMessage: {
        userInputMessage: currentMessage
      }
    }
  };

  // Add profileArn if available
  if (account && account.profileArn) {
    request.profileArn = account.profileArn;
  }

  // Add history if non-empty
  if (finalHistory.length > 0) {
    request.conversationState.history = finalHistory;
  }

  return request;
}

/**
 * Build user history item
 * @private
 */
function buildUserHistoryItem(msg, modelId, shouldKeepImages, history, enableHistoryCompress) {
  const { textContent, toolResults, images, imageCount } = processUserContentBlocks(
    msg.content,
    shouldKeepImages
  );

  const userMsg = {
    content: textContent,
    modelId: modelId,
    origin: KIRO_ORIGIN
  };

  // Add images
  if (images.length > 0) {
    userMsg.images = images;
  }

  // Add image placeholder if images were omitted
  if (imageCount > 0) {
    userMsg.content = addImagePlaceholder(userMsg.content, imageCount);
  }

  // Handle tool results based on Kiro API constraints
  let finalToolResults = toolResults;

  if (history.length === 0) {
    // First message cannot have toolResults
    finalToolResults = [];
  } else {
    const lastHistoryItem = history[history.length - 1];
    if (lastHistoryItem.assistantResponseMessage && hasToolUses(lastHistoryItem.assistantResponseMessage)) {
      // Match tool results to previous assistant's tool uses
      finalToolResults = matchToolResults(toolResults, lastHistoryItem.assistantResponseMessage.toolUses);
    } else {
      // Previous message doesn't have tool uses, clear tool results
      finalToolResults = [];
    }
  }

  // Add tool results context
  if (finalToolResults.length > 0) {
    const uniqueToolResults = deduplicateToolResults(finalToolResults);
    userMsg.userInputMessageContext = {
      toolResults: uniqueToolResults
    };
  }

  // Ensure content is not empty
  if (!userMsg.content || userMsg.content.trim() === '') {
    userMsg.content = DEFAULT_CONTINUE_CONTENT;
  }

  return { userInputMessage: userMsg };
}

/**
 * Build assistant history item
 * @private
 */
function buildAssistantHistoryItem(msg, enableHistoryCompress) {
  const { textContent, thinkingContent, toolUses } = processAssistantContentBlocks(msg.content);

  let content = buildAssistantContentWithThinking(textContent, thinkingContent);

  // Truncate if compression enabled
  if (enableHistoryCompress) {
    content = truncateText(content);
  }

  const assistantMsg = {
    content: content || ' '  // Kiro requires non-empty content
  };

  // Add tool uses
  if (toolUses.length > 0) {
    assistantMsg.toolUses = formatToolUsesForKiro(toolUses);
    // Ensure content is not empty when there are tool uses
    if (!assistantMsg.content || assistantMsg.content.trim() === '') {
      assistantMsg.content = ' ';
    }
  }

  return { assistantResponseMessage: assistantMsg };
}

/**
 * Build current message (userInputMessage)
 * @private
 */
function buildCurrentMessage(textContent, images, toolResults, modelId, toolsContext, history) {
  let content = textContent;

  // Ensure content is not empty
  if (!content || content.trim() === '') {
    if (toolResults.length > 0) {
      content = DEFAULT_TOOL_RESULTS_PROVIDED;
    } else {
      content = DEFAULT_CONTINUE_CONTENT;
    }
  }

  const userInputMessage = {
    content: content,
    modelId: modelId,
    origin: KIRO_ORIGIN
  };

  // Add images
  if (images && images.length > 0) {
    userInputMessage.images = images;
  }

  // Build context
  const context = {};

  // Handle tool results - must match last assistant's tool uses
  if (history.length > 0) {
    const lastHistoryItem = history[history.length - 1];
    if (lastHistoryItem.assistantResponseMessage && hasToolUses(lastHistoryItem.assistantResponseMessage)) {
      const matchedResults = matchToolResults(toolResults, lastHistoryItem.assistantResponseMessage.toolUses);
      if (matchedResults.length > 0) {
        context.toolResults = deduplicateToolResults(matchedResults);
      }
    }
  }

  // Add tools
  if (toolsContext && toolsContext.length > 0) {
    context.tools = toolsContext;
  }

  // Only add context if non-empty
  if (Object.keys(context).length > 0) {
    userInputMessage.userInputMessageContext = context;
  }

  return userInputMessage;
}

export default buildKiroRequest;
