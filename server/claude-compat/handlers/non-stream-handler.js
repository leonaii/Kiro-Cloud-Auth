/**
 * Non-Stream Handler
 *
 * Handles non-streaming Kiro API responses and converts them to Claude response format.
 */

import { v4 as uuidv4 } from 'uuid';
import { STOP_REASONS, CONTENT_BLOCK_TYPES } from '../constants.js';
import { estimateTokens } from '../../openai-compat/token-counter.js';

/**
 * Build Claude response from parsed Kiro response
 * @param {Object} parsed - Parsed Kiro response
 * @param {Object} options - Response options
 * @returns {Object} Claude API response
 */
export function buildClaudeResponseFromParsed(parsed, options = {}) {
  const {
    model = 'claude-sonnet-4-5',
    inputTokens = 0
  } = options;

  const messageId = `msg_${uuidv4().replace(/-/g, '').substring(0, 24)}`;

  // Determine stop reason
  const hasToolCalls = parsed.toolCalls && parsed.toolCalls.length > 0;
  const stopReason = hasToolCalls ? STOP_REASONS.TOOL_USE : STOP_REASONS.END_TURN;

  // Build content blocks
  let contentBlocks = [];

  // Add thinking block if present
  if (parsed.thinkingContent) {
    contentBlocks.push({
      type: CONTENT_BLOCK_TYPES.THINKING,
      thinking: parsed.thinkingContent
    });
  }

  // Add text block if present
  if (parsed.content) {
    contentBlocks.push({
      type: CONTENT_BLOCK_TYPES.TEXT,
      text: parsed.content
    });
  }

  // Add existing content blocks (if any)
  if (parsed.contentBlocks && parsed.contentBlocks.length > 0) {
    // Filter out duplicates (text blocks we already added)
    const existingBlocks = parsed.contentBlocks.filter(block => {
      if (block.type === CONTENT_BLOCK_TYPES.TEXT && parsed.content) {
        return false; // Skip, we already added text
      }
      if (block.type === CONTENT_BLOCK_TYPES.THINKING && parsed.thinkingContent) {
        return false; // Skip, we already added thinking
      }
      return true;
    });
    contentBlocks = [...contentBlocks, ...existingBlocks];
  }

  // Add tool use blocks
  if (hasToolCalls) {
    for (const tc of parsed.toolCalls) {
      contentBlocks.push({
        type: CONTENT_BLOCK_TYPES.TOOL_USE,
        id: tc.id,
        name: tc.name,
        input: tc.input || {}
      });
    }
  }

  // If no content blocks, add empty text block
  if (contentBlocks.length === 0) {
    contentBlocks.push({
      type: CONTENT_BLOCK_TYPES.TEXT,
      text: ''
    });
  }

  // Calculate output tokens
  const outputTokens = estimateTokens(parsed.content || '') +
    estimateTokens(parsed.thinkingContent || '');

  return {
    id: messageId,
    type: 'message',
    role: 'assistant',
    content: contentBlocks,
    model: model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: outputTokens
    }
  };
}

/**
 * Handle non-streaming response from Kiro API
 * @param {Function} executeRequest - Function to execute request (account) => {parsed, newTokens}
 * @param {Object} options - Handler options
 * @returns {Promise<Object>} Response result
 */
export async function handleNonStream(executeRequest, options = {}) {
  const {
    model = 'claude-sonnet-4-5',
    inputTokens = 0,
    currentAccount,
    accountPool = null,
    groupId = null,
    accountId = null,
    maxRetries = 5,
    onTokenRefresh = null,
    isRetryableError = () => false,
    isQuotaExhaustedError = () => false,
    isBannedError = () => false
  } = options;

  let retryCount = 0;
  let account = currentAccount;

  const attemptRequest = async () => {
    const { parsed, newTokens } = await executeRequest(account);

    // Handle token refresh
    if (newTokens && onTokenRefresh) {
      await onTokenRefresh(account, newTokens);
    }

    return {
      success: true,
      account,
      parsed,
      response: buildClaudeResponseFromParsed(parsed, { model, inputTokens })
    };
  };

  try {
    return await attemptRequest();
  } catch (error) {
    // Handle quota exhausted (402)
    if (isQuotaExhaustedError(error)) {
      if (accountPool) {
        accountPool.markAccountQuotaExhausted(account.id, error.message);
      }

      if (retryCount < maxRetries && !accountId && accountPool) {
        retryCount++;
        const newAccount = await accountPool.getNextAccount(groupId);
        if (newAccount && newAccount.id !== account.id) {
          await accountPool.incrementApiCall(newAccount.id);
          account = newAccount;
          return await attemptRequest();
        }
      }
    }

    // Handle retryable errors
    if (isRetryableError(error) && retryCount < maxRetries && !accountId && accountPool) {
      if (accountPool) {
        await accountPool.markAccountError(account.id);
      }
      retryCount++;

      const newAccount = await accountPool.getNextAccount(groupId);
      if (newAccount && newAccount.id !== account.id) {
        await accountPool.incrementApiCall(newAccount.id);
        account = newAccount;
        return await attemptRequest();
      }
    }

    // Handle banned errors
    if (isBannedError(error) && accountPool) {
      await accountPool.banAccount(account.id, error.message);
    }

    // Re-throw with account info
    error.account = account;
    throw error;
  }
}

/**
 * Build error response in Claude format
 * @param {string} errorType - Error type
 * @param {string} message - Error message
 * @param {number} status - HTTP status code
 * @returns {Object} Error response object
 */
export function buildErrorResponse(errorType, message, status = 500) {
  return {
    status,
    body: {
      type: 'error',
      error: {
        type: errorType,
        message: message
      }
    }
  };
}

/**
 * Determine error type and status from error
 * @param {Error} error - Error object
 * @param {Object} errorCheckers - Error checker functions
 * @returns {{errorType: string, status: number}}
 */
export function categorizeError(error, errorCheckers = {}) {
  const {
    isBannedError = () => false,
    isQuotaExhaustedError = () => false
  } = errorCheckers;

  if (isBannedError(error)) {
    return { errorType: 'account_banned', status: 403 };
  }

  if (isQuotaExhaustedError(error)) {
    return { errorType: 'quota_exhausted', status: 402 };
  }

  return { errorType: 'api_error', status: 500 };
}

export default {
  handleNonStream,
  buildClaudeResponseFromParsed,
  buildErrorResponse,
  categorizeError
};
