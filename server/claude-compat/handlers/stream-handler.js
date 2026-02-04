/**
 * Stream Handler
 *
 * Handles Kiro API streaming responses and converts them to Claude SSE events.
 * Supports thinking/content/tool_use events and token refresh with account switching.
 */

import { SSEWriter, setupSSEHeaders } from '../response/sse-writer.js';
import { STOP_REASONS, ERROR_TYPES } from '../constants.js';
import { estimateTokens } from '../../openai-compat/token-counter.js';

/**
 * Stream state tracker
 */
export class StreamState {
  constructor() {
    this.fullContent = '';
    this.thinkingContent = '';
    this.thinkingBlockIndex = -1;
    this.textBlockIndex = -1;
    this.thinkingBlockStarted = false;
    this.textBlockStarted = false;
    this.toolCalls = [];
    this.stopReason = STOP_REASONS.END_TURN;
    this.timeToFirstByte = null;
    this.startTime = Date.now();
  }

  recordFirstByte() {
    if (this.timeToFirstByte === null) {
      this.timeToFirstByte = Date.now() - this.startTime;
    }
  }

  getOutputTokens() {
    return estimateTokens(this.fullContent) + estimateTokens(this.thinkingContent);
  }
}

/**
 * Process a single stream event
 * @param {Object} event - Stream event from Kiro API
 * @param {SSEWriter} writer - SSE writer instance
 * @param {StreamState} state - Stream state tracker
 * @param {Object} callbacks - Callback functions for token refresh etc.
 */
export function processStreamEvent(event, writer, state, callbacks = {}) {
  if (writer.isClosed()) return;

  switch (event.type) {
    case 'thinking_start':
      state.recordFirstByte();
      if (!state.thinkingBlockStarted) {
        state.thinkingBlockIndex = writer.writeThinkingBlockStart();
        state.thinkingBlockStarted = true;
      }
      break;

    case 'thinking':
      if (event.thinking) {
        state.recordFirstByte();
        state.thinkingContent += event.thinking;
        if (state.thinkingBlockIndex >= 0) {
          writer.writeThinkingDelta(state.thinkingBlockIndex, event.thinking);
        }
      }
      break;

    case 'thinking_end':
      if (state.thinkingBlockStarted) {
        writer.writeContentBlockStop(state.thinkingBlockIndex);
        state.thinkingBlockStarted = false;
      }
      break;

    case 'content':
      if (event.content) {
        state.recordFirstByte();
        if (!state.textBlockStarted) {
          state.textBlockIndex = writer.writeTextBlockStart();
          state.textBlockStarted = true;
        }
        state.fullContent += event.content;
        writer.writeTextDelta(state.textBlockIndex, event.content);
      }
      break;

    case 'tool_use':
      state.recordFirstByte();

      // Close text block if open
      if (state.textBlockStarted) {
        writer.writeContentBlockStop(state.textBlockIndex);
        state.textBlockStarted = false;
      }

      // Write complete tool use block
      writer.writeCompleteToolUse(event.id, event.name, event.input);

      // Record tool call
      state.toolCalls.push({
        id: event.id,
        name: event.name,
        input: event.input
      });
      state.stopReason = STOP_REASONS.TOOL_USE;
      break;

    case 'token_refreshed':
      if (event.newTokens && callbacks.onTokenRefresh) {
        callbacks.onTokenRefresh(event.newTokens);
      }
      break;

    case 'error':
      if (callbacks.onError) {
        callbacks.onError(event.error || event.message);
      }
      break;
  }
}

/**
 * Handle streaming response from Kiro API
 * @param {Object} res - Express response object
 * @param {AsyncIterable} stream - Kiro API stream
 * @param {Object} options - Handler options
 * @returns {Promise<Object>} Stream result with content and metrics
 */
export async function handleStream(res, stream, options = {}) {
  const {
    model = 'claude-sonnet-4-5',
    inputTokens = 0,
    onTokenRefresh = null,
    onError = null
  } = options;

  // Setup SSE headers
  setupSSEHeaders(res);

  // Create writer and state
  const writer = new SSEWriter(res, model);
  const state = new StreamState();

  // Send message_start
  writer.writeMessageStart(inputTokens);

  const callbacks = {
    onTokenRefresh,
    onError
  };

  try {
    for await (const event of stream) {
      processStreamEvent(event, writer, state, callbacks);
    }

    // Close any open blocks
    if (state.textBlockStarted) {
      writer.writeContentBlockStop(state.textBlockIndex);
    }

    // End stream
    const outputTokens = state.getOutputTokens();
    writer.end(state.stopReason, outputTokens);

    return {
      success: true,
      content: state.fullContent,
      thinkingContent: state.thinkingContent,
      toolCalls: state.toolCalls,
      outputTokens,
      timeToFirstByte: state.timeToFirstByte,
      stopReason: state.stopReason
    };
  } catch (error) {
    // Don't close writer here - let caller handle retry logic
    throw error;
  }
}

