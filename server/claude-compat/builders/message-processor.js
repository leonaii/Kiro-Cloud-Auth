/**
 * Message Processor
 *
 * Handles Claude message preprocessing, merging, and content extraction.
 * Reference: kiro2api/backend/internal/logic/kiro/kiro_relay.go
 */

import {
  CONTENT_BLOCK_TYPES,
  THINKING_START_TAG,
  THINKING_END_TAG,
  MAX_ASSISTANT_CONTENT_LENGTH
} from '../constants.js';

/**
 * Extract text content from message content (handles string or array types)
 * @param {string|Array|null} content - Message content
 * @returns {string} Extracted text
 */
export function getContentText(content) {
  if (content == null) {
    return '';
  }

  // If string type
  if (typeof content === 'string') {
    return content;
  }

  // If array type
  if (Array.isArray(content)) {
    const result = [];
    for (const item of content) {
      if (item && typeof item === 'object') {
        const blockType = item.type;
        if (blockType === CONTENT_BLOCK_TYPES.TEXT && item.text) {
          result.push(item.text);
        }
      }
    }
    return result.join('');
  }

  return '';
}

/**
 * Ensure content is in array format for merging
 * @param {string|Array|null} content - Message content
 * @returns {Array} Content as array
 */
export function ensureContentArray(content) {
  if (content == null) {
    return [];
  }

  // Already array type
  if (Array.isArray(content)) {
    return content;
  }

  // String type - convert to text block array
  if (typeof content === 'string') {
    if (content === '') {
      return [];
    }
    return [{
      type: CONTENT_BLOCK_TYPES.TEXT,
      text: content
    }];
  }

  return [];
}

/**
 * Preprocess messages - separate system messages and convert tool messages
 * @param {Array} messages - Original messages array
 * @param {string|Array|null} topLevelSystem - Top-level system prompt
 * @returns {{systemPrompt: string, processedMessages: Array}}
 */
export function preprocessMessages(messages, topLevelSystem = null) {
  let systemPrompt = '';

  // Handle top-level system prompt
  if (topLevelSystem != null) {
    systemPrompt = getContentText(topLevelSystem);
  }

  const processedMessages = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      // System message content added to systemPrompt
      const msgContent = getContentText(msg.content);
      if (systemPrompt !== '') {
        systemPrompt += '\n';
      }
      systemPrompt += msgContent;
    } else if (msg.role === 'tool') {
      // Convert tool message to user message with tool_result
      const toolResultBlock = {
        type: CONTENT_BLOCK_TYPES.TOOL_RESULT,
        tool_use_id: msg.tool_call_id || msg.tool_use_id,
        content: msg.content
      };
      processedMessages.push({
        role: 'user',
        content: [toolResultBlock]
      });
    } else {
      processedMessages.push({ ...msg });
    }
  }

  return { systemPrompt, processedMessages };
}

/**
 * Merge adjacent messages with the same role
 * @param {Array} messages - Messages array
 * @returns {Array} Merged messages
 */
export function mergeAdjacentMessages(messages) {
  if (!messages || messages.length === 0) {
    return [];
  }

  const mergedMessages = [];

  for (const currentMsg of messages) {
    if (mergedMessages.length === 0) {
      mergedMessages.push({
        role: currentMsg.role,
        content: ensureContentArray(currentMsg.content)
      });
    } else {
      const lastMsg = mergedMessages[mergedMessages.length - 1];
      if (currentMsg.role === lastMsg.role) {
        // Merge message content
        const currentContent = ensureContentArray(currentMsg.content);
        lastMsg.content = [...lastMsg.content, ...currentContent];
      } else {
        mergedMessages.push({
          role: currentMsg.role,
          content: ensureContentArray(currentMsg.content)
        });
      }
    }
  }

  return mergedMessages;
}

/**
 * Process user message content blocks
 * @param {Array} contentBlocks - Content blocks array
 * @param {boolean} shouldKeepImages - Whether to keep images
 * @returns {{textContent: string, toolResults: Array, images: Array, imageCount: number}}
 */
