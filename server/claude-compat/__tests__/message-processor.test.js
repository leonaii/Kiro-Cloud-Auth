/**
 * Message Processor Unit Tests
 */

import {
  getContentText,
  ensureContentArray,
  preprocessMessages,
  mergeAdjacentMessages,
  processUserContentBlocks,
  processAssistantContentBlocks,
  buildAssistantContentWithThinking,
  truncateText,
  addImagePlaceholder
} from '../builders/message-processor.js';

describe('Message Processor', () => {
  describe('getContentText', () => {
    it('should return empty string for null/undefined', () => {
      expect(getContentText(null)).toBe('');
      expect(getContentText(undefined)).toBe('');
    });

    it('should return string content as-is', () => {
      expect(getContentText('Hello world')).toBe('Hello world');
    });

    it('should extract text from content blocks array', () => {
      const content = [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' }
      ];
      expect(getContentText(content)).toBe('Hello world');
    });

    it('should ignore non-text blocks', () => {
      const content = [
        { type: 'text', text: 'Hello' },
        { type: 'image', source: { data: 'base64...' } },
        { type: 'text', text: ' world' }
      ];
      expect(getContentText(content)).toBe('Hello world');
    });

    it('should handle empty array', () => {
      expect(getContentText([])).toBe('');
    });
  });

  describe('ensureContentArray', () => {
    it('should return empty array for null/undefined', () => {
      expect(ensureContentArray(null)).toEqual([]);
      expect(ensureContentArray(undefined)).toEqual([]);
    });

    it('should return array as-is', () => {
      const arr = [{ type: 'text', text: 'Hello' }];
      expect(ensureContentArray(arr)).toEqual(arr);
    });

    it('should convert string to text block array', () => {
      expect(ensureContentArray('Hello')).toEqual([
        { type: 'text', text: 'Hello' }
      ]);
    });

    it('should return empty array for empty string', () => {
      expect(ensureContentArray('')).toEqual([]);
    });
  });

  describe('preprocessMessages', () => {
    it('should separate system messages', () => {
      const messages = [
        { role: 'system', content: 'You are helpful' },
        { role: 'user', content: 'Hello' }
      ];
      const result = preprocessMessages(messages);

      expect(result.systemPrompt).toBe('You are helpful');
      expect(result.processedMessages).toHaveLength(1);
      expect(result.processedMessages[0].role).toBe('user');
    });

    it('should combine top-level system with message system', () => {
      const messages = [
        { role: 'system', content: 'Be concise' },
        { role: 'user', content: 'Hello' }
      ];
      const result = preprocessMessages(messages, 'You are helpful');

      expect(result.systemPrompt).toBe('You are helpful\nBe concise');
    });

    it('should convert tool messages to user messages with tool_result', () => {
      const messages = [
        { role: 'user', content: 'Use the tool' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: 'test', input: {} }] },
        { role: 'tool', tool_use_id: 'tool_1', content: 'Tool result' }
      ];
      const result = preprocessMessages(messages);

      expect(result.processedMessages).toHaveLength(3);
      expect(result.processedMessages[2].role).toBe('user');
      expect(result.processedMessages[2].content[0].type).toBe('tool_result');
      expect(result.processedMessages[2].content[0].tool_use_id).toBe('tool_1');
    });
  });

  describe('mergeAdjacentMessages', () => {
    it('should merge adjacent user messages', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'user', content: 'World' }
      ];
      const result = mergeAdjacentMessages(messages);

      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
      expect(result[0].content).toHaveLength(2);
    });

    it('should not merge different roles', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' },
        { role: 'user', content: 'How are you?' }
      ];
      const result = mergeAdjacentMessages(messages);

      expect(result).toHaveLength(3);
    });

    it('should handle empty array', () => {
      expect(mergeAdjacentMessages([])).toEqual([]);
    });
  });

  describe('processUserContentBlocks', () => {
    it('should extract text content', () => {
      const blocks = [
        { type: 'text', text: 'Hello' },
        { type: 'text', text: ' world' }
      ];
      const result = processUserContentBlocks(blocks);

      expect(result.textContent).toBe('Hello world');
      expect(result.toolResults).toHaveLength(0);
      expect(result.images).toHaveLength(0);
    });

    it('should extract tool results', () => {
      const blocks = [
        { type: 'tool_result', tool_use_id: 'tool_1', content: 'Result' }
      ];
      const result = processUserContentBlocks(blocks);

      expect(result.toolResults).toHaveLength(1);
      expect(result.toolResults[0].toolUseId).toBe('tool_1');
      expect(result.toolResults[0].content[0].text).toBe('Result');
    });

    it('should extract images when shouldKeepImages is true', () => {
      const blocks = [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } }
      ];
      const result = processUserContentBlocks(blocks, true);

      expect(result.images).toHaveLength(1);
      expect(result.images[0].format).toBe('png');
      expect(result.imageCount).toBe(0);
    });

    it('should count images when shouldKeepImages is false', () => {
      const blocks = [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } }
      ];
      const result = processUserContentBlocks(blocks, false);

      expect(result.images).toHaveLength(0);
      expect(result.imageCount).toBe(1);
    });

    it('should handle string content', () => {
      const result = processUserContentBlocks('Hello world');

      expect(result.textContent).toBe('Hello world');
    });
  });

  describe('processAssistantContentBlocks', () => {
    it('should extract text content', () => {
      const blocks = [
        { type: 'text', text: 'Hello' }
      ];
      const result = processAssistantContentBlocks(blocks);

      expect(result.textContent).toBe('Hello');
    });

    it('should extract thinking content', () => {
      const blocks = [
        { type: 'thinking', thinking: 'Let me think...' },
        { type: 'text', text: 'Answer' }
      ];
      const result = processAssistantContentBlocks(blocks);

      expect(result.thinkingContent).toBe('Let me think...');
      expect(result.textContent).toBe('Answer');
    });

    it('should extract tool uses', () => {
      const blocks = [
        { type: 'tool_use', id: 'tool_1', name: 'search', input: { query: 'test' } }
      ];
      const result = processAssistantContentBlocks(blocks);

      expect(result.toolUses).toHaveLength(1);
      expect(result.toolUses[0].toolUseId).toBe('tool_1');
      expect(result.toolUses[0].name).toBe('search');
    });
  });

  describe('buildAssistantContentWithThinking', () => {
    it('should return text only when no thinking', () => {
      expect(buildAssistantContentWithThinking('Hello', '')).toBe('Hello');
      expect(buildAssistantContentWithThinking('Hello', null)).toBe('Hello');
    });

    it('should wrap thinking in tags', () => {
      const result = buildAssistantContentWithThinking('Answer', 'Thinking...');
      expect(result).toBe('<thinking>Thinking...</thinking>\n\nAnswer');
    });

    it('should return only thinking when no text', () => {
      const result = buildAssistantContentWithThinking('', 'Thinking...');
      expect(result).toBe('<thinking>Thinking...</thinking>');
    });
  });

  describe('truncateText', () => {
    it('should not truncate short text', () => {
      expect(truncateText('Hello', 100)).toBe('Hello');
    });

    it('should truncate long text', () => {
      const longText = 'a'.repeat(100);
      const result = truncateText(longText, 50);

      expect(result.length).toBeLessThan(100);
      expect(result).toContain('[... content truncated');
    });

    it('should handle null/undefined', () => {
      expect(truncateText(null)).toBe(null);
      expect(truncateText(undefined)).toBe(undefined);
    });
  });

  describe('addImagePlaceholder', () => {
    it('should not add placeholder when imageCount is 0', () => {
      expect(addImagePlaceholder('Hello', 0)).toBe('Hello');
    });

    it('should add placeholder with count', () => {
      const result = addImagePlaceholder('Hello', 2);
      expect(result).toContain('Hello');
      expect(result).toContain('2 image(s)');
    });

    it('should handle empty content', () => {
      const result = addImagePlaceholder('', 1);
      expect(result).toContain('1 image(s)');
    });
  });
});