/**
 * Handle streaming with retry support
 * @param {Object} res - Express response object
 * @param {Function} createStream - Function to create stream (account) => stream
 * @param {Object} options - Handler options
 * @returns {Promise<Object>} Stream result
 */
export async function handleStreamWithRetry(res, createStream, options = {}) {
  const {
    model = 'claude-sonnet-4-5',
    inputTokens = 0,
    currentAccount,
    accountPool,
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
  let headersSent = false;
  let writer = null;
  let state = null;

  const attemptStream = async () => {
    const stream = await createStream(account);

    // Setup on first attempt
    if (!headersSent) {
      setupSSEHeaders(res);
      writer = new SSEWriter(res, model);
      state = new StreamState();
      writer.writeMessageStart(inputTokens);
      headersSent = true;
    } else {
      // Reset state for retry but keep writer
      state = new StreamState();
    }

    const callbacks = {
      onTokenRefresh: async (newTokens) => {
        if (onTokenRefresh) {
          await onTokenRefresh(account, newTokens);
        }
      }
    };

    for await (const event of stream) {
      processStreamEvent(event, writer, state, callbacks);
    }

    // Close any open blocks
    if (state.textBlockStarted) {
      writer.writeContentBlockStop(state.textBlockIndex);
    }

    return {
      success: true,
      account,
      content: state.fullContent,
      thinkingContent: state.thinkingContent,
      toolCalls: state.toolCalls,
      outputTokens: state.getOutputTokens(),
      timeToFirstByte: state.timeToFirstByte,
      stopReason: state.stopReason
    };
  };

  try {
    return await attemptStream();
  } catch (error) {
    // Handle quota exhausted
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
          return await attemptStream();
        }
      }
    }

    // Handle retryable errors (TOKEN_EXPIRED etc.)
    if (isRetryableError(error) && retryCount < maxRetries && !accountId && accountPool) {
      await accountPool.markAccountError(account.id);
      retryCount++;

      const newAccount = await accountPool.getNextAccount(groupId);
      if (newAccount && newAccount.id !== account.id) {
        await accountPool.incrementApiCall(newAccount.id);
        account = newAccount;
        return await attemptStream();
      }
    }

    // Handle banned errors
    if (isBannedError(error) && accountPool) {
      await accountPool.banAccount(account.id, error.message);
    }

    // Write error to stream if headers were sent
    if (headersSent && writer && !writer.isClosed()) {
      const errorType = isQuotaExhaustedError(error)
        ? ERROR_TYPES.RATE_LIMIT
        : ERROR_TYPES.API_ERROR;
      writer.writeError(errorType, error.message);
      writer.end(STOP_REASONS.END_TURN, state ? state.getOutputTokens() : 0);
    }

    throw error;
  }
}

/**
 * Continue stream after account switch (for mid-stream TOKEN_EXPIRED)
 * @param {SSEWriter} writer - Existing SSE writer
 * @param {AsyncIterable} stream - New stream from new account
 * @param {Object} options - Options
 * @returns {Promise<Object>} Stream result
 */
export async function continueStreamWithNewAccount(writer, stream, options = {}) {
  const { onTokenRefresh = null } = options;

  // Create fresh state for new stream
  const state = new StreamState();

  const callbacks = {
    onTokenRefresh
  };

  try {
    for await (const event of stream) {
      processStreamEvent(event, writer, state, callbacks);
    }

    // Close any open blocks
    if (state.textBlockStarted) {
      writer.writeContentBlockStop(state.textBlockIndex);
    }

    // End stream
    const outputTokens = state.getOutputTokens();
    writer.end(state.stopReason, outputTokens);

    return {
      success: true,
      content: state.fullContent,
      thinkingContent: state.thinkingContent,
      toolCalls: state.toolCalls,
      outputTokens,
      timeToFirstByte: state.timeToFirstByte,
      stopReason: state.stopReason
    };
  } catch (error) {
    throw error;
  }
}

export default {
  handleStream,
  handleStreamWithRetry,
  continueStreamWithNewAccount,
  processStreamEvent,
  StreamState
};
