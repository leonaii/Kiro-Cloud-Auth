import Joi from 'joi'

// ==================== 通用验证规则 ====================

// 颜色格式验证（支持hex颜色）
const hexColorPattern = /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/

// IDP枚举值（大写下划线格式 - 数据库存储格式）
const idpValues = ['IAM', 'BUILDER_ID', 'GOOGLE', 'GITHUB']

// IDP格式转换映射（支持驼峰格式输入）
const idpFormatMap = {
  'BuilderId': 'BUILDER_ID',
  'BUILDER_ID': 'BUILDER_ID',
  'Google': 'GOOGLE',
  'GOOGLE': 'GOOGLE',
  'Github': 'GITHUB',
  'GITHUB': 'GITHUB',
  'IAM': 'IAM'
}

// IDP验证和转换函数
const normalizeIdp = (value) => {
  if (!value) return value
  // 如果已经是标准格式,直接返回
  if (idpValues.includes(value)) return value
  // 尝试从映射表转换
  const normalized = idpFormatMap[value]
  if (normalized) return normalized
  // 无法识别的格式,返回原值(会被后续验证拒绝)
  return value
}

// 账号状态枚举值
const accountStatusValues = ['active', 'error', 'expired', 'refreshing']

// 同步资源类型枚举值
const syncResourceValues = ['accounts', 'groups', 'tags', 'settings']

// 批量操作类型枚举值
const batchActionValues = ['create', 'update', 'delete']

// 主题枚举值
const themeValues = ['light', 'dark', 'system']

// ==================== 账号相关Schema ====================

/**
 * 账号凭证Schema
 */
const credentialsSchema = Joi.object({
  accessToken: Joi.string().allow('', null),
  refreshToken: Joi.string().allow('', null),
  idToken: Joi.string().allow('', null),
  expiresAt: Joi.number().integer().allow(null),
  tokenType: Joi.string().allow('', null),
  scope: Joi.string().allow('', null),
  clientId: Joi.string().allow('', null),
  clientSecret: Joi.string().allow('', null),
  region: Joi.string().allow('', null),
  ssoToken: Joi.string().allow('', null),
  ssoExpiresAt: Joi.number().integer().allow(null)
}).unknown(true)

/**
 * 创建账号Schema
 */
export const accountCreateSchema = Joi.object({
  id: Joi.string().required().min(1).max(100).messages({
    'string.empty': '账号ID不能为空',
    'any.required': '账号ID是必需的'
  }),
  email: Joi.string().email().required().messages({
    'string.email': '邮箱格式不正确',
    'any.required': '邮箱是必需的'
  }),
  idp: Joi.string().custom((value, helpers) => {
    const normalized = normalizeIdp(value)
    if (!idpValues.includes(normalized)) {
      return helpers.error('any.only')
    }
    return normalized
  }).default('IAM').messages({
    'any.only': `IDP必须是以下值之一: ${idpValues.join(', ')} (也支持驼峰格式: BuilderId, Google, Github)`
  }),
  credentials: credentialsSchema.default({}),
  status: Joi.string().valid(...accountStatusValues).default('active'),
  groupId: Joi.string().allow('', null),
  tags: Joi.array().items(Joi.string()).default([]),
  notes: Joi.string().allow('', null).max(1000),
  lastUsed: Joi.number().integer().allow(null),
  usageCount: Joi.number().integer().min(0).default(0),
  errorMessage: Joi.string().allow('', null),
  metadata: Joi.object().unknown(true).default({})
}).unknown(true)

/**
 * 更新账号Schema（允许部分字段更新）
 */
