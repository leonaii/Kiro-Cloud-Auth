/**
 * Tool Processor
 *
 * Handles tool conversion, tool result matching, and tool name/description processing.
 * Reference: kiro2api/backend/internal/logic/kiro/kiro_relay.go
 */

import {
  MAX_TOOL_NAME_LENGTH,
  MAX_TOOL_DESCRIPTION_LENGTH,
  DEFAULT_TOOL_RESULT_CONTENT
} from '../constants.js';

/**
 * Shorten tool name to fit Kiro's limit (64 characters)
 * @param {string} name - Original tool name
 * @returns {string} Shortened name
 */
export function shortenToolName(name) {
  if (!name) {
    return name;
  }

  if (name.length <= MAX_TOOL_NAME_LENGTH) {
    return name;
  }

  // Truncate and add indicator
  return name.substring(0, MAX_TOOL_NAME_LENGTH - 3) + '...';
}

/**
 * Process tool description to fit Kiro's limit
 * @param {string} description - Original description
 * @returns {string} Processed description
 */
export function processToolDescription(description) {
  if (!description) {
    return description;
  }

  if (description.length <= MAX_TOOL_DESCRIPTION_LENGTH) {
    return description;
  }

  return description.substring(0, MAX_TOOL_DESCRIPTION_LENGTH - 3) + '...';
}

/**
 * Convert Claude tools to Kiro format
 * @param {Array} tools - Claude tool definitions
 * @returns {Array} Kiro tool definitions
 */
export function convertTools(tools) {
  if (!tools || !Array.isArray(tools) || tools.length === 0) {
    return [];
  }

  const kiroTools = [];

  for (const tool of tools) {
    // Filter out web_search tool
    const nameLower = (tool.name || '').toLowerCase();
    if (nameLower === 'web_search' || nameLower === 'websearch') {
      continue;
    }

    const kiroTool = {
      toolSpecification: {
        name: shortenToolName(tool.name),
        description: processToolDescription(tool.description),
        inputSchema: {
          json: tool.input_schema || {}
        }
      }
    };

    kiroTools.push(kiroTool);
  }

  return kiroTools;
}

/**
 * Match and filter tool results against expected tool uses
 * Kiro API requires toolResults to exactly match the previous assistant's toolUses
 *
 * @param {Array} toolResults - Current tool results
 * @param {Array} expectedToolUses - Expected tool uses from previous assistant message
 * @returns {Array} Filtered and completed tool results
 */
export function matchToolResults(toolResults, expectedToolUses) {
  if (!expectedToolUses || expectedToolUses.length === 0) {
    // No expected tool uses, clear all tool results
    return [];
  }

  // Build map of expected tool use IDs
  const expectedIds = new Map();
  for (const tu of expectedToolUses) {
    const id = tu.toolUseId || tu.id;
    if (id) {
      expectedIds.set(id, true);
    }
  }

  // Filter tool results to only include those matching expected IDs
  const filteredResults = [];
  const foundIds = new Set();

  if (toolResults && Array.isArray(toolResults)) {
    for (const tr of toolResults) {
      const id = tr.toolUseId;
      if (id && expectedIds.has(id) && !foundIds.has(id)) {
        filteredResults.push(tr);
        foundIds.add(id);
      }
    }
  }

  // Add missing tool results with default content
  for (const [id] of expectedIds) {
    if (!foundIds.has(id)) {
      filteredResults.push({
        content: [{ text: DEFAULT_TOOL_RESULT_CONTENT }],
        status: 'success',
        toolUseId: id
      });
    }
  }

  return filteredResults;
}

/**
 * Deduplicate tool results by toolUseId
 * @param {Array} toolResults - Tool results array
 * @returns {Array} Deduplicated tool results
 */
export function deduplicateToolResults(toolResults) {
  if (!toolResults || !Array.isArray(toolResults)) {
    return [];
  }

  const seen = new Set();
  const unique = [];

  for (const tr of toolResults) {
    if (tr.toolUseId && !seen.has(tr.toolUseId)) {
      seen.add(tr.toolUseId);
      unique.push(tr);
    }
  }

  return unique;
}

/**
 * Extract tool uses from assistant message for Kiro format
 * @param {Array} toolUses - Tool uses from processAssistantContentBlocks
 * @returns {Array} Kiro-formatted tool uses
 */
export function formatToolUsesForKiro(toolUses) {
  if (!toolUses || !Array.isArray(toolUses)) {
    return [];
  }

  return toolUses.map(tu => ({
    input: tu.input,
    name: shortenToolName(tu.name),
    toolUseId: tu.toolUseId || tu.id
  }));
}

/**
 * Check if assistant message has tool uses
 * @param {Object} assistantMsg - Assistant message object
 * @returns {boolean} True if has tool uses
 */
export function hasToolUses(assistantMsg) {
  return assistantMsg &&
    assistantMsg.toolUses &&
    Array.isArray(assistantMsg.toolUses) &&
    assistantMsg.toolUses.length > 0;
}

/**
 * Get tool use IDs from assistant message
 * @param {Object} assistantMsg - Assistant message object
 * @returns {Array<string>} Array of tool use IDs
 */
export function getToolUseIds(assistantMsg) {
  if (!hasToolUses(assistantMsg)) {
    return [];
  }

  return assistantMsg.toolUses
    .map(tu => tu.toolUseId || tu.id)
    .filter(Boolean);
}

/**
 * Process tool choice parameter
 * @param {Object|string} toolChoice - Tool choice from request
 * @returns {Object|null} Processed tool choice for Kiro
 */
export function processToolChoice(toolChoice) {
  if (!toolChoice) {
    return null;
  }

  // String values
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'auto' || toolChoice === 'any' || toolChoice === 'none') {
      return { type: toolChoice };
    }
    return null;
  }

  // Object values
  if (typeof toolChoice === 'object') {
    if (toolChoice.type === 'tool' && toolChoice.name) {
      return {
        type: 'tool',
        name: shortenToolName(toolChoice.name)
      };
    }
    if (toolChoice.type === 'auto' || toolChoice.type === 'any' || toolChoice.type === 'none') {
      return { type: toolChoice.type };
    }
  }

  return null;
}
