/**
 * Claude API Compatible Routes
 *
 * Provides /v1/messages and other Anthropic Claude API standard endpoints.
 * Refactored version using modular builders and handlers.
 */

import { Router } from 'express';
import { v4 as uuidv4 } from 'uuid';
import KiroClient, { SUPPORTED_MODELS } from '../../kiro/index.js';
import AccountPool from '../../openai-compat/account-pool.js';
import RequestLogger from '../../openai-compat/request-logger.js';
import { validateApiKey } from '../../openai-compat/auth-middleware.js';
import { generateHeaders } from '../../utils/header-generator.js';
import { getClientIp } from '../../utils/request-utils.js';
import { isRetryableError, isQuotaExhaustedError, isBannedError } from '../../utils/retry-utils.js';
import { getWorkingStatus, buildNonWorkingHoursError } from '../../utils/working-hours.js';
import { estimateTokens } from '../../openai-compat/token-counter.js';

import { MAX_ACCOUNT_RETRIES, ERROR_TYPES } from '../constants.js';
import { buildKiroRequest } from '../builders/request-builder.js';
import { validateAnthropicVersionMiddleware, validateRequest, buildValidationErrorResponse } from '../validators/request-validator.js';
import { handleStream, continueStreamWithNewAccount, StreamState, processStreamEvent } from '../handlers/stream-handler.js';
import { handleNonStream, buildErrorResponse, categorizeError } from '../handlers/non-stream-handler.js';
import { SSEWriter, setupSSEHeaders, buildSSEEvent } from '../response/sse-writer.js';
import { processSystemPrompt } from '../claude-converter.js';

const router = Router();
let accountPool = null;
let requestLogger = null;
let systemLogger = null;
let dbPool = null;

// Read max retries from environment variable, default 5
const maxAccountRetries = parseInt(process.env.MAX_ACCOUNT_RETRIES || '5', 10);

/**
 * Initialize routes
 */
export function initClaudeRoutes(pool, sysLogger = null, externalAccountPool = null) {
  dbPool = pool;
  systemLogger = sysLogger;
  accountPool = externalAccountPool || new AccountPool(dbPool, systemLogger);
  requestLogger = new RequestLogger(dbPool);
  requestLogger.startCleanup();
  return router;
}

/**
 * Get current account pool instance
 */
export function getAccountPool() {
  return accountPool;
}

/**
 * Build error response in Claude format
 */
function buildClaudeError(type, message, status = 400) {
  return {
    status,
    body: {
      type: 'error',
      error: { type, message }
    }
  };
}

/**
 * Estimate input tokens from messages
 */
function estimateInputTokens(messages) {
  const inputText = messages
    ?.map((m) => {
      if (typeof m.content === 'string') return m.content;
      if (Array.isArray(m.content)) {
        return m.content
          .map(block => {
            if (block.type === 'text') return block.text;
            if (block.type === 'tool_result') return JSON.stringify(block.content);
            return '';
          })
          .join('');
      }
      return '';
    })
    .join('');
  return estimateTokens(inputText);
}

// ==================== API Routes ====================

/**
 * POST /v1/messages - Claude Messages API main endpoint
 */
