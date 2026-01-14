/**
 * 前端API性能监控模块
 *
 * 功能：
 * - 记录API调用性能指标
 * - 收集错误信息（仅本地记录，不上报到服务器）
 * - 提供性能统计数据
 */

// ==================== 类型定义 ====================

export interface PerformanceMetric {
  endpoint: string
  method: string
  duration: number
  success: boolean
  statusCode?: number
  timestamp: number
}

export interface ErrorRecord {
  id: string
  error: Error | string
  context?: {
    component?: string
    action?: string
    userId?: string
    endpoint?: string
    method?: string
    statusCode?: number
  }
  timestamp: number
  reported: boolean
}

export interface ApiMetrics {
  endpoint: string
  method: string
  avgDuration: number
  p95Duration: number
  errorRate: number
  totalCalls: number
  lastCall: number
}

// ==================== API监控器 ====================

class ApiMonitor {
  private metrics: Map<string, PerformanceMetric[]> = new Map()
  private maxMetricsPerEndpoint = 100
  private slowRequestThreshold = 3000 // 3秒
  
  /**
   * 记录API调用
   */
  recordApiCall(
    endpoint: string,
    method: string,
    duration: number,
    success: boolean,
    statusCode?: number
  ): void {
    const key = `${method}:${endpoint}`
    
    if (!this.metrics.has(key)) {
      this.metrics.set(key, [])
    }
    
    const metrics = this.metrics.get(key)!
    metrics.push({
      endpoint,
      method,
      duration,
      success,
      statusCode,
      timestamp: Date.now()
    })
    
    // 保持最近N条记录
    if (metrics.length > this.maxMetricsPerEndpoint) {
      metrics.shift()
    }
    
    // 慢请求告警
    if (duration > this.slowRequestThreshold) {
      console.warn(`[Monitor] Slow API call: ${method} ${endpoint} took ${duration}ms`)
    }
  }
  
  /**
   * 获取性能统计
   */
  getMetrics(): ApiMetrics[] {
    const result: ApiMetrics[] = []
    
    for (const [key, metrics] of this.metrics.entries()) {
      if (metrics.length === 0) continue
      
      const [method, endpoint] = key.split(':')
      const durations = metrics.map(m => m.duration)
      const sorted = [...durations].sort((a, b) => a - b)
      const errorCount = metrics.filter(m => !m.success).length
      
      result.push({
        endpoint,
        method,
        avgDuration: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
        p95Duration: sorted[Math.floor(sorted.length * 0.95)] || 0,
        errorRate: Number(((errorCount / metrics.length) * 100).toFixed(2)),
        totalCalls: metrics.length,
        lastCall: metrics[metrics.length - 1].timestamp
      })
    }
    
    // 按调用次数排序
    result.sort((a, b) => b.totalCalls - a.totalCalls)
    
    return result
  }
  
  /**
   * 获取特定端点的详细指标
   */
  getEndpointMetrics(endpoint: string, method: string): PerformanceMetric[] {
    const key = `${method}:${endpoint}`
    return this.metrics.get(key) || []
  }
  
  /**
   * 清理旧数据（保留最近1小时）
   */
  cleanup(): void {
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    
    for (const [key, metrics] of this.metrics.entries()) {
      const filtered = metrics.filter(m => m.timestamp > oneHourAgo)
      if (filtered.length === 0) {
        this.metrics.delete(key)
      } else {
        this.metrics.set(key, filtered)
      }
    }
  }
  
  /**
   * 重置所有指标
   */
  reset(): void {
    this.metrics.clear()
  }
  
  /**
   * 获取统计摘要
   */
  getSummary(): {
    totalCalls: number
    totalErrors: number
    avgDuration: number
    slowRequests: number
  } {
    let totalCalls = 0
    let totalErrors = 0
    let totalDuration = 0
    let slowRequests = 0
    
    for (const metrics of this.metrics.values()) {
      for (const m of metrics) {
        totalCalls++
        totalDuration += m.duration
        if (!m.success) totalErrors++
        if (m.duration > this.slowRequestThreshold) slowRequests++
      }
    }
    
    return {
      totalCalls,
      totalErrors,
      avgDuration: totalCalls > 0 ? Math.round(totalDuration / totalCalls) : 0,
      slowRequests
    }
  }
}

// ==================== 错误上报器 ====================

class ErrorReporter {
  private errorQueue: ErrorRecord[] = []
  private maxQueueSize = 100
  // 已禁用：前端错误不再上报到服务器
  // private reportEndpoint = '/api/monitoring/errors'
  private flushInterval: ReturnType<typeof setInterval> | null = null
  private flushIntervalMs = 30000 // 30秒
  
  constructor() {
    // 设置全局错误处理
    this.setupGlobalHandlers()
  }
  