export const accountUpdateSchema = Joi.object({
  email: Joi.string().email().messages({
    'string.email': '邮箱格式不正确'
  }),
  idp: Joi.string().custom((value, helpers) => {
    const normalized = normalizeIdp(value)
    if (!idpValues.includes(normalized)) {
      return helpers.error('any.only')
    }
    return normalized
  }).messages({
    'any.only': `IDP必须是以下值之一: ${idpValues.join(', ')} (也支持驼峰格式: BuilderId, Google, Github)`
  }),
  credentials: credentialsSchema,
  status: Joi.string().valid(...accountStatusValues),
  groupId: Joi.string().allow('', null),
  tags: Joi.array().items(Joi.string()),
  notes: Joi.string().allow('', null).max(1000),
  lastUsed: Joi.number().integer().allow(null),
  usageCount: Joi.number().integer().min(0),
  errorMessage: Joi.string().allow('', null),
  metadata: Joi.object().unknown(true),
  version: Joi.number().integer().min(0).messages({
    'number.base': 'version必须是数字类型'
  })
}).unknown(true).min(1).messages({
  'object.min': '至少需要提供一个要更新的字段'
})

/**
 * 批量操作Schema
 */
export const accountBatchSchema = Joi.object({
  operations: Joi.array().items(
    Joi.object({
      action: Joi.string().valid(...batchActionValues).required().messages({
        'any.only': `操作类型必须是以下值之一: ${batchActionValues.join(', ')}`,
        'any.required': '操作类型是必需的'
      }),
      data: Joi.object({
        id: Joi.string().required(),
        email: Joi.string().email().when('...action', {
          is: 'create',
          then: Joi.required(),
          otherwise: Joi.optional()
        })
      }).unknown(true).required()
    })
  ).min(1).max(100).required().messages({
    'array.min': '至少需要一个操作',
    'array.max': '批量操作最多支持100个',
    'any.required': 'operations是必需的'
  })
})

/**
 * 账号列表查询参数Schema
 */
export const accountListQuerySchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(10000).default(20),
  fields: Joi.string().allow('', null),
  includeDeleted: Joi.boolean().default(false),
  modifiedSince: Joi.number().integer().positive().allow(null),
  status: Joi.string().valid(...accountStatusValues, 'all').default('all'),
  groupId: Joi.string().allow('', null),
  tag: Joi.string().allow('', null),
  tagId: Joi.string().allow('', null),
  search: Joi.string().allow('', null).max(100),
  sortBy: Joi.string().valid('email', 'lastUsed', 'usageCount', 'createdAt', 'updatedAt').default('createdAt'),
  sortOrder: Joi.string().valid('asc', 'desc').default('desc')
})

// ==================== 分组相关Schema ====================

/**
 * 分组Schema
 */
export const groupSchema = Joi.object({
  id: Joi.string().required().min(1).max(100).messages({
    'string.empty': '分组ID不能为空',
    'any.required': '分组ID是必需的'
  }),
  name: Joi.string().required().min(1).max(50).messages({
    'string.empty': '分组名称不能为空',
    'string.max': '分组名称最多50个字符',
    'any.required': '分组名称是必需的'
  }),
  color: Joi.string().pattern(hexColorPattern).required().messages({
    'string.pattern.base': '颜色必须是有效的hex格式（如#FF0000）',
    'any.required': '颜色是必需的'
  }),
  order: Joi.number().integer().min(0).default(0),
  description: Joi.string().allow('', null).max(200)
}).unknown(true)

/**
 * 分组更新Schema
 */
export const groupUpdateSchema = Joi.object({
  name: Joi.string().min(1).max(50).messages({
    'string.empty': '分组名称不能为空',
    'string.max': '分组名称最多50个字符'
  }),
  color: Joi.string().pattern(hexColorPattern).messages({
    'string.pattern.base': '颜色必须是有效的hex格式（如#FF0000）'
  }),
  order: Joi.number().integer().min(0),
  description: Joi.string().allow('', null).max(200)
}).unknown(true).min(1).messages({
  'object.min': '至少需要提供一个要更新的字段'
})

// ==================== 标签相关Schema ====================

/**
 * 标签Schema
 */