router.post('/v1/messages', validateApiKey, validateAnthropicVersionMiddleware, async (req, res) => {
  const requestId = uuidv4();
  const startTime = Date.now();
  const clientIp = getClientIp(req);
  const userAgent = req.headers['user-agent'];

  // Check working hours
  const status = getWorkingStatus();
  if (!status.isServiceAvailable) {
    const error = buildNonWorkingHoursError('claude');
    return res.status(error.status).json(error.body);
  }

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
    account_id,
    thinking
  } = req.body;

  // Validate request
  const validation = validateRequest(req.body);
  if (!validation.valid) {
    const firstError = validation.errors[0];
    const errorResponse = buildValidationErrorResponse(firstError);
    return res.status(errorResponse.status).json(errorResponse.body);
  }

  // Estimate input tokens
  const inputTokens = estimateInputTokens(messages);

  // Extract thinking mode info
  const isThinking = thinking?.type === 'enabled';
  const thinkingBudget = thinking?.budget_tokens || 0;

  let account = null;

  try {
    const groupId = req.groupId || null;

    // Get account
    try {
      if (account_id) {
        account = await accountPool.getAccountById(account_id);
        if (!account) {
          await accountPool.getAvailableAccounts(groupId);
          account = await accountPool.getAccountById(account_id);
        }
        if (!account) {
          const error = buildClaudeError('invalid_request_error', `Account '${account_id}' not found or not available`, 404);
          return res.status(error.status).json(error.body);
        }
        if (groupId && account.groupId !== groupId) {
          const error = buildClaudeError('invalid_request_error', `Account '${account_id}' does not belong to the authorized group`, 403);
          return res.status(error.status).json(error.body);
        }
      } else {
        account = await accountPool.getNextAccount(groupId);
      }
    } catch (error) {
      console.error('[Claude API] No available account:', error.message);
      const err = buildClaudeError('api_error', 'No available accounts in pool', 503);
      return res.status(err.status).json(err.body);
    }

    console.log(`[Claude API] Using account: ${account.email} for model: ${model}`);
    await accountPool.incrementApiCall(account.id);

    // Build Kiro request using new request builder
    const kiroRequest = buildKiroRequest(req.body, account);
    const kiroHeaders = generateHeaders(account, account.credentials.accessToken);

    // Common options for handlers
    const handlerOptions = {
      model,
      inputTokens,
      currentAccount: account,
      accountPool,
      groupId,
      accountId: account_id,
      maxRetries: maxAccountRetries,
      isRetryableError,
      isQuotaExhaustedError,
      isBannedError,
      onTokenRefresh: async (acc, newTokens) => {
        const expiresAt = Date.now() + (newTokens.expiresIn || 3600) * 1000;
        await accountPool.updateAccountToken(acc.id, newTokens.accessToken, newTokens.refreshToken, expiresAt);
        console.log(`[Claude API] Token refreshed for ${acc.email}`);
      }
    };

    if (stream) {
      // Streaming response
      await handleStreamingRequest(req, res, {
        ...handlerOptions,
        kiroRequest,
        kiroHeaders,
        requestId,
        startTime,
        clientIp,
        userAgent,
        isThinking,
        thinkingBudget
      });
    } else {
      // Non-streaming response
      await handleNonStreamingRequest(req, res, {
        ...handlerOptions,
        kiroRequest,
        kiroHeaders,
        requestId,
        startTime,
        clientIp,
        userAgent,
        isThinking,
        thinkingBudget
      });
    }
  } catch (error) {
    console.error('[Claude API] Unexpected error:', error);
    const err = buildClaudeError('api_error', error.message, 500);
    res.status(err.status).json(err.body);
  }
});

/**
 * Handle streaming request
 */