  /**
   * 生成唯一ID
   */
  private generateId(): string {
    return `err_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  }
  
  /**
   * 记录错误
   */
  captureError(
    error: Error | string,
    context?: ErrorRecord['context']
  ): void {
    const errorRecord: ErrorRecord = {
      id: this.generateId(),
      error,
      context,
      timestamp: Date.now(),
      reported: false
    }
    
    this.errorQueue.push(errorRecord)
    
    // 保持队列大小
    if (this.errorQueue.length > this.maxQueueSize) {
      this.errorQueue.shift()
    }
    
    // 控制台输出
    console.error('[ErrorReporter] Captured error:', error, context)
  }
  
  /**
   * 批量处理错误（仅本地标记，不上报到服务器）
   *
   * 注意：前端错误不再上报到服务器，仅在本地记录
   */
  async flushErrors(): Promise<void> {
    const unreported = this.errorQueue.filter(e => !e.reported)
    if (unreported.length === 0) return
    
    // 仅标记为已处理，不发送到服务器
    for (const e of unreported) {
      e.reported = true
    }
    
    if (unreported.length > 0) {
      console.log(`[ErrorReporter] Processed ${unreported.length} errors (local only)`)
    }
  }
  
  /**
   * 获取错误日志
   */
  getErrors(limit = 50): ErrorRecord[] {
    return this.errorQueue.slice(-limit).reverse()
  }
  
  /**
   * 清除已上报的错误
   */
  clearReported(): void {
    this.errorQueue = this.errorQueue.filter(e => !e.reported)
  }
  
  /**
   * 设置全局错误处理器
   */
  setupGlobalHandlers(): void {
    if (typeof window === 'undefined') return
    
    // 捕获未处理的错误
    window.addEventListener('error', (event) => {
      this.captureError(event.error || new Error(event.message), {
        action: 'global_error',
        component: event.filename
      })
    })
    
    // 捕获未处理的Promise rejection
    window.addEventListener('unhandledrejection', (event) => {
      const error = event.reason instanceof Error 
        ? event.reason 
        : new Error(String(event.reason))
      this.captureError(error, {
        action: 'unhandled_rejection'
      })
    })
  }
  
  /**
   * 启动定时上报
   */
  startAutoFlush(): void {
    if (this.flushInterval) return
    
    this.flushInterval = setInterval(() => {
      this.flushErrors()
    }, this.flushIntervalMs)
  }
  
  /**
   * 停止定时上报
   */
  stopAutoFlush(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval)
      this.flushInterval = null
    }
  }
  
  /**
   * 获取统计信息
   */
  getStats(): {
    total: number
    reported: number
    pending: number
  } {
    const reported = this.errorQueue.filter(e => e.reported).length
    return {
      total: this.errorQueue.length,
      reported,
      pending: this.errorQueue.length - reported
    }
  }
}

// ==================== 单例实例 ====================

export const apiMonitor = new ApiMonitor()
export const errorReporter = new ErrorReporter()

// 自动启动错误上报
errorReporter.startAutoFlush()

// ==================== 辅助函数 ====================

/**
 * 包装fetch函数，自动记录性能指标
 */
export function withMonitoring<T extends (...args: unknown[]) => Promise<Response>>(
  fetchFn: T
): T {
  return (async (...args: Parameters<T>): Promise<Response> => {
    const startTime = performance.now()
    const url = args[0] as string
    const options = args[1] as RequestInit | undefined
    
    // 解析端点
    let endpoint: string
    try {
      const urlObj = new URL(url, window.location.origin)
      endpoint = urlObj.pathname
    } catch {
      endpoint = url
    }
    
    const method = options?.method || 'GET'
    
    try {
      const response = await fetchFn(...args)
      const duration = performance.now() - startTime
      
      apiMonitor.recordApiCall(
        endpoint,
        method,
        Math.round(duration),
        response.ok,
        response.status
      )
      
      return response
    } catch (error) {
      const duration = performance.now() - startTime
      
      apiMonitor.recordApiCall(
        endpoint,
        method,
        Math.round(duration),
        false
      )
      
      // 记录错误
      errorReporter.captureError(error as Error, {
        endpoint,
        method,
        action: 'api_call'
      })
      
      throw error
    }
  }) as T
}

/**
 * 启动监控系统
 */
export function startMonitoring(): void {
  // 启动错误自动上报
  errorReporter.startAutoFlush()
  
  // 定期清理旧数据
  setInterval(() => {
    apiMonitor.cleanup()
    errorReporter.clearReported()
  }, 60 * 60 * 1000) // 每小时清理一次
  
  console.log('[Monitor] Monitoring system started')
}

/**
 * 停止监控系统
 */
export function stopMonitoring(): void {
  errorReporter.stopAutoFlush()
  console.log('[Monitor] Monitoring system stopped')
}

// ==================== 导出类型 ====================

export type { ApiMonitor, ErrorReporter }