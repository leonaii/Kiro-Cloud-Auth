/**
 * Claude API Integration Tests
 *
 * These tests verify the complete API flow from request to response.
 * Note: These tests mock the Kiro backend and account pool.
 */

import { jest } from '@jest/globals';

// Mock modules before importing
const mockKiroClient = {
  streamApi: jest.fn(),
  callApi: jest.fn(),
  parseResponse: jest.fn()
};

const mockAccountPool = {
  getNextAccount: jest.fn(),
  getAccountById: jest.fn(),
  incrementApiCall: jest.fn(),
  markAccountSuccess: jest.fn(),
  markAccountError: jest.fn(),
  markAccountQuotaExhausted: jest.fn(),
  banAccount: jest.fn(),
  updateAccountToken: jest.fn(),
  getPoolStatus: jest.fn(),
  getAvailableAccounts: jest.fn()
};

const mockRequestLogger = {
  logSuccess: jest.fn(),
  logError: jest.fn(),
  startCleanup: jest.fn(),
  getLogs: jest.fn(),
  getStats: jest.fn()
};

// Test fixtures
const testAccount = {
  id: 'acc_123',
  email: 'test@example.com',
  idp: 'google',
  groupId: 'group_1',
  headerVersion: 1,
  profileArn: 'arn:aws:iam::123456789:profile/test',
  credentials: {
    accessToken: 'test_access_token',
    refreshToken: 'test_refresh_token'
  }
};