async function handleStreamingRequest(req, res, options) {
  const {
    model,
    inputTokens,
    currentAccount,
    accountPool,
    groupId,
    accountId,
    maxRetries,
    kiroRequest,
    kiroHeaders,
    requestId,
    startTime,
    clientIp,
    userAgent,
    isThinking,
    thinkingBudget,
    onTokenRefresh,
    isRetryableError,
    isQuotaExhaustedError,
    isBannedError
  } = options;

  let retryCount = 0;
  let account = currentAccount;

  // Create stream function
  const createStream = (acc) => {
    const client = new KiroClient(acc, systemLogger);
    // Extract parameters from kiroRequest for KiroClient
    const messages = req.body.messages;
    const systemPrompt = processSystemPrompt(req.body.system);
    const tools = req.body.tools;

    return client.streamApi(messages, model, {
      system: systemPrompt,
      tools,
      requestBody: {
        thinking: req.body.thinking,
        max_tokens: req.body.max_tokens,
        temperature: req.body.temperature,
        top_p: req.body.top_p,
        top_k: req.body.top_k,
        stop_sequences: req.body.stop_sequences,
        tool_choice: req.body.tool_choice
      }
    });
  };

  // Attempt to create stream with retry logic for initial errors
  const attemptCreateStream = async (acc) => {
    try {
      return await createStream(acc);
    } catch (error) {
      // 402 error: quota exhausted
      if (isQuotaExhaustedError(error)) {
        console.log(`[Claude API] Quota exhausted (402) for account ${acc.email}, marking and switching...`);
        accountPool.markAccountQuotaExhausted(acc.id, error.message);

        if (retryCount < maxRetries && !accountId) {
          retryCount++;
          const newAccount = await accountPool.getNextAccount(groupId);
          if (newAccount && newAccount.id !== acc.id) {
            console.log(`[Claude API] Retry stream with new account after 402: ${newAccount.email}`);
            await accountPool.incrementApiCall(newAccount.id);
            account = newAccount;
            return await attemptCreateStream(newAccount);
          }
        }
      }

      // Other retryable errors
      if (isRetryableError(error) && retryCount < maxRetries && !accountId) {
        await accountPool.markAccountError(acc.id);
        retryCount++;
        const newAccount = await accountPool.getNextAccount(groupId);
        if (newAccount && newAccount.id !== acc.id) {
          await accountPool.incrementApiCall(newAccount.id);
          account = newAccount;
          return await attemptCreateStream(newAccount);
        }
      }

      throw error;
    }
  };

  // Setup SSE
  setupSSEHeaders(res);
  const writer = new SSEWriter(res, model);
  const state = new StreamState();

  writer.writeMessageStart(inputTokens);

  let timeToFirstByte = null;
  let fullContent = '';
  let thinkingContent = '';
  let toolCalls = [];
  let stopReason = 'end_turn';

  const processEvents = async (stream, acc) => {
    for await (const event of stream) {
      if (writer.isClosed()) break;

      // Track first byte
      if (timeToFirstByte === null && (event.type === 'thinking_start' || event.type === 'thinking' || event.type === 'content' || event.type === 'tool_use')) {
        timeToFirstByte = Date.now() - startTime;
      }

      processStreamEvent(event, writer, state, {
        onTokenRefresh: async (newTokens) => {
          if (onTokenRefresh) {
            await onTokenRefresh(acc, newTokens);
          }
        }
      });

      // Track content for logging
      if (event.type === 'content' && event.content) {
        fullContent += event.content;
      } else if (event.type === 'thinking' && event.thinking) {
        thinkingContent += event.thinking;
      } else if (event.type === 'tool_use') {
        toolCalls.push({ id: event.id, name: event.name, input: event.input });
        stopReason = 'tool_use';
      }
    }
  };

  try {
    const stream = await attemptCreateStream(account);
    await processEvents(stream, account);

    // Close any open blocks
    if (state.textBlockStarted) {
      writer.writeContentBlockStop(state.textBlockIndex);
    }

    const outputTokens = estimateTokens(fullContent) + estimateTokens(thinkingContent);
    writer.end(stopReason, outputTokens);

    accountPool.markAccountSuccess(account.id);

    requestLogger.logSuccess({
      requestId,
      accountId: account.id,
      accountEmail: account.email,
      accountIdp: account.idp,
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
      headerVersion: account.headerVersion || 1,
      requestHeaders: kiroHeaders,
      apiProtocol: 'claude'
    });

  } catch (error) {
    console.error('[Claude API] Stream error:', error.message);

    // Handle TOKEN_EXPIRED with account switch
    if (error.message === 'TOKEN_EXPIRED' && !accountId && retryCount < maxRetries) {
      console.log(`[Claude API] TOKEN_EXPIRED during stream, attempting account switch...`);
      await accountPool.markAccountError(account.id);
      retryCount++;

      try {
        const newAccount = await accountPool.getNextAccount(groupId);
        if (newAccount && newAccount.id !== account.id) {
          console.log(`[Claude API] Switching to new account: ${newAccount.email}`);
          await accountPool.incrementApiCall(newAccount.id);
          account = newAccount;

          // Don't reset fullContent and thinkingContent - keep accumulating for logs
          // Only reset stream state
          const newStream = createStream(newAccount);
          const retryStartTime = Date.now();

          await processEvents(newStream, newAccount);

          if (state.textBlockStarted) {
            writer.writeContentBlockStop(state.textBlockIndex);
          }

          const outputTokens = estimateTokens(fullContent) + estimateTokens(thinkingContent);
          writer.end(stopReason, outputTokens);

          accountPool.markAccountSuccess(newAccount.id);

          requestLogger.logSuccess({
            requestId,
            accountId: newAccount.id,
            accountEmail: newAccount.email,
            accountIdp: newAccount.idp,
            model,
            isStream: true,
            requestTokens: inputTokens,
            responseTokens: outputTokens,
            durationMs: Date.now() - startTime,
            timeToFirstByte: Date.now() - retryStartTime,
            clientIp,
            userAgent,
            isThinking,
            thinkingBudget,
            headerVersion: newAccount.headerVersion || 1,
            requestHeaders: kiroHeaders,
            apiProtocol: 'claude'
          });

          console.log(`[Claude API] Successfully recovered from TOKEN_EXPIRED`);
          return;
        }
      } catch (retryError) {
        console.error('[Claude API] Account switch failed:', retryError.message);
      }
    }

    // Handle other errors
    if (isBannedError(error)) {
      await accountPool.banAccount(account.id, error.message);
    } else if (isQuotaExhaustedError(error)) {
      accountPool.markAccountQuotaExhausted(account.id, error.message);
    } else if (isRetryableError(error)) {
      await accountPool.markAccountError(account.id);
    }

    // Determine error type for logging
    let errorType = 'stream_error';
    if (isBannedError(error)) {
      errorType = 'account_banned';
    } else if (isQuotaExhaustedError(error)) {
      errorType = 'quota_exhausted';
    } else if (isRetryableError(error)) {
      errorType = 'token_expired';
    }

    requestLogger.logError({
      requestId,
      accountId: account.id,
      accountEmail: account.email,
      accountIdp: account.idp,
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
      headerVersion: account.headerVersion || 1,
      requestHeaders: kiroHeaders,
      apiProtocol: 'claude'
    });

    if (!writer.isClosed()) {
      writer.writeError(
        isQuotaExhaustedError(error) ? 'quota_exhausted' : 'api_error',
        error.message
      );
    }
  }

  if (!res.writableEnded) {
    res.end();
  }
}

