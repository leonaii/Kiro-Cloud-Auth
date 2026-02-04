/**
 * Claude Compatibility Module - Unified Exports
 *
 * This module provides Claude API compatibility layer for Kiro backend.
 */

// ==================== Constants ====================
export * from './constants.js';

// ==================== Legacy Exports (for backward compatibility) ====================
// Converter exports
export {
  convertClaudeMessages,
  convertClaudeTools,
  processSystemPrompt,
  processToolChoice
} from './claude-converter.js';

// Response builder exports (legacy)
export {
  CLAUDE_API_VERSIONS,
  DEFAULT_API_VERSION,
  validateAnthropicVersion,
  buildClaudeError,
  buildClaudeResponse,
  buildSSEEvent
} from './claude-response.js';

// Legacy route exports (original implementation)
export {
  initClaudeRoutes as initClaudeRoutesLegacy,
  getAccountPool as getAccountPoolLegacy
} from './claude-routes.js';

// ==================== New Modular Exports ====================

// Builders
export {
  getContentText,
  ensureContentArray,
  preprocessMessages,
  mergeAdjacentMessages,
  processUserContentBlocks,
  processAssistantContentBlocks,
  buildAssistantContentWithThinking,
  truncateText,
  addImagePlaceholder
} from './builders/message-processor.js';

export {
  shortenToolName,
  processToolDescription,
  convertTools,
  matchToolResults,
  deduplicateToolResults,
  formatToolUsesForKiro,
  hasToolUses,
  getToolUseIds,
  processToolChoice as processToolChoiceNew
} from './builders/tool-processor.js';

export {
  getKiroModelId,
  generateThinkingPrefix,
  hasThinkingPrefix,
  buildKiroRequest
} from './builders/request-builder.js';

// Validators
export {
  ValidationError,
  validateAnthropicVersion as validateAnthropicVersionNew,
  validateMessages,
  validateMaxTokens,
  validateModel,
  validateThinking,
  validateTools,
  validateRequest,
  validateAnthropicVersionMiddleware,
  buildValidationErrorResponse
} from './validators/request-validator.js';

// Response
export {
  SSEWriter,
  buildSSEEvent as buildSSEEventNew,
  setupSSEHeaders
} from './response/sse-writer.js';

// Handlers
export {
  handleStream,
  handleStreamWithRetry,
  continueStreamWithNewAccount,
  processStreamEvent,
  StreamState
} from './handlers/stream-handler.js';

export {
  handleNonStream,
  buildClaudeResponseFromParsed,
  buildErrorResponse,
  categorizeError
} from './handlers/non-stream-handler.js';

// New Routes
export {
  initClaudeRoutes,
  getAccountPool
} from './routes/claude-routes.js';

// Default export - new router
export { default } from './routes/claude-routes.js';