export const tagSchema = Joi.object({
  id: Joi.string().required().min(1).max(100).messages({
    'string.empty': '标签ID不能为空',
    'any.required': '标签ID是必需的'
  }),
  name: Joi.string().required().min(1).max(50).messages({
    'string.empty': '标签名称不能为空',
    'string.max': '标签名称最多50个字符',
    'any.required': '标签名称是必需的'
  }),
  color: Joi.string().pattern(hexColorPattern).required().messages({
    'string.pattern.base': '颜色必须是有效的hex格式（如#FF0000）',
    'any.required': '颜色是必需的'
  }),
  description: Joi.string().allow('', null).max(200)
}).unknown(true)

/**
 * 标签更新Schema
 */
export const tagUpdateSchema = Joi.object({
  name: Joi.string().min(1).max(50).messages({
    'string.empty': '标签名称不能为空',
    'string.max': '标签名称最多50个字符'
  }),
  color: Joi.string().pattern(hexColorPattern).messages({
    'string.pattern.base': '颜色必须是有效的hex格式（如#FF0000）'
  }),
  description: Joi.string().allow('', null).max(200)
}).unknown(true).min(1).messages({
  'object.min': '至少需要提供一个要更新的字段'
})

// ==================== 同步相关Schema ====================

/**
 * 同步变更查询Schema
 */
export const syncChangesQuerySchema = Joi.object({
  modifiedSince: Joi.number().integer().positive().required().custom((value, helpers) => {
    // 不能是未来时间（允许5分钟的时钟偏差）
    const maxTime = Date.now() + 5 * 60 * 1000
    if (value > maxTime) {
      return helpers.error('custom.futureTime')
    }
    return value
  }).messages({
    'number.positive': 'modifiedSince必须是正整数',
    'any.required': 'modifiedSince是必需的',
    'custom.futureTime': 'modifiedSince不能是未来时间'
  }),
  resources: Joi.array().items(
    Joi.string().valid(...syncResourceValues)
  ).default(syncResourceValues)
})

/**
 * 同步删除Schema
 */
export const syncDeleteSchema = Joi.object({
  accounts: Joi.object().pattern(
    Joi.string(),
    Joi.object().unknown(true)
  ).required().min(1).messages({
    'object.min': 'accounts不能为空对象',
    'any.required': 'accounts是必需的'
  }),
  groups: Joi.object().pattern(
    Joi.string(),
    Joi.object().unknown(true)
  ).default({}),
  tags: Joi.object().pattern(
    Joi.string(),
    Joi.object().unknown(true)
  ).default({}),
  settings: Joi.object().unknown(true).default({}),
  syncDelete: Joi.boolean().default(false),
  confirmSyncDelete: Joi.boolean().default(false),
  forceSync: Joi.boolean().default(false)
}).unknown(true)

/**
 * 数据导入Schema
 */
export const importDataSchema = Joi.object({
  mode: Joi.string().valid('merge', 'overwrite').default('merge').messages({
    'any.only': 'mode必须是merge或overwrite'
  }),
  accounts: Joi.object().pattern(
    Joi.string(),
    Joi.object().unknown(true)
  ).default({}),
  groups: Joi.object().pattern(
    Joi.string(),
    Joi.object().unknown(true)
  ).default({}),
  tags: Joi.object().pattern(
    Joi.string(),
    Joi.object().unknown(true)
  ).default({})
}).unknown(true)

// ==================== 设置相关Schema ====================

/**
 * 设置值验证Schema（根据key动态验证）
 */