/**
 * Handle non-streaming request
 */
async function handleNonStreamingRequest(req, res, options) {
  const {
    model,
    inputTokens,
    currentAccount,
    accountPool,
    groupId,
    accountId,
    maxRetries,
    kiroRequest,
    kiroHeaders,
    requestId,
    startTime,
    clientIp,
    userAgent,
    isThinking,
    thinkingBudget,
    onTokenRefresh,
    isRetryableError,
    isQuotaExhaustedError,
    isBannedError
  } = options;

  let retryCount = 0;
  let account = currentAccount;

  const executeRequest = async (acc) => {
    const client = new KiroClient(acc, systemLogger);
    const messages = req.body.messages;
    const systemPrompt = processSystemPrompt(req.body.system);
    const tools = req.body.tools;

    const { response, newTokens } = await client.callApi(messages, model, {
      system: systemPrompt,
      tools,
      requestBody: {
        thinking: req.body.thinking,
        max_tokens: req.body.max_tokens,
        temperature: req.body.temperature,
        top_p: req.body.top_p,
        top_k: req.body.top_k,
        stop_sequences: req.body.stop_sequences,
        tool_choice: req.body.tool_choice
      }
    });

    if (newTokens) {
      await onTokenRefresh(acc, newTokens);
    }

    const responseText = await response.text();
    const parsed = client.parseResponse(responseText);
    return { parsed, account: acc };
  };

  try {
    let result;
    try {
      result = await executeRequest(account);
    } catch (error) {
      // Handle quota exhausted (402)
      if (isQuotaExhaustedError(error)) {
        console.log(`[Claude API] Quota exhausted (402) for account ${account.email}, marking and switching...`);
        accountPool.markAccountQuotaExhausted(account.id, error.message);

        if (retryCount < maxRetries && !accountId) {
          retryCount++;
          const newAccount = await accountPool.getNextAccount(groupId);
          if (newAccount && newAccount.id !== account.id) {
            console.log(`[Claude API] Retry with new account after 402: ${newAccount.email}`);
            await accountPool.incrementApiCall(newAccount.id);
            result = await executeRequest(newAccount);
            account = newAccount;
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      } else if (isRetryableError(error) && retryCount < maxRetries && !accountId) {
        await accountPool.markAccountError(account.id);
        retryCount++;

        const newAccount = await accountPool.getNextAccount(groupId);
        if (newAccount && newAccount.id !== account.id) {
          await accountPool.incrementApiCall(newAccount.id);
          result = await executeRequest(newAccount);
          account = newAccount;
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }

    accountPool.markAccountSuccess(result.account.id);

    const outputTokens = estimateTokens(result.parsed.content);
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
    });

    // Determine stop_reason
    const hasToolCalls = result.parsed.toolCalls && result.parsed.toolCalls.length > 0;
    const stopReason = hasToolCalls ? 'tool_use' : 'end_turn';

    // Build content blocks
    let finalContentBlocks = result.parsed.contentBlocks || [];
    if (hasToolCalls) {
      finalContentBlocks = [
        ...finalContentBlocks,
        ...result.parsed.toolCalls.map(tc => ({
          type: 'tool_use',
          id: tc.id,
          name: tc.name,
          input: tc.input
        }))
      ];
    }

    // Build response
    const messageId = `msg_${uuidv4().replace(/-/g, '').substring(0, 24)}`;
    const response = {
      id: messageId,
      type: 'message',
      role: 'assistant',
      content: finalContentBlocks.length > 0 ? finalContentBlocks : [{ type: 'text', text: result.parsed.content || '' }],
      model,
      stop_reason: stopReason,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens
      }
    };

    res.json(response);
  } catch (error) {
    console.error('[Claude API] Error:', error.message);

    if (isBannedError(error)) {
      await accountPool.banAccount(account.id, error.message);
    } else if (isQuotaExhaustedError(error)) {
      accountPool.markAccountQuotaExhausted(account.id, error.message);
    } else if (isRetryableError(error)) {
      await accountPool.markAccountError(account.id);
    }

    const { errorType, status } = categorizeError(error, { isBannedError, isQuotaExhaustedError });
    const err = buildClaudeError(errorType, error.message, status);
    res.status(err.status).json(err.body);
  }
}

/**
 * POST /v1/messages/count_tokens - Token counting endpoint
 */
router.post('/v1/messages/count_tokens', validateApiKey, validateAnthropicVersionMiddleware, async (req, res) => {
  const { model, messages, system, tools } = req.body;

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    const error = buildClaudeError('invalid_request_error', 'messages is required and must be a non-empty array');
    return res.status(error.status).json(error.body);
  }

  try {
    let totalTokens = 0;

    if (system) {
      const systemText = processSystemPrompt(system);
      totalTokens += estimateTokens(systemText);
    }

    for (const message of messages) {
      if (typeof message.content === 'string') {
        totalTokens += estimateTokens(message.content);
      } else if (Array.isArray(message.content)) {
        for (const block of message.content) {
          if (block.type === 'text' && block.text) {
            totalTokens += estimateTokens(block.text);
          } else if (block.type === 'tool_use') {
            totalTokens += estimateTokens(block.name || '');
            totalTokens += estimateTokens(JSON.stringify(block.input || {}));
          } else if (block.type === 'tool_result') {
            const resultContent = typeof block.content === 'string'
              ? block.content
              : JSON.stringify(block.content);
            totalTokens += estimateTokens(resultContent);
          } else if (block.type === 'image') {
            totalTokens += 1600;
          }
        }
      }
    }

    if (tools && Array.isArray(tools)) {
      for (const tool of tools) {
        totalTokens += estimateTokens(tool.name || '');
        totalTokens += estimateTokens(tool.description || '');
        if (tool.input_schema) {
          totalTokens += estimateTokens(JSON.stringify(tool.input_schema));
        }
      }
    }

    res.json({ input_tokens: totalTokens });
  } catch (error) {
    const err = buildClaudeError('api_error', error.message, 500);
    res.status(err.status).json(err.body);
  }
});

