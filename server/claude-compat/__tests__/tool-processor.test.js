/**
 * Tool Processor Unit Tests
 */

import {
  shortenToolName,
  processToolDescription,
  convertTools,
  matchToolResults,
  deduplicateToolResults,
  formatToolUsesForKiro,
  hasToolUses,
  getToolUseIds,
  processToolChoice
} from '../builders/tool-processor.js';

import {
  MAX_TOOL_NAME_LENGTH,
  MAX_TOOL_DESCRIPTION_LENGTH
} from '../constants.js';

describe('Tool Processor', () => {
  describe('shortenToolName', () => {
    it('should return short names unchanged', () => {
      expect(shortenToolName('search')).toBe('search');
    });

    it('should truncate long names', () => {
      const longName = 'a'.repeat(100);
      const result = shortenToolName(longName);

      expect(result.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
      expect(result).toContain('...');
    });

    it('should handle null/undefined', () => {
      expect(shortenToolName(null)).toBe(null);
      expect(shortenToolName(undefined)).toBe(undefined);
    });
  });

  describe('processToolDescription', () => {
    it('should return short descriptions unchanged', () => {
      expect(processToolDescription('A search tool')).toBe('A search tool');
    });

    it('should truncate long descriptions', () => {
      const longDesc = 'a'.repeat(MAX_TOOL_DESCRIPTION_LENGTH + 100);
      const result = processToolDescription(longDesc);

      expect(result.length).toBeLessThanOrEqual(MAX_TOOL_DESCRIPTION_LENGTH);
      expect(result).toContain('...');
    });

    it('should handle null/undefined', () => {
      expect(processToolDescription(null)).toBe(null);
      expect(processToolDescription(undefined)).toBe(undefined);
    });
  });

  describe('convertTools', () => {
    it('should convert Claude tools to Kiro format', () => {
      const tools = [
        {
          name: 'search',
          description: 'Search the web',
          input_schema: { type: 'object', properties: { query: { type: 'string' } } }
        }
      ];
      const result = convertTools(tools);

      expect(result).toHaveLength(1);
      expect(result[0].toolSpecification.name).toBe('search');
      expect(result[0].toolSpecification.description).toBe('Search the web');
      expect(result[0].toolSpecification.inputSchema.json).toEqual(tools[0].input_schema);
    });

    it('should filter out web_search tool', () => {
      const tools = [
        { name: 'web_search', description: 'Search' },
        { name: 'calculator', description: 'Calculate' }
      ];
      const result = convertTools(tools);

      expect(result).toHaveLength(1);
      expect(result[0].toolSpecification.name).toBe('calculator');
    });

    it('should filter out websearch tool (case insensitive)', () => {
      const tools = [
        { name: 'WebSearch', description: 'Search' },
        { name: 'other', description: 'Other' }
      ];
      const result = convertTools(tools);

      expect(result).toHaveLength(1);
      expect(result[0].toolSpecification.name).toBe('other');
    });

    it('should handle empty/null tools', () => {
      expect(convertTools(null)).toEqual([]);
      expect(convertTools(undefined)).toEqual([]);
      expect(convertTools([])).toEqual([]);
    });
  });

  describe('matchToolResults', () => {
    it('should return empty array when no expected tool uses', () => {
      const toolResults = [
        { toolUseId: 'tool_1', content: [{ text: 'Result' }], status: 'success' }
      ];
      expect(matchToolResults(toolResults, [])).toEqual([]);
      expect(matchToolResults(toolResults, null)).toEqual([]);
    });

    it('should filter tool results to match expected', () => {
      const toolResults = [
        { toolUseId: 'tool_1', content: [{ text: 'Result 1' }], status: 'success' },
        { toolUseId: 'tool_2', content: [{ text: 'Result 2' }], status: 'success' },
        { toolUseId: 'tool_3', content: [{ text: 'Result 3' }], status: 'success' }
      ];
      const expectedToolUses = [
        { toolUseId: 'tool_1' },
        { toolUseId: 'tool_2' }
      ];
      const result = matchToolResults(toolResults, expectedToolUses);

      expect(result).toHaveLength(2);
      expect(result.map(r => r.toolUseId)).toContain('tool_1');
      expect(result.map(r => r.toolUseId)).toContain('tool_2');
      expect(result.map(r => r.toolUseId)).not.toContain('tool_3');
    });

    it('should add missing tool results with default content', () => {
      const toolResults = [
        { toolUseId: 'tool_1', content: [{ text: 'Result 1' }], status: 'success' }
      ];
      const expectedToolUses = [
        { toolUseId: 'tool_1' },
        { toolUseId: 'tool_2' }
      ];
      const result = matchToolResults(toolResults, expectedToolUses);

      expect(result).toHaveLength(2);
      const tool2Result = result.find(r => r.toolUseId === 'tool_2');
      expect(tool2Result).toBeDefined();
      expect(tool2Result.content[0].text).toBe('Tool execution completed.');
    });
  });

  describe('deduplicateToolResults', () => {
    it('should remove duplicate tool results', () => {
      const toolResults = [
        { toolUseId: 'tool_1', content: [{ text: 'Result 1' }] },
        { toolUseId: 'tool_1', content: [{ text: 'Result 1 duplicate' }] },
        { toolUseId: 'tool_2', content: [{ text: 'Result 2' }] }
      ];
      const result = deduplicateToolResults(toolResults);

      expect(result).toHaveLength(2);
      expect(result[0].toolUseId).toBe('tool_1');
      expect(result[0].content[0].text).toBe('Result 1'); // First one kept
    });

    it('should handle empty/null', () => {
      expect(deduplicateToolResults(null)).toEqual([]);
      expect(deduplicateToolResults([])).toEqual([]);
    });
  });

  describe('formatToolUsesForKiro', () => {
    it('should format tool uses for Kiro API', () => {
      const toolUses = [
        { toolUseId: 'tool_1', name: 'search', input: { query: 'test' } }
      ];
      const result = formatToolUsesForKiro(toolUses);

      expect(result).toHaveLength(1);
      expect(result[0].toolUseId).toBe('tool_1');
      expect(result[0].name).toBe('search');
      expect(result[0].input).toEqual({ query: 'test' });
    });

    it('should handle id field as fallback', () => {
      const toolUses = [
        { id: 'tool_1', name: 'search', input: {} }
      ];
      const result = formatToolUsesForKiro(toolUses);

      expect(result[0].toolUseId).toBe('tool_1');
    });

    it('should shorten long tool names', () => {
      const longName = 'a'.repeat(100);
      const toolUses = [
        { toolUseId: 'tool_1', name: longName, input: {} }
      ];
      const result = formatToolUsesForKiro(toolUses);

      expect(result[0].name.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
    });
  });

  describe('hasToolUses', () => {
    it('should return true when assistant has tool uses', () => {
      const assistantMsg = {
        toolUses: [{ toolUseId: 'tool_1', name: 'search', input: {} }]
      };
      expect(hasToolUses(assistantMsg)).toBe(true);
    });

    it('should return false when no tool uses', () => {
      expect(hasToolUses(null)).toBe(false);
      expect(hasToolUses({})).toBe(false);
      expect(hasToolUses({ toolUses: [] })).toBe(false);
      expect(hasToolUses({ toolUses: null })).toBe(false);
    });
  });

  describe('getToolUseIds', () => {
    it('should extract tool use IDs', () => {
      const assistantMsg = {
        toolUses: [
          { toolUseId: 'tool_1' },
          { toolUseId: 'tool_2' },
          { id: 'tool_3' }
        ]
      };
      const result = getToolUseIds(assistantMsg);

      expect(result).toEqual(['tool_1', 'tool_2', 'tool_3']);
    });

    it('should return empty array when no tool uses', () => {
      expect(getToolUseIds(null)).toEqual([]);
      expect(getToolUseIds({})).toEqual([]);
    });
  });

  describe('processToolChoice', () => {
    it('should handle string values', () => {
      expect(processToolChoice('auto')).toEqual({ type: 'auto' });
      expect(processToolChoice('any')).toEqual({ type: 'any' });
      expect(processToolChoice('none')).toEqual({ type: 'none' });
    });

    it('should handle object with type', () => {
      expect(processToolChoice({ type: 'auto' })).toEqual({ type: 'auto' });
      expect(processToolChoice({ type: 'any' })).toEqual({ type: 'any' });
    });

    it('should handle specific tool choice', () => {
      const result = processToolChoice({ type: 'tool', name: 'search' });
      expect(result).toEqual({ type: 'tool', name: 'search' });
    });

    it('should return null for invalid values', () => {
      expect(processToolChoice(null)).toBe(null);
      expect(processToolChoice(undefined)).toBe(null);
      expect(processToolChoice('invalid')).toBe(null);
    });
  });
});