export const settingValueSchema = Joi.object({
  key: Joi.string().required().messages({
    'any.required': '设置key是必需的'
  }),
  value: Joi.any().required().messages({
    'any.required': '设置value是必需的'
  })
}).custom((obj, helpers) => {
  const { key, value } = obj
  
  // 根据key验证value类型
  const validators = {
    autoRefreshInterval: Joi.number().integer().min(0).max(86400),
    autoRefreshEnabled: Joi.boolean(),
    theme: Joi.string().valid(...themeValues),
    language: Joi.string().min(2).max(10),
    apiBaseUrl: Joi.string().uri().allow(''),
    maxConcurrentRefresh: Joi.number().integer().min(1).max(50),
    refreshRetryCount: Joi.number().integer().min(0).max(10),
    refreshRetryDelay: Joi.number().integer().min(0).max(60000),
    enableNotifications: Joi.boolean(),
    logLevel: Joi.string().valid('debug', 'info', 'warn', 'error')
  }
  
  const validator = validators[key]
  if (validator) {
    const { error } = validator.validate(value)
    if (error) {
      return helpers.error('custom.invalidValue', { message: error.message })
    }
  }
  
  return obj
}).messages({
  'custom.invalidValue': '{{#message}}'
})

/**
 * 批量设置更新Schema
 */
export const settingsBatchSchema = Joi.object({
  settings: Joi.object().pattern(
    Joi.string(),
    Joi.any()
  ).required().min(1).messages({
    'object.min': '至少需要一个设置项',
    'any.required': 'settings是必需的'
  })
})

// ==================== 通用验证中间件 ====================

/**
 * 创建验证中间件
 * @param {Joi.Schema} schema - Joi验证schema
 * @param {string} source - 数据来源: 'body' | 'query' | 'params'
 * @returns {Function} Express中间件
 */
export function validateRequest(schema, source = 'body') {
  return (req, res, next) => {
    const data = req[source]
    
    const { error, value } = schema.validate(data, {
      abortEarly: false, // 收集所有错误
      stripUnknown: false, // 保留未知字段
      convert: true // 自动类型转换
    })
    
    if (error) {
      const errors = error.details.map(detail => ({
        field: detail.path.join('.'),
        message: detail.message,
        type: detail.type
      }))
      
      return res.status(400).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: '请求参数验证失败',
          details: errors
        }
      })
    }
    
    // 将验证后的值（包含默认值）写回请求对象
    req[source] = value
    next()
  }
}

/**
 * 创建可选验证中间件（验证失败不阻止请求，但记录警告）
 * @param {Joi.Schema} schema - Joi验证schema
 * @param {string} source - 数据来源
 * @returns {Function} Express中间件
 */
export function validateRequestOptional(schema, source = 'body') {
  return (req, res, next) => {
    const data = req[source]
    
    const { error, value } = schema.validate(data, {
      abortEarly: false,
      stripUnknown: false,
      convert: true
    })
    
    if (error) {
      // 记录验证警告但不阻止请求
      console.warn(`[Validation Warning] ${source}:`, error.details.map(d => d.message).join(', '))
      req.validationWarnings = error.details
    }
    
    req[source] = value
    next()
  }
}

/**
 * ID参数验证Schema
 */
export const idParamSchema = Joi.object({
  id: Joi.string().required().min(1).max(100).messages({
    'string.empty': 'ID不能为空',
    'any.required': 'ID是必需的'
  })
})

/**
 * 分页参数验证Schema
 */
export const paginationSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  pageSize: Joi.number().integer().min(1).max(100).default(20),
  limit: Joi.number().integer().min(1).max(1000).default(100),
  offset: Joi.number().integer().min(0).default(0)
})

// 导出所有Schema
export default {
  // 账号相关
  accountCreateSchema,
  accountUpdateSchema,
  accountBatchSchema,
  accountListQuerySchema,
  
  // 分组相关
  groupSchema,
  groupUpdateSchema,
  
  // 标签相关
  tagSchema,
  tagUpdateSchema,
  
  // 同步相关
  syncChangesQuerySchema,
  syncDeleteSchema,
  importDataSchema,
  
  // 设置相关
  settingValueSchema,
  settingsBatchSchema,
  
  // 通用
  idParamSchema,
  paginationSchema,
  
  // 中间件
  validateRequest,
  validateRequestOptional
}