/**
 * GET /v1/models - List available models
 */
router.get('/v1/models', validateApiKey, async (req, res) => {
  const models = SUPPORTED_MODELS.map((id) => ({
    id,
    object: 'model',
    created: 1700000000,
    owned_by: 'anthropic'
  }));
  res.json({ object: 'list', data: models });
});

/**
 * GET /v1/models/:model - Get model details
 */
router.get('/v1/models/:model', validateApiKey, async (req, res) => {
  const { model } = req.params;
  if (!SUPPORTED_MODELS.includes(model)) {
    const error = buildClaudeError('not_found_error', `Model '${model}' not found`, 404);
    return res.status(error.status).json(error.body);
  }
  res.json({ id: model, object: 'model', created: 1700000000, owned_by: 'anthropic' });
});

/**
 * GET /v1/pool/status - Get account pool status
 */
router.get('/v1/pool/status', validateApiKey, async (req, res) => {
  try {
    const groupId = req.groupId || null;
    const status = await accountPool.getPoolStatus(groupId);
    res.json(status);
  } catch (error) {
    const err = buildClaudeError('api_error', error.message, 500);
    res.status(err.status).json(err.body);
  }
});

/**
 * POST /v1/pool/refresh - Refresh account pool cache
 */
router.post('/v1/pool/refresh', validateApiKey, async (req, res) => {
  try {
    const groupId = req.groupId || null;
    await accountPool.getAvailableAccounts(groupId);
    const status = await accountPool.getPoolStatus(groupId);
    res.json({ success: true, ...status });
  } catch (error) {
    const err = buildClaudeError('api_error', error.message, 500);
    res.status(err.status).json(err.body);
  }
});

