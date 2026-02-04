/**
 * Request Validator
 *
 * Validates Claude Messages API requests.
 */

import {
  CLAUDE_API_VERSIONS,
  DEFAULT_API_VERSION,
  ERROR_TYPES
} from '../constants.js';

/**
 * Validation error class
 */
export class ValidationError extends Error {
  constructor(type, message, status = 400) {
    super(message);
    this.name = 'ValidationError';
    this.type = type;
    this.status = status;
  }
}

/**
 * Validate anthropic-version header
 * @param {string} version - Version header value
 * @returns {{valid: boolean, version: string, error?: ValidationError}}
 */
export function validateAnthropicVersion(version) {
  if (!version) {
    return {
      valid: true,
      version: DEFAULT_API_VERSION
    };
  }

  if (!CLAUDE_API_VERSIONS.includes(version)) {
    return {
      valid: false,
      version: null,
      error: new ValidationError(
        ERROR_TYPES.INVALID_REQUEST,
        `Invalid anthropic-version: ${version}. Supported versions: ${CLAUDE_API_VERSIONS.join(', ')}`,
        400
      )
    };
  }

  return {
    valid: true,
    version
  };
}

/**
 * Validate messages array
 * @param {Array} messages - Messages array
 * @returns {{valid: boolean, error?: ValidationError}}
 */
export function validateMessages(messages) {
  if (!messages) {
    return {
      valid: false,
      error: new ValidationError(
        ERROR_TYPES.INVALID_REQUEST,
        'messages is required',
        400
      )
    };
  }

  if (!Array.isArray(messages)) {
    return {
      valid: false,
      error: new ValidationError(
        ERROR_TYPES.INVALID_REQUEST,
        'messages must be an array',
        400
      )
    };
  }

  if (messages.length === 0) {
    return {
      valid: false,
      error: new ValidationError(
        ERROR_TYPES.INVALID_REQUEST,
        'messages must be a non-empty array',
        400
      )
    };
  }

  // Validate each message
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    if (!msg || typeof msg !== 'object') {
      return {
        valid: false,
        error: new ValidationError(
          ERROR_TYPES.INVALID_REQUEST,
          `messages[${i}] must be an object`,
          400
        )
      };
    }

    if (!msg.role) {
      return {
        valid: false,
        error: new ValidationError(
          ERROR_TYPES.INVALID_REQUEST,
          `messages[${i}].role is required`,
          400
        )
      };
    }

    const validRoles = ['user', 'assistant', 'system', 'tool'];
    if (!validRoles.includes(msg.role)) {
      return {
        valid: false,
        error: new ValidationError(
          ERROR_TYPES.INVALID_REQUEST,
          `messages[${i}].role must be one of: ${validRoles.join(', ')}`,
          400
        )
      };
    }

    // Content validation
    if (msg.content === undefined || msg.content === null) {
      return {
        valid: false,
        error: new ValidationError(
          ERROR_TYPES.INVALID_REQUEST,
          `messages[${i}].content is required`,
          400
        )
      };
    }
  }

  return { valid: true };
}

/**
 * Validate max_tokens parameter
 * @param {number} maxTokens - Max tokens value
 * @returns {{valid: boolean, error?: ValidationError}}
 */
export function validateMaxTokens(maxTokens) {
  if (maxTokens === undefined || maxTokens === null) {
    return {
      valid: false,
      error: new ValidationError(
        ERROR_TYPES.INVALID_REQUEST,
        'max_tokens is required',
        400
      )
    };
  }

  if (typeof maxTokens !== 'number') {
    return {
      valid: false,
      error: new ValidationError(
        ERROR_TYPES.INVALID_REQUEST,
        'max_tokens must be a number',
        400
      )
    };
  }

  if (maxTokens <= 0) {
    return {
      valid: false,
      error: new ValidationError(
        ERROR_TYPES.INVALID_REQUEST,
        'max_tokens must be a positive integer',
        400
      )
    };
  }

  if (!Number.isInteger(maxTokens)) {
    return {
      valid: false,
      error: new ValidationError(
        ERROR_TYPES.INVALID_REQUEST,
        'max_tokens must be an integer',
        400
      )
    };
  }

  return { valid: true };
}

/**
 * Validate model parameter
 * @param {string} model - Model name
 * @param {Array} supportedModels - List of supported models (optional)
 * @returns {{valid: boolean, error?: ValidationError}}
 */
