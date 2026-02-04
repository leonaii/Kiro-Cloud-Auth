/**
 * SSE Writer
 *
 * Encapsulates Claude SSE event building and writing.
 * Provides a clean API for streaming responses.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  SSE_EVENTS,
  CONTENT_BLOCK_TYPES,
  DELTA_TYPES,
  STOP_REASONS
} from '../constants.js';

/**
 * SSE Writer class for Claude streaming responses
 */
export class SSEWriter {
  constructor(res, model = 'claude-sonnet-4-5') {
    this.res = res;
    this.model = model;
    this.messageId = `msg_${uuidv4().replace(/-/g, '').substring(0, 24)}`;
    this.contentBlockIndex = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.closed = false;
  }

  /**
   * Write raw SSE event
   * @param {string} eventType - Event type
   * @param {Object} data - Event data
   */
  writeEvent(eventType, data) {
    if (this.closed) return;

    try {
      const eventStr = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
      this.res.write(eventStr);
    } catch (err) {
      // Connection may be closed
      this.closed = true;
    }
  }

  /**
   * Write message_start event
   * @param {number} inputTokens - Input token count
   */
  writeMessageStart(inputTokens = 0) {
    this.inputTokens = inputTokens;

    this.writeEvent(SSE_EVENTS.MESSAGE_START, {
      type: SSE_EVENTS.MESSAGE_START,
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: inputTokens,
          output_tokens: 0
        }
      }
    });
  }

  /**
   * Write content_block_start event for text
   * @param {number} index - Block index (optional, auto-increments if not provided)
   * @returns {number} The block index used
   */
  writeTextBlockStart(index = null) {
    const blockIndex = index !== null ? index : this.contentBlockIndex++;

    this.writeEvent(SSE_EVENTS.CONTENT_BLOCK_START, {
      type: SSE_EVENTS.CONTENT_BLOCK_START,
      index: blockIndex,
      content_block: {
        type: CONTENT_BLOCK_TYPES.TEXT,
        text: ''
      }
    });

    return blockIndex;
  }

  /**
   * Write content_block_start event for thinking
   * @param {number} index - Block index (optional)
   * @returns {number} The block index used
   */
  writeThinkingBlockStart(index = null) {
    const blockIndex = index !== null ? index : this.contentBlockIndex++;

    this.writeEvent(SSE_EVENTS.CONTENT_BLOCK_START, {
      type: SSE_EVENTS.CONTENT_BLOCK_START,
      index: blockIndex,
      content_block: {
        type: CONTENT_BLOCK_TYPES.THINKING,
        thinking: ''
      }
    });

    return blockIndex;
  }

  /**
   * Write content_block_start event for tool_use
   * @param {string} toolUseId - Tool use ID
   * @param {string} toolName - Tool name
   * @param {number} index - Block index (optional)
   * @returns {number} The block index used
   */
  writeToolUseBlockStart(toolUseId, toolName, index = null) {
    const blockIndex = index !== null ? index : this.contentBlockIndex++;

    this.writeEvent(SSE_EVENTS.CONTENT_BLOCK_START, {
      type: SSE_EVENTS.CONTENT_BLOCK_START,
      index: blockIndex,
      content_block: {
        type: CONTENT_BLOCK_TYPES.TOOL_USE,
        id: toolUseId,
        name: toolName,
        input: {}
      }
    });

    return blockIndex;
  }

  /**
   * Write content_block_delta event for text
   * @param {number} index - Block index
   * @param {string} text - Text delta
   */
  writeTextDelta(index, text) {
    if (!text) return;

    this.writeEvent(SSE_EVENTS.CONTENT_BLOCK_DELTA, {
      type: SSE_EVENTS.CONTENT_BLOCK_DELTA,
      index: index,
      delta: {
        type: DELTA_TYPES.TEXT_DELTA,
        text: text
      }
    });
  }

  /**
   * Write content_block_delta event for thinking
   * @param {number} index - Block index
   * @param {string} thinking - Thinking delta
   */
  writeThinkingDelta(index, thinking) {
    if (!thinking) return;

    this.writeEvent(SSE_EVENTS.CONTENT_BLOCK_DELTA, {
      type: SSE_EVENTS.CONTENT_BLOCK_DELTA,
      index: index,
      delta: {
        type: DELTA_TYPES.THINKING_DELTA,
        thinking: thinking
      }
    });
  }

  /**
   * Write content_block_delta event for tool input JSON
   * @param {number} index - Block index
   * @param {string} partialJson - Partial JSON string
   */
  writeToolInputDelta(index, partialJson) {
    if (!partialJson) return;

    this.writeEvent(SSE_EVENTS.CONTENT_BLOCK_DELTA, {
      type: SSE_EVENTS.CONTENT_BLOCK_DELTA,
      index: index,
      delta: {
        type: DELTA_TYPES.INPUT_JSON_DELTA,
        partial_json: partialJson
      }
    });
  }

  /**
   * Write content_block_stop event
   * @param {number} index - Block index
   */
  writeContentBlockStop(index) {
    this.writeEvent(SSE_EVENTS.CONTENT_BLOCK_STOP, {
      type: SSE_EVENTS.CONTENT_BLOCK_STOP,
      index: index
    });
  }

  /**
   * Write message_delta event
   * @param {string} stopReason - Stop reason
   * @param {number} outputTokens - Output token count
   */
  writeMessageDelta(stopReason = STOP_REASONS.END_TURN, outputTokens = 0) {
    this.outputTokens = outputTokens;

    this.writeEvent(SSE_EVENTS.MESSAGE_DELTA, {
      type: SSE_EVENTS.MESSAGE_DELTA,
      delta: {
        stop_reason: stopReason,
        stop_sequence: null
      },
      usage: {
        output_tokens: outputTokens
      }
    });
  }

  /**
   * Write message_stop event
   */
  writeMessageStop() {
    this.writeEvent(SSE_EVENTS.MESSAGE_STOP, {
      type: SSE_EVENTS.MESSAGE_STOP
    });
  }

  /**
   * Write ping event
   */
  writePing() {
    this.writeEvent(SSE_EVENTS.PING, {
      type: SSE_EVENTS.PING
    });
  }

  /**
   * Write error event
   * @param {string} errorType - Error type
   * @param {string} message - Error message
   */
  writeError(errorType, message) {
    this.writeEvent(SSE_EVENTS.ERROR, {
      type: SSE_EVENTS.ERROR,
      error: {
        type: errorType,
        message: message
      }
    });
  }

  /**
   * Write a complete tool use block (start + input + stop)
   * @param {string} toolUseId - Tool use ID
   * @param {string} toolName - Tool name
   * @param {Object} input - Tool input object
   * @returns {number} The block index used
   */
  writeCompleteToolUse(toolUseId, toolName, input) {
    const index = this.writeToolUseBlockStart(toolUseId, toolName);
    const inputJson = JSON.stringify(input || {});
    this.writeToolInputDelta(index, inputJson);
    this.writeContentBlockStop(index);
    return index;
  }

  /**
   * End the stream properly
   * @param {string} stopReason - Stop reason
   * @param {number} outputTokens - Output token count
   */
  end(stopReason = STOP_REASONS.END_TURN, outputTokens = 0) {
    if (this.closed) return;

    this.writeMessageDelta(stopReason, outputTokens);
    this.writeMessageStop();
    this.closed = true;

    try {
      this.res.end();
    } catch (err) {
      // Ignore
    }
  }

  /**
   * Check if writer is closed
   * @returns {boolean}
   */
  isClosed() {
    return this.closed;
  }

  /**
   * Get current content block index
   * @returns {number}
   */
  getCurrentIndex() {
    return this.contentBlockIndex;
  }

  /**
   * Set model name
   * @param {string} model - Model name
   */
  setModel(model) {
    this.model = model;
  }
}

/**
 * Build SSE event string (standalone function for compatibility)
 * @param {string} eventType - Event type
 * @param {Object} data - Event data
 * @returns {string} SSE event string
 */
export function buildSSEEvent(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Setup SSE response headers
 * @param {Object} res - Express response object
 */
export function setupSSEHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

export default SSEWriter;
