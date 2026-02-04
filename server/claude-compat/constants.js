/**
 * Claude Protocol Constants
 *
 * Constants for Claude API compatibility layer
 */

// Claude API Versions
export const CLAUDE_API_VERSIONS = ['2023-06-01', '2023-01-01', '2024-01-01'];
export const DEFAULT_API_VERSION = '2023-06-01';

// Thinking Mode Constants
export const THINKING_MAX_BUDGET_TOKENS = 24576;
export const THINKING_DEFAULT_BUDGET_TOKENS = 20000;
export const THINKING_START_TAG = '<thinking>';
export const THINKING_END_TAG = '</thinking>';
export const THINKING_MODE_TAG = '<thinking_mode>';
export const THINKING_MAX_LEN_TAG = '<max_thinking_length>';

// History Compression Constants
export const MAX_HISTORY_ITEMS = 100;
export const MAX_TOOL_RESULT_LENGTH = 8000;
export const MAX_ASSISTANT_CONTENT_LENGTH = 8000;

// Tool Constants
export const MAX_TOOL_NAME_LENGTH = 64;
export const MAX_TOOL_DESCRIPTION_LENGTH = 9216; // Aligned with Go implementation

// Image Handling
export const KEEP_IMAGE_THRESHOLD = 5;

// Retry Constants
export const MAX_ACCOUNT_RETRIES = 5;
export const RETRY_DELAY_MS = 1000;

// Kiro API Constants
export const KIRO_API_URL = 'https://q.us-east-1.amazonaws.com/generateAssistantResponse';
export const KIRO_ORIGIN = 'AI_EDITOR';
export const KIRO_CHAT_TRIGGER_TYPE = 'MANUAL';

// SSE Event Types
export const SSE_EVENTS = {
  MESSAGE_START: 'message_start',
  MESSAGE_DELTA: 'message_delta',
  MESSAGE_STOP: 'message_stop',
  CONTENT_BLOCK_START: 'content_block_start',
  CONTENT_BLOCK_DELTA: 'content_block_delta',
  CONTENT_BLOCK_STOP: 'content_block_stop',
  PING: 'ping',
  ERROR: 'error'
};

// Content Block Types
export const CONTENT_BLOCK_TYPES = {
  TEXT: 'text',
  THINKING: 'thinking',
  TOOL_USE: 'tool_use',
  TOOL_RESULT: 'tool_result',
  IMAGE: 'image'
};

// Delta Types
export const DELTA_TYPES = {
  TEXT_DELTA: 'text_delta',
  THINKING_DELTA: 'thinking_delta',
  INPUT_JSON_DELTA: 'input_json_delta'
};

// Stop Reasons
export const STOP_REASONS = {
  END_TURN: 'end_turn',
  TOOL_USE: 'tool_use',
  MAX_TOKENS: 'max_tokens',
  STOP_SEQUENCE: 'stop_sequence'
};

// Error Types
export const ERROR_TYPES = {
  INVALID_REQUEST: 'invalid_request_error',
  AUTHENTICATION: 'authentication_error',
  PERMISSION: 'permission_error',
  NOT_FOUND: 'not_found_error',
  RATE_LIMIT: 'rate_limit_error',
  API_ERROR: 'api_error',
  OVERLOADED: 'overloaded_error'
};

// Model Mappings (Claude model names to Kiro model IDs)
export const MODEL_MAPPINGS = {
  'claude-3-5-sonnet-20241022': 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'claude-sonnet-4-20250514': 'anthropic.claude-sonnet-4-20250514-v1:0',
  'claude-3-5-sonnet-latest': 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'claude-3-5-sonnet-v2': 'anthropic.claude-3-5-sonnet-20241022-v2:0',
  'claude-sonnet-4-5': 'anthropic.claude-sonnet-4-20250514-v1:0',
  'claude-sonnet-4-5-20250514': 'anthropic.claude-sonnet-4-20250514-v1:0'
};

export const DEFAULT_MODEL = 'claude-sonnet-4-5';

// Default placeholder content when content is empty
export const DEFAULT_CONTINUE_CONTENT = 'Continue';
export const DEFAULT_TOOL_RESULT_CONTENT = 'Tool execution completed.';
export const DEFAULT_TOOL_RESULTS_PROVIDED = 'Tool results provided.';
