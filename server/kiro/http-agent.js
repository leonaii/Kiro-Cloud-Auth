/**
 * HTTP Agent 配置
 * 针对高并发服务器优化
 */

import * as http from 'http'
import * as https from 'https'

// HTTP Agent 复用 - 针对 12核12G 服务器优化
// 增加超时时间以支持大上下文请求（200k tokens）
export const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 500, // 高并发连接数
  maxFreeSockets: 50, // 保持更多空闲连接
  timeout: 600000, // 10分钟，支持大上下文
  scheduling: 'fifo'
})

export const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 500,
  maxFreeSockets: 50,
  timeout: 600000, // 10分钟，支持大上下文
  scheduling: 'fifo',
  // TLS 会话复用
  maxCachedSessions: 100
})