describe('Claude API Integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAccountPool.getNextAccount.mockResolvedValue(testAccount);
    mockAccountPool.getAccountById.mockResolvedValue(testAccount);
  });

  describe('Request Building', () => {
    it('should build valid Kiro request from simple Claude request', async () => {
      const { buildKiroRequest } = await import('../builders/request-builder.js');

      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Hello, how are you?' }
        ]
      };

      const kiroRequest = buildKiroRequest(claudeRequest, testAccount);

      expect(kiroRequest.conversationState).toBeDefined();
      expect(kiroRequest.conversationState.chatTriggerType).toBe('MANUAL');
      expect(kiroRequest.conversationState.conversationId).toBeDefined();
      expect(kiroRequest.conversationState.currentMessage.userInputMessage.content).toBe('Hello, how are you?');
      expect(kiroRequest.conversationState.currentMessage.userInputMessage.origin).toBe('AI_EDITOR');
      expect(kiroRequest.profileArn).toBe(testAccount.profileArn);
    });

    it('should build request with system prompt', async () => {
      const { buildKiroRequest } = await import('../builders/request-builder.js');

      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        system: 'You are a helpful assistant.',
        messages: [
          { role: 'user', content: 'Hello' }
        ]
      };

      const kiroRequest = buildKiroRequest(claudeRequest, testAccount);

      // System prompt should be in history
      expect(kiroRequest.conversationState.history).toBeDefined();
      expect(kiroRequest.conversationState.history[0].userInputMessage.content).toContain('You are a helpful assistant.');
    });

    it('should build request with thinking mode', async () => {
      const { buildKiroRequest } = await import('../builders/request-builder.js');

      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        max_tokens: 8192,
        thinking: { type: 'enabled', budget_tokens: 16000 },
        messages: [
          { role: 'user', content: 'Solve this step by step: 2+2*3' }
        ]
      };

      const kiroRequest = buildKiroRequest(claudeRequest, testAccount);

      // Should have thinking prefix in history
      const historyContent = kiroRequest.conversationState.history?.[0]?.userInputMessage?.content || '';
      expect(historyContent).toContain('<thinking_mode>enabled</thinking_mode>');
      expect(historyContent).toContain('<max_thinking_length>16000</max_thinking_length>');
    });

    it('should build request with tools', async () => {
      const { buildKiroRequest } = await import('../builders/request-builder.js');

      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Search for cats' }
        ],
        tools: [
          {
            name: 'search',
            description: 'Search the web for information',
            input_schema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' }
              },
              required: ['query']
            }
          }
        ]
      };

      const kiroRequest = buildKiroRequest(claudeRequest, testAccount);

      const context = kiroRequest.conversationState.currentMessage.userInputMessage.userInputMessageContext;
      expect(context).toBeDefined();
      expect(context.tools).toBeDefined();
      expect(context.tools).toHaveLength(1);
      expect(context.tools[0].toolSpecification.name).toBe('search');
    });

    it('should build request with multi-turn conversation', async () => {
      const { buildKiroRequest } = await import('../builders/request-builder.js');

      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'What is 2+2?' },
          { role: 'assistant', content: '2+2 equals 4.' },
          { role: 'user', content: 'And what is 3+3?' }
        ]
      };

      const kiroRequest = buildKiroRequest(claudeRequest, testAccount);

      expect(kiroRequest.conversationState.history).toBeDefined();
      expect(kiroRequest.conversationState.history.length).toBeGreaterThan(0);
    });

    it('should build request with tool use and tool result', async () => {
      const { buildKiroRequest } = await import('../builders/request-builder.js');

      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: 'Search for cats' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will search for cats.' },
              { type: 'tool_use', id: 'toolu_123', name: 'search', input: { query: 'cats' } }
            ]
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_123', content: 'Found 10 results about cats.' }
            ]
          }
        ]
      };

      const kiroRequest = buildKiroRequest(claudeRequest, testAccount);

      expect(kiroRequest.conversationState).toBeDefined();
      // Should have proper history with tool uses and results
    });
  });

  describe('Request Validation', () => {
    it('should validate required messages field', async () => {
      const { validateRequest } = await import('../validators/request-validator.js');

      const result = validateRequest({
        max_tokens: 1024
        // missing messages
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('messages');
    });

    it('should validate required max_tokens field', async () => {
      const { validateRequest } = await import('../validators/request-validator.js');

      const result = validateRequest({
        messages: [{ role: 'user', content: 'Hello' }]
        // missing max_tokens
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('max_tokens');
    });

    it('should validate messages array is not empty', async () => {
      const { validateRequest } = await import('../validators/request-validator.js');

      const result = validateRequest({
        messages: [],
        max_tokens: 1024
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('non-empty');
    });

    it('should validate message role', async () => {
      const { validateRequest } = await import('../validators/request-validator.js');

      const result = validateRequest({
        messages: [{ role: 'invalid_role', content: 'Hello' }],
        max_tokens: 1024
      });

      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('role');
    });

    it('should pass validation for valid request', async () => {
      const { validateRequest } = await import('../validators/request-validator.js');

      const result = validateRequest({
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should validate thinking parameter', async () => {
      const { validateRequest } = await import('../validators/request-validator.js');

      const result = validateRequest({
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1024,
        thinking: { type: 'invalid' }
      });

      expect(result.valid).toBe(false);
    });
  });

  describe('Response Building', () => {
    it('should build Claude response from parsed Kiro response', async () => {
      const { buildClaudeResponseFromParsed } = await import('../handlers/non-stream-handler.js');

      const parsed = {
        content: 'Hello! How can I help you today?',
        contentBlocks: [{ type: 'text', text: 'Hello! How can I help you today?' }],
        toolCalls: []
      };

      const response = buildClaudeResponseFromParsed(parsed, {
        model: 'claude-sonnet-4-5',
        inputTokens: 10
      });

      expect(response.id).toMatch(/^msg_/);
      expect(response.type).toBe('message');
      expect(response.role).toBe('assistant');
      expect(response.model).toBe('claude-sonnet-4-5');
      expect(response.stop_reason).toBe('end_turn');
      expect(response.content).toBeDefined();
      expect(response.usage.input_tokens).toBe(10);
    });

    it('should build response with tool_use stop reason', async () => {
      const { buildClaudeResponseFromParsed } = await import('../handlers/non-stream-handler.js');

      const parsed = {
        content: 'I will search for that.',
        contentBlocks: [{ type: 'text', text: 'I will search for that.' }],
        toolCalls: [
          { id: 'toolu_123', name: 'search', input: { query: 'cats' } }
        ]
      };

      const response = buildClaudeResponseFromParsed(parsed, {
        model: 'claude-sonnet-4-5',
        inputTokens: 10
      });

      expect(response.stop_reason).toBe('tool_use');
      expect(response.content.some(c => c.type === 'tool_use')).toBe(true);
    });

    it('should build response with thinking content', async () => {
      const { buildClaudeResponseFromParsed } = await import('../handlers/non-stream-handler.js');

      const parsed = {
        content: 'The answer is 8.',
        thinkingContent: 'Let me calculate: 2+2*3 = 2+6 = 8',
        contentBlocks: [],
        toolCalls: []
      };

      const response = buildClaudeResponseFromParsed(parsed, {
        model: 'claude-sonnet-4-5',
        inputTokens: 10
      });

      expect(response.content.some(c => c.type === 'thinking')).toBe(true);
      expect(response.content.some(c => c.type === 'text')).toBe(true);
    });
  });

  describe('SSE Event Building', () => {
    it('should build valid SSE event string', async () => {
      const { buildSSEEvent } = await import('../response/sse-writer.js');

      const event = buildSSEEvent('message_start', {
        type: 'message_start',
        message: { id: 'msg_123' }
      });

      expect(event).toContain('event: message_start');
      expect(event).toContain('data: ');
      expect(event).toContain('"type":"message_start"');
      expect(event).toContain('\n\n');
    });
  });

  describe('Error Handling', () => {
    it('should categorize banned error correctly', async () => {
      const { categorizeError } = await import('../handlers/non-stream-handler.js');

      const error = new Error('Bad credentials');
      const result = categorizeError(error, {
        isBannedError: (e) => e.message.includes('Bad credentials'),
        isQuotaExhaustedError: () => false
      });

      expect(result.errorType).toBe('account_banned');
      expect(result.status).toBe(403);
    });

    it('should categorize quota exhausted error correctly', async () => {
      const { categorizeError } = await import('../handlers/non-stream-handler.js');

      const error = new Error('Quota exceeded');
      const result = categorizeError(error, {
        isBannedError: () => false,
        isQuotaExhaustedError: (e) => e.message.includes('Quota')
      });

      expect(result.errorType).toBe('quota_exhausted');
      expect(result.status).toBe(402);
    });

    it('should default to api_error for unknown errors', async () => {
      const { categorizeError } = await import('../handlers/non-stream-handler.js');

      const error = new Error('Unknown error');
      const result = categorizeError(error, {
        isBannedError: () => false,
        isQuotaExhaustedError: () => false
      });

      expect(result.errorType).toBe('api_error');
      expect(result.status).toBe(500);
    });
  });

  describe('Anthropic Version Validation', () => {
    it('should accept valid versions', async () => {
      const { validateAnthropicVersion } = await import('../validators/request-validator.js');

      expect(validateAnthropicVersion('2023-06-01').valid).toBe(true);
      expect(validateAnthropicVersion('2023-01-01').valid).toBe(true);
      expect(validateAnthropicVersion('2024-01-01').valid).toBe(true);
    });

    it('should use default version when not provided', async () => {
      const { validateAnthropicVersion } = await import('../validators/request-validator.js');

      const result = validateAnthropicVersion(null);
      expect(result.valid).toBe(true);
      expect(result.version).toBe('2023-06-01');
    });

    it('should reject invalid versions', async () => {
      const { validateAnthropicVersion } = await import('../validators/request-validator.js');

      const result = validateAnthropicVersion('2020-01-01');
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });
});
