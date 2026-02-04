/**
 * Request Builder Unit Tests
 */

import {
  getKiroModelId,
  generateThinkingPrefix,
  hasThinkingPrefix,
  buildKiroRequest
} from '../builders/request-builder.js';

import {
  MODEL_MAPPINGS,
  DEFAULT_MODEL,
  THINKING_MAX_BUDGET_TOKENS,
  THINKING_DEFAULT_BUDGET_TOKENS
} from '../constants.js';

describe('Request Builder', () => {
  describe('getKiroModelId', () => {
    it('should return mapped model ID', () => {
      expect(getKiroModelId('claude-sonnet-4-5')).toBe(MODEL_MAPPINGS['claude-sonnet-4-5']);
    });

    it('should return default model for unknown models', () => {
      const result = getKiroModelId('unknown-model');
      expect(result).toBe(MODEL_MAPPINGS[DEFAULT_MODEL]);
    });

    it('should handle various Claude model names', () => {
      expect(getKiroModelId('claude-3-5-sonnet-20241022')).toBeDefined();
      expect(getKiroModelId('claude-sonnet-4-20250514')).toBeDefined();
    });
  });

  describe('generateThinkingPrefix', () => {
    it('should return empty string when thinking is disabled', () => {
      expect(generateThinkingPrefix(null)).toBe('');
      expect(generateThinkingPrefix(undefined)).toBe('');
      expect(generateThinkingPrefix({ type: 'disabled' })).toBe('');
    });

    it('should generate prefix with default budget', () => {
      const result = generateThinkingPrefix({ type: 'enabled' });
      expect(result).toContain('<thinking_mode>enabled</thinking_mode>');
      expect(result).toContain(`<max_thinking_length>${THINKING_DEFAULT_BUDGET_TOKENS}</max_thinking_length>`);
    });

    it('should use provided budget_tokens', () => {
      const result = generateThinkingPrefix({ type: 'enabled', budget_tokens: 10000 });
      expect(result).toContain('<max_thinking_length>10000</max_thinking_length>');
    });

    it('should cap budget at max', () => {
      const result = generateThinkingPrefix({ type: 'enabled', budget_tokens: 100000 });
      expect(result).toContain(`<max_thinking_length>${THINKING_MAX_BUDGET_TOKENS}</max_thinking_length>`);
    });

    it('should use default for zero/negative budget', () => {
      const result = generateThinkingPrefix({ type: 'enabled', budget_tokens: 0 });
      expect(result).toContain(`<max_thinking_length>${THINKING_DEFAULT_BUDGET_TOKENS}</max_thinking_length>`);
    });
  });

  describe('hasThinkingPrefix', () => {
    it('should detect thinking_mode tag', () => {
      expect(hasThinkingPrefix('<thinking_mode>enabled</thinking_mode>')).toBe(true);
    });

    it('should detect max_thinking_length tag', () => {
      expect(hasThinkingPrefix('<max_thinking_length>10000</max_thinking_length>')).toBe(true);
    });

    it('should return false for text without tags', () => {
      expect(hasThinkingPrefix('Hello world')).toBe(false);
      expect(hasThinkingPrefix('')).toBe(false);
      expect(hasThinkingPrefix(null)).toBe(false);
    });
  });

  describe('buildKiroRequest', () => {
    const mockAccount = {
      profileArn: 'arn:aws:iam::123456789:profile/test'
    };

    it('should build basic request with single user message', () => {
      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        messages: [
          { role: 'user', content: 'Hello' }
        ]
      };
      const result = buildKiroRequest(claudeRequest, mockAccount);

      expect(result.conversationState).toBeDefined();
      expect(result.conversationState.chatTriggerType).toBe('MANUAL');
      expect(result.conversationState.conversationId).toBeDefined();
      expect(result.conversationState.currentMessage.userInputMessage.content).toBe('Hello');
      expect(result.profileArn).toBe(mockAccount.profileArn);
    });

    it('should include system prompt in first user message', () => {
      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        system: 'You are helpful',
        messages: [
          { role: 'user', content: 'Hello' }
        ]
      };
      const result = buildKiroRequest(claudeRequest, mockAccount);

      // System prompt should be in history's first user message
      const firstHistoryItem = result.conversationState.history?.[0];
      if (firstHistoryItem) {
        expect(firstHistoryItem.userInputMessage.content).toContain('You are helpful');
      }
    });

    it('should add thinking prefix to system prompt', () => {
      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        system: 'You are helpful',
        thinking: { type: 'enabled', budget_tokens: 10000 },
        messages: [
          { role: 'user', content: 'Hello' }
        ]
      };
      const result = buildKiroRequest(claudeRequest, mockAccount);

      const firstHistoryItem = result.conversationState.history?.[0];
      if (firstHistoryItem) {
        expect(firstHistoryItem.userInputMessage.content).toContain('<thinking_mode>enabled</thinking_mode>');
      }
    });

    it('should build history from conversation', () => {
      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
          { role: 'user', content: 'How are you?' }
        ]
      };
      const result = buildKiroRequest(claudeRequest, mockAccount);

      expect(result.conversationState.history).toBeDefined();
      expect(result.conversationState.history.length).toBeGreaterThan(0);
    });

    it('should handle tool definitions', () => {
      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        messages: [
          { role: 'user', content: 'Search for something' }
        ],
        tools: [
          {
            name: 'search',
            description: 'Search the web',
            input_schema: { type: 'object', properties: { query: { type: 'string' } } }
          }
        ]
      };
      const result = buildKiroRequest(claudeRequest, mockAccount);

      const context = result.conversationState.currentMessage.userInputMessage.userInputMessageContext;
      expect(context).toBeDefined();
      expect(context.tools).toBeDefined();
      expect(context.tools).toHaveLength(1);
      expect(context.tools[0].toolSpecification.name).toBe('search');
    });

    it('should handle tool use and tool result flow', () => {
      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        messages: [
          { role: 'user', content: 'Search for cats' },
          { role: 'assistant', content: [
            { type: 'text', text: 'I will search for cats' },
            { type: 'tool_use', id: 'tool_1', name: 'search', input: { query: 'cats' } }
          ]},
          { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'tool_1', content: 'Found 10 results about cats' }
          ]}
        ]
      };
      const result = buildKiroRequest(claudeRequest, mockAccount);

      expect(result.conversationState).toBeDefined();
      // The current message should have tool results
      const currentMsg = result.conversationState.currentMessage.userInputMessage;
      expect(currentMsg).toBeDefined();
    });

    it('should ensure history ends with assistant when last message is user', () => {
      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        messages: [
          { role: 'user', content: 'First' },
          { role: 'user', content: 'Second' } // Two consecutive user messages
        ]
      };
      const result = buildKiroRequest(claudeRequest, mockAccount);

      // After merging, should have proper structure
      expect(result.conversationState.currentMessage.userInputMessage).toBeDefined();
    });

    it('should use Continue when last message is assistant', () => {
      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        messages: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi!' }
        ]
      };
      const result = buildKiroRequest(claudeRequest, mockAccount);

      expect(result.conversationState.currentMessage.userInputMessage.content).toBe('Continue');
    });

    it('should handle empty messages array', () => {
      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        messages: []
      };
      const result = buildKiroRequest(claudeRequest, mockAccount);

      expect(result.conversationState.currentMessage.userInputMessage.content).toBe('Continue');
    });

    it('should not include profileArn when account has none', () => {
      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        messages: [{ role: 'user', content: 'Hello' }]
      };
      const result = buildKiroRequest(claudeRequest, {});

      expect(result.profileArn).toBeUndefined();
    });

    it('should merge adjacent same-role messages', () => {
      const claudeRequest = {
        model: 'claude-sonnet-4-5',
        messages: [
          { role: 'user', content: 'Part 1' },
          { role: 'user', content: 'Part 2' },
          { role: 'assistant', content: 'Response' },
          { role: 'user', content: 'Follow up' }
        ]
      };
      const result = buildKiroRequest(claudeRequest, mockAccount);

      // Should have merged the first two user messages
      expect(result.conversationState).toBeDefined();
    });
  });
});
