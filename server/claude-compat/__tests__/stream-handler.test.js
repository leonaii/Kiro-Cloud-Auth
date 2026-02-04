/**
 * Stream Handler Unit Tests
 */

import { jest } from '@jest/globals';
import {
  processStreamEvent,
  StreamState
} from '../handlers/stream-handler.js';
import { SSEWriter } from '../response/sse-writer.js';

// Mock response object
const createMockResponse = () => ({
  write: jest.fn(),
  end: jest.fn(),
  setHeader: jest.fn(),
  flushHeaders: jest.fn(),
  writableEnded: false
});

describe('Stream Handler', () => {
  describe('StreamState', () => {
    it('should initialize with default values', () => {
      const state = new StreamState();

      expect(state.fullContent).toBe('');
      expect(state.thinkingContent).toBe('');
      expect(state.thinkingBlockIndex).toBe(-1);
      expect(state.textBlockIndex).toBe(-1);
      expect(state.thinkingBlockStarted).toBe(false);
      expect(state.textBlockStarted).toBe(false);
      expect(state.toolCalls).toEqual([]);
      expect(state.stopReason).toBe('end_turn');
      expect(state.timeToFirstByte).toBe(null);
    });

    it('should record first byte time only once', () => {
      const state = new StreamState();

      state.recordFirstByte();
      const firstTime = state.timeToFirstByte;

      // Wait a bit and try again
      state.recordFirstByte();

      expect(state.timeToFirstByte).toBe(firstTime);
    });

    it('should calculate output tokens', () => {
      const state = new StreamState();
      state.fullContent = 'Hello world';
      state.thinkingContent = 'Let me think';

      const tokens = state.getOutputTokens();
      expect(tokens).toBeGreaterThan(0);
    });
  });

  describe('processStreamEvent', () => {
    let mockRes;
    let writer;
    let state;

    beforeEach(() => {
      mockRes = createMockResponse();
      writer = new SSEWriter(mockRes, 'claude-sonnet-4-5');
      state = new StreamState();
    });

    it('should handle thinking_start event', () => {
      const event = { type: 'thinking_start' };

      processStreamEvent(event, writer, state, {});

      expect(state.thinkingBlockStarted).toBe(true);
      expect(state.thinkingBlockIndex).toBeGreaterThanOrEqual(0);
      expect(mockRes.write).toHaveBeenCalled();
    });

    it('should handle thinking event', () => {
      // First start thinking block
      processStreamEvent({ type: 'thinking_start' }, writer, state, {});

      // Then send thinking content
      const event = { type: 'thinking', thinking: 'Let me think...' };
      processStreamEvent(event, writer, state, {});

      expect(state.thinkingContent).toBe('Let me think...');
    });

    it('should handle thinking_end event', () => {
      // Start thinking block
      processStreamEvent({ type: 'thinking_start' }, writer, state, {});
      state.thinkingBlockStarted = true;

      // End thinking block
      processStreamEvent({ type: 'thinking_end' }, writer, state, {});

      expect(state.thinkingBlockStarted).toBe(false);
    });

    it('should handle content event', () => {
      const event = { type: 'content', content: 'Hello' };

      processStreamEvent(event, writer, state, {});

      expect(state.textBlockStarted).toBe(true);
      expect(state.fullContent).toBe('Hello');
    });

    it('should accumulate content', () => {
      processStreamEvent({ type: 'content', content: 'Hello ' }, writer, state, {});
      processStreamEvent({ type: 'content', content: 'world' }, writer, state, {});

      expect(state.fullContent).toBe('Hello world');
    });

    it('should handle tool_use event', () => {
      const event = {
        type: 'tool_use',
        id: 'tool_1',
        name: 'search',
        input: { query: 'test' }
      };

      processStreamEvent(event, writer, state, {});

      expect(state.toolCalls).toHaveLength(1);
      expect(state.toolCalls[0].id).toBe('tool_1');
      expect(state.toolCalls[0].name).toBe('search');
      expect(state.stopReason).toBe('tool_use');
    });

    it('should close text block before tool_use', () => {
      // Start text block
      processStreamEvent({ type: 'content', content: 'Text' }, writer, state, {});
      expect(state.textBlockStarted).toBe(true);

      // Tool use should close text block
      processStreamEvent({
        type: 'tool_use',
        id: 'tool_1',
        name: 'search',
        input: {}
      }, writer, state, {});

      expect(state.textBlockStarted).toBe(false);
    });

    it('should handle token_refreshed event with callback', () => {
      const onTokenRefresh = jest.fn();
      const newTokens = { accessToken: 'new_token', refreshToken: 'new_refresh' };

      processStreamEvent(
        { type: 'token_refreshed', newTokens },
        writer,
        state,
        { onTokenRefresh }
      );

      expect(onTokenRefresh).toHaveBeenCalledWith(newTokens);
    });

    it('should not process events when writer is closed', () => {
      writer.closed = true;

      processStreamEvent({ type: 'content', content: 'Hello' }, writer, state, {});

      expect(state.fullContent).toBe('');
    });

    it('should record first byte on content events', () => {
      expect(state.timeToFirstByte).toBe(null);

      processStreamEvent({ type: 'content', content: 'Hello' }, writer, state, {});

      expect(state.timeToFirstByte).not.toBe(null);
    });
  });

  describe('SSEWriter', () => {
    let mockRes;
    let writer;

    beforeEach(() => {
      mockRes = createMockResponse();
      writer = new SSEWriter(mockRes, 'claude-sonnet-4-5');
    });

    it('should write message_start event', () => {
      writer.writeMessageStart(100);

      expect(mockRes.write).toHaveBeenCalled();
      const call = mockRes.write.mock.calls[0][0];
      expect(call).toContain('event: message_start');
      expect(call).toContain('"input_tokens":100');
    });

    it('should write text block start', () => {
      const index = writer.writeTextBlockStart();

      expect(index).toBe(0);
      expect(mockRes.write).toHaveBeenCalled();
      const call = mockRes.write.mock.calls[0][0];
      expect(call).toContain('content_block_start');
      expect(call).toContain('"type":"text"');
    });

    it('should write thinking block start', () => {
      const index = writer.writeThinkingBlockStart();

      expect(index).toBe(0);
      const call = mockRes.write.mock.calls[0][0];
      expect(call).toContain('"type":"thinking"');
    });

    it('should write tool use block start', () => {
      const index = writer.writeToolUseBlockStart('tool_1', 'search');

      expect(index).toBe(0);
      const call = mockRes.write.mock.calls[0][0];
      expect(call).toContain('"type":"tool_use"');
      expect(call).toContain('"id":"tool_1"');
      expect(call).toContain('"name":"search"');
    });

    it('should write text delta', () => {
      writer.writeTextDelta(0, 'Hello');

      const call = mockRes.write.mock.calls[0][0];
      expect(call).toContain('content_block_delta');
      expect(call).toContain('"type":"text_delta"');
      expect(call).toContain('"text":"Hello"');
    });

    it('should write thinking delta', () => {
      writer.writeThinkingDelta(0, 'Thinking...');

      const call = mockRes.write.mock.calls[0][0];
      expect(call).toContain('"type":"thinking_delta"');
      expect(call).toContain('"thinking":"Thinking..."');
    });

    it('should write content block stop', () => {
      writer.writeContentBlockStop(0);

      const call = mockRes.write.mock.calls[0][0];
      expect(call).toContain('content_block_stop');
      expect(call).toContain('"index":0');
    });

    it('should write message delta', () => {
      writer.writeMessageDelta('end_turn', 50);

      const call = mockRes.write.mock.calls[0][0];
      expect(call).toContain('message_delta');
      expect(call).toContain('"stop_reason":"end_turn"');
      expect(call).toContain('"output_tokens":50');
    });

    it('should write message stop', () => {
      writer.writeMessageStop();

      const call = mockRes.write.mock.calls[0][0];
      expect(call).toContain('message_stop');
    });

    it('should write error event', () => {
      writer.writeError('api_error', 'Something went wrong');

      const call = mockRes.write.mock.calls[0][0];
      expect(call).toContain('event: error');
      expect(call).toContain('"type":"api_error"');
      expect(call).toContain('"message":"Something went wrong"');
    });

    it('should write complete tool use', () => {
      const index = writer.writeCompleteToolUse('tool_1', 'search', { query: 'test' });

      expect(index).toBe(0);
      // Should have written start, delta, and stop
      expect(mockRes.write).toHaveBeenCalledTimes(3);
    });

    it('should end stream properly', () => {
      writer.end('end_turn', 100);

      expect(writer.isClosed()).toBe(true);
      expect(mockRes.end).toHaveBeenCalled();
    });

    it('should not write after closed', () => {
      writer.end();
      mockRes.write.mockClear();

      writer.writeTextDelta(0, 'Hello');

      expect(mockRes.write).not.toHaveBeenCalled();
    });

    it('should auto-increment content block index', () => {
      const index1 = writer.writeTextBlockStart();
      const index2 = writer.writeTextBlockStart();
      const index3 = writer.writeThinkingBlockStart();

      expect(index1).toBe(0);
      expect(index2).toBe(1);
      expect(index3).toBe(2);
    });
  });
});