export function processUserContentBlocks(contentBlocks, shouldKeepImages = true) {
  const textParts = [];
  const toolResults = [];
  const images = [];
  let imageCount = 0;

  if (!Array.isArray(contentBlocks)) {
    return {
      textContent: getContentText(contentBlocks),
      toolResults: [],
      images: [],
      imageCount: 0
    };
  }

  for (const block of contentBlocks) {
    if (!block || typeof block !== 'object') continue;

    const blockType = block.type;

    switch (blockType) {
      case CONTENT_BLOCK_TYPES.TEXT:
        if (block.text) {
          textParts.push(block.text);
        }
        break;

      case CONTENT_BLOCK_TYPES.TOOL_RESULT:
        const toolUseId = block.tool_use_id;
        const resultContent = getContentText(block.content);
        toolResults.push({
          content: [{ text: resultContent }],
          status: block.is_error ? 'error' : 'success',
          toolUseId: toolUseId
        });
        break;

      case CONTENT_BLOCK_TYPES.IMAGE:
        if (shouldKeepImages) {
          if (block.source && block.source.type === 'base64') {
            const mediaType = block.source.media_type || 'image/png';
            const format = mediaType.replace('image/', '');
            images.push({
              format: format,
              source: { bytes: block.source.data }
            });
          }
        } else {
          imageCount++;
        }
        break;
    }
  }

  return {
    textContent: textParts.join(''),
    toolResults,
    images,
    imageCount
  };
}

/**
 * Process assistant message content blocks
 * @param {Array} contentBlocks - Content blocks array
 * @returns {{textContent: string, thinkingContent: string, toolUses: Array}}
 */
export function processAssistantContentBlocks(contentBlocks) {
  const textParts = [];
  const thinkingParts = [];
  const toolUses = [];

  if (!Array.isArray(contentBlocks)) {
    return {
      textContent: getContentText(contentBlocks),
      thinkingContent: '',
      toolUses: []
    };
  }

  for (const block of contentBlocks) {
    if (!block || typeof block !== 'object') continue;

    const blockType = block.type;

    switch (blockType) {
      case CONTENT_BLOCK_TYPES.TEXT:
        if (block.text) {
          textParts.push(block.text);
        }
        break;

      case CONTENT_BLOCK_TYPES.THINKING:
        if (block.thinking) {
          thinkingParts.push(block.thinking);
        } else if (block.text) {
          thinkingParts.push(block.text);
        }
        break;

      case CONTENT_BLOCK_TYPES.TOOL_USE:
        toolUses.push({
          input: block.input,
          name: block.name,
          toolUseId: block.id
        });
        break;
    }
  }

  return {
    textContent: textParts.join(''),
    thinkingContent: thinkingParts.join(''),
    toolUses
  };
}

/**
 * Build assistant content with thinking tags
 * @param {string} textContent - Text content
 * @param {string} thinkingContent - Thinking content
 * @returns {string} Combined content with thinking tags
 */
export function buildAssistantContentWithThinking(textContent, thinkingContent) {
  if (!thinkingContent) {
    return textContent;
  }

  const thinkingWrapped = `${THINKING_START_TAG}${thinkingContent}${THINKING_END_TAG}`;

  if (textContent) {
    return `${thinkingWrapped}\n\n${textContent}`;
  }

  return thinkingWrapped;
}

/**
 * Truncate text to specified length
 * @param {string} text - Text to truncate
 * @param {number} maxLen - Maximum length
 * @returns {string} Truncated text
 */
export function truncateText(text, maxLen = MAX_ASSISTANT_CONTENT_LENGTH) {
  if (!text || text.length <= maxLen) {
    return text;
  }
  return text.substring(0, maxLen) + '\n\n[... content truncated due to length ...]';
}

/**
 * Add image placeholder to content
 * @param {string} content - Original content
 * @param {number} imageCount - Number of omitted images
 * @returns {string} Content with placeholder
 */
export function addImagePlaceholder(content, imageCount) {
  if (imageCount <= 0) {
    return content;
  }

  const placeholder = `[This message contains ${imageCount} image(s), omitted from history]`;

  if (content) {
    return `${content}\n${placeholder}`;
  }

  return placeholder;
}