export function validateModel(model, supportedModels = null) {
  if (!model) {
    // Model is optional, will use default
    return { valid: true };
  }

  if (typeof model !== 'string') {
    return {
      valid: false,
      error: new ValidationError(
        ERROR_TYPES.INVALID_REQUEST,
        'model must be a string',
        400
      )
    };
  }

  if (supportedModels && !supportedModels.includes(model)) {
    return {
      valid: false,
      error: new ValidationError(
        ERROR_TYPES.NOT_FOUND,
        `Model '${model}' not found`,
        404
      )
    };
  }

  return { valid: true };
}

/**
 * Validate thinking parameter
 * @param {Object} thinking - Thinking configuration
 * @returns {{valid: boolean, error?: ValidationError}}
 */
export function validateThinking(thinking) {
  if (!thinking) {
    return { valid: true };
  }

  if (typeof thinking !== 'object') {
    return {
      valid: false,
      error: new ValidationError(
        ERROR_TYPES.INVALID_REQUEST,
        'thinking must be an object',
        400
      )
    };
  }

  if (thinking.type && thinking.type !== 'enabled' && thinking.type !== 'disabled') {
    return {
      valid: false,
      error: new ValidationError(
        ERROR_TYPES.INVALID_REQUEST,
        'thinking.type must be "enabled" or "disabled"',
        400
      )
    };
  }

  if (thinking.budget_tokens !== undefined) {
    if (typeof thinking.budget_tokens !== 'number' || thinking.budget_tokens < 0) {
      return {
        valid: false,
        error: new ValidationError(
          ERROR_TYPES.INVALID_REQUEST,
          'thinking.budget_tokens must be a non-negative number',
          400
        )
      };
    }
  }

  return { valid: true };
}

/**
 * Validate tools parameter
 * @param {Array} tools - Tools array
 * @returns {{valid: boolean, error?: ValidationError}}
 */
export function validateTools(tools) {
  if (!tools) {
    return { valid: true };
  }

  if (!Array.isArray(tools)) {
    return {
      valid: false,
      error: new ValidationError(
        ERROR_TYPES.INVALID_REQUEST,
        'tools must be an array',
        400
      )
    };
  }

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i];

    if (!tool || typeof tool !== 'object') {
      return {
        valid: false,
        error: new ValidationError(
          ERROR_TYPES.INVALID_REQUEST,
          `tools[${i}] must be an object`,
          400
        )
      };
    }

    if (!tool.name || typeof tool.name !== 'string') {
      return {
        valid: false,
        error: new ValidationError(
          ERROR_TYPES.INVALID_REQUEST,
          `tools[${i}].name is required and must be a string`,
          400
        )
      };
    }
  }

  return { valid: true };
}

/**
 * Validate complete Claude Messages API request
 * @param {Object} request - Request body
 * @param {Object} options - Validation options
 * @returns {{valid: boolean, errors: Array<ValidationError>}}
 */
export function validateRequest(request, options = {}) {
  const { supportedModels = null } = options;
  const errors = [];

  // Validate messages
  const messagesResult = validateMessages(request.messages);
  if (!messagesResult.valid) {
    errors.push(messagesResult.error);
  }

  // Validate max_tokens
  const maxTokensResult = validateMaxTokens(request.max_tokens);
  if (!maxTokensResult.valid) {
    errors.push(maxTokensResult.error);
  }

  // Validate model
  const modelResult = validateModel(request.model, supportedModels);
  if (!modelResult.valid) {
    errors.push(modelResult.error);
  }

  // Validate thinking
  const thinkingResult = validateThinking(request.thinking);
  if (!thinkingResult.valid) {
    errors.push(thinkingResult.error);
  }

  // Validate tools
  const toolsResult = validateTools(request.tools);
  if (!toolsResult.valid) {
    errors.push(toolsResult.error);
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Express middleware for validating anthropic-version header
 */
export function validateAnthropicVersionMiddleware(req, res, next) {
  const version = req.headers['anthropic-version'];
  const result = validateAnthropicVersion(version);

  if (!result.valid) {
    return res.status(result.error.status).json({
      type: 'error',
      error: {
        type: result.error.type,
        message: result.error.message
      }
    });
  }

  req.anthropicVersion = result.version;
  next();
}

/**
 * Build error response from ValidationError
 * @param {ValidationError} error - Validation error
 * @returns {Object} Error response
 */
export function buildValidationErrorResponse(error) {
  return {
    status: error.status,
    body: {
      type: 'error',
      error: {
        type: error.type,
        message: error.message
      }
    }
  };
}

export default {
  ValidationError,
  validateAnthropicVersion,
  validateMessages,
  validateMaxTokens,
  validateModel,
  validateThinking,
  validateTools,
  validateRequest,
  validateAnthropicVersionMiddleware,
  buildValidationErrorResponse
};