/**
 * GET /api/logs - Get request logs list
 */
router.get('/api/logs', validateApiKey, async (req, res) => {
  try {
    const { page = 1, pageSize = 50, status, accountId, serverId, startTime, endTime } = req.query;
    const result = await requestLogger.getLogs({
      page: parseInt(page),
      pageSize: parseInt(pageSize),
      status,
      accountId,
      serverId,
      startTime,
      endTime
    });
    res.json(result);
  } catch (error) {
    const err = buildClaudeError('api_error', error.message, 500);
    res.status(err.status).json(err.body);
  }
});

/**
 * GET /api/logs/stats - Get request log statistics
 */
router.get('/api/logs/stats', validateApiKey, async (req, res) => {
  try {
    const stats = await requestLogger.getStats();
    res.json(stats);
  } catch (error) {
    const err = buildClaudeError('api_error', error.message, 500);
    res.status(err.status).json(err.body);
  }
});

/**
 * DELETE /api/logs - Clear request logs
 */
router.delete('/api/logs', validateApiKey, async (req, res) => {
  try {
    const [result] = await dbPool.query('DELETE FROM api_request_logs');
    res.json({ success: true, deleted: result.affectedRows });
  } catch (error) {
    const err = buildClaudeError('api_error', error.message, 500);
    res.status(err.status).json(err.body);
  }
});

export default router;
