
import { useState, useEffect, useCallback } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '../ui'
import { 
  Activity, 
  AlertTriangle, 
  CheckCircle, 
  Clock, 
  Database, 
  RefreshCw, 
  Server, 
  TrendingUp,
  XCircle,
  AlertCircle,
  Zap,
  BarChart3
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { fetchWithAuth } from '@/lib/api'
import { apiMonitor, errorReporter } from '@/lib/monitor'

// 类型定义
interface PerformanceOperation {
  name: string
  avgDuration: number
  p50: number
  p95: number
  p99: number
  successRate: number
  totalCalls: number
}

interface Alert {
  id: string
  type: string
  severity: 'warning' | 'critical'
  message: string
  currentValue: number
  threshold: number
  timestamp: number
  resolved: boolean
}

interface AlertSummary {
  total: number
  critical: number
  warning: number
}

// 账号池状态类型
interface ActivePoolAccount {
  id: string
  email: string
  addedAt: number
  errorCount: number
  lastErrorAt: number | null
  usagePercent: number
  usageCurrent?: number
  usageLimit?: number
  lastError?: string
}

interface CoolingPoolAccount {
  id: string
  email: string
  coolingStartAt: number
  errorCount: number
  lastError: string
  remainingCoolingMs: number
}

interface AccountPoolData {
  activePool: {
    enabled: boolean
    initialized: boolean
    config: {
      limit: number
      errorThreshold: number
      coolingPeriodMs: number
    }
    activePool: {
      size: number
      limit: number
      accounts: ActivePoolAccount[]
    }
    coolingPool: {
      size: number
      accounts: CoolingPoolAccount[]
    }
    stats: {
      promotions: number
      demotions: number
      recoveries: number
      errors: number
    }
  }
  cache: {
    size: number
    expiry: number
    dbConnectionFailed: boolean
  }
  stats: {
    cacheHits: number
    cacheMisses: number
    dbErrors: number
    staleCacheUsed: number
    validationErrors: number
    dataRepairs: number
    incompleteAccounts: number
    healthScore: number
    lastHealthCheck: number | null
  }
  timestamp: number
}

interface ComponentHealth {
  status: 'healthy' | 'warning' | 'critical' | 'unknown'
  latency?: number
  availableAccounts?: number
  successRate?: number
  message?: string
}

interface HealthData {
  overall: 'healthy' | 'warning' | 'critical' | 'unknown'
  components: {
    database: ComponentHealth
    accountPool: ComponentHealth
    tokenRefresher: ComponentHealth
  }
  timestamp: number
}

interface PerformanceData {
  operations: PerformanceOperation[]
  timeRange: string
}

interface AlertsData {
  alerts: Alert[]
  summary: AlertSummary
}

// 动态获取 API Base URL
const getApiBase = (): string => {
  if (import.meta.env.VITE_API_BASE) {
    return import.meta.env.VITE_API_BASE
  }
  if (typeof window !== 'undefined' && (window as { __WEB_SERVER_URL__?: string }).__WEB_SERVER_URL__) {
    return (window as { __WEB_SERVER_URL__?: string }).__WEB_SERVER_URL__ + '/api'
  }
  return '/api'
}

// 格式化时间戳
function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
}

// 格式化持续时间
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`
  return `${(ms / 60000).toFixed(2)}m`
}

// 获取状态颜色
function getStatusColor(status: string): string {
  switch (status) {
    case 'healthy':
      return 'text-green-500'
    case 'warning':
      return 'text-amber-500'
    case 'critical':
      return 'text-red-500'
    default:
      return 'text-muted-foreground'
  }
}

// 获取状态背景色
function getStatusBgColor(status: string): string {
  switch (status) {
    case 'healthy':
      return 'bg-green-500/10 border-green-500/20'
    case 'warning':
      return 'bg-amber-500/10 border-amber-500/20'
    case 'critical':
      return 'bg-red-500/10 border-red-500/20'
    default:
      return 'bg-muted/10 border-muted/20'
  }
}

// 获取状态图标
function StatusIcon({ status }: { status: string }): React.ReactNode {
  switch (status) {
    case 'healthy':
      return <CheckCircle className="h-4 w-4 text-green-500" />
    case 'warning':
      return <AlertCircle className="h-4 w-4 text-amber-500" />
    case 'critical':
      return <XCircle className="h-4 w-4 text-red-500" />
    default:
      return <Clock className="h-4 w-4 text-muted-foreground" />
  }
}

// 获取使用量颜色
function getUsageColor(percent: number): string {
  if (percent >= 90) return 'text-red-500'
  if (percent >= 70) return 'text-amber-500'
  return 'text-green-500'
}

// 获取使用量背景色
function getUsageBgColor(percent: number): string {
  if (percent >= 90) return 'bg-red-500'
  if (percent >= 70) return 'bg-amber-500'
  return 'bg-green-500'
}

export function MonitoringPage(): React.ReactNode {
  const [healthData, setHealthData] = useState<HealthData | null>(null)
  const [performanceData, setPerformanceData] = useState<PerformanceData | null>(null)
  const [alertsData, setAlertsData] = useState<AlertsData | null>(null)
  const [accountPoolData, setAccountPoolData] = useState<AccountPoolData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [timeRange, setTimeRange] = useState<'last_hour' | 'last_24h' | 'last_7d'>('last_hour')
  const [autoRefresh, setAutoRefresh] = useState(true)

  // 获取前端监控数据
  const frontendMetrics = apiMonitor.getMetrics()
  const frontendErrors = errorReporter.getErrors(10)

  // 获取监控数据
  const fetchMonitoringData = useCallback(async () => {
    try {
      setError(null)
      const API_BASE = getApiBase()

      // 并行获取所有数据
      const [healthRes, perfRes, alertsRes, poolRes] = await Promise.all([
        fetchWithAuth(`${API_BASE}/monitoring/health`),
        fetchWithAuth(`${API_BASE}/monitoring/performance?timeRange=${timeRange}`),
        fetchWithAuth(`${API_BASE}/monitoring/alerts?limit=20`),
        fetchWithAuth(`${API_BASE}/monitoring/account-pool`)
      ])

      if (healthRes.ok) {
        const health = await healthRes.json()
        setHealthData(health.data || health)
      }

      if (perfRes.ok) {
        const perf = await perfRes.json()
        setPerformanceData(perf.data || perf)
      }

      if (alertsRes.ok) {
        const alerts = await alertsRes.json()
        setAlertsData(alerts.data || alerts)
      }

      if (poolRes.ok) {
        const pool = await poolRes.json()
        setAccountPoolData(pool.data || pool)
      }
    } catch (err) {
      console.error('Failed to fetch monitoring data:', err)
      setError('获取监控数据失败')
    } finally {
      setLoading(false)
    }
  }, [timeRange])

  // 初始加载和自动刷新
  useEffect(() => {
    fetchMonitoringData()

    if (autoRefresh) {
      const interval = setInterval(fetchMonitoringData, 30000) // 每30秒刷新
      return () => clearInterval(interval)
    }
  }, [fetchMonitoringData, autoRefresh])

  // 解决告警
  const resolveAlert = async (alertId: string) => {
    try {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/monitoring/alerts/${alertId}/resolve`, {
        method: 'POST'
      })
      if (res.ok) {
        // 刷新告警数据
        fetchMonitoringData()
      }
    } catch (err) {
      console.error('Failed to resolve alert:', err)
    }
  }

  if (loading) {
    return (
      <div className="flex-1 p-4 flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-3 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-3" />
          <p className="text-sm text-muted-foreground">加载监控数据...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 p-4 space-y-3 overflow-y-auto h-screen">
      {/* Header - 紧凑版 */}
      <div className="relative overflow-hidden rounded-xl bg-background/40 backdrop-blur-xl border border-white/10 shadow-md p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-primary/10 rounded-lg">
              <BarChart3 className="h-6 w-6 text-primary" />
            </div>
            <div>
              <h1 className="text-xl font-bold">系统监控</h1>
              <p className="text-xs text-muted-foreground">实时监控系统性能和健康状态</p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <select
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value as typeof timeRange)}
              className="px-2 py-1 text-xs border border-white/10 rounded-md bg-black/20 focus:outline-none"
            >
              <option value="last_hour">1小时</option>
              <option value="last_24h">24小时</option>
              <option value="last_7d">7天</option>
            </select>

            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={cn(
                "flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-all",
                autoRefresh
                  ? "bg-primary/10 border-primary/20 text-primary"
                  : "bg-black/20 border-white/10 text-muted-foreground"
              )}
            >
              <RefreshCw className={cn("h-3 w-3", autoRefresh && "animate-spin")} />
              {autoRefresh ? '自动' : '暂停'}
            </button>

            <button
              onClick={fetchMonitoringData}
              className="p-1 rounded-md bg-black/20 border border-white/10 hover:bg-white/5"
              title="刷新"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-2 bg-red-500/10 border border-red-500/20 rounded-lg text-red-500 text-xs flex items-center gap-2">
          <AlertTriangle className="h-3.5 w-3.5" />
          {error}
        </div>
      )}

      {/* 健康状态卡片 - 紧凑版 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        {/* 整体状态 */}
        <Card className={cn(
          "bg-background/40 backdrop-blur-md border-white/10",
          healthData && getStatusBgColor(healthData.overall)
        )}>
          <CardContent className="p-2.5">
            <div className="flex items-center gap-2">
              <div className={cn("p-1.5 rounded-lg", healthData ? getStatusBgColor(healthData.overall) : 'bg-muted/10')}>
                {healthData ? <StatusIcon status={healthData.overall} /> : <Clock className="h-4 w-4" />}
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">整体状态</p>
                <span className={cn("text-sm font-bold", healthData ? getStatusColor(healthData.overall) : '')}>
                  {healthData?.overall === 'healthy' ? '健康' :
                   healthData?.overall === 'warning' ? '警告' :
                   healthData?.overall === 'critical' ? '严重' : '未知'}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 数据库状态 */}
        <Card className="bg-background/40 backdrop-blur-md border-white/10">
          <CardContent className="p-2.5">
            <div className="flex items-center gap-2">
              <div className={cn("p-1.5 rounded-lg", healthData?.components?.database ? getStatusBgColor(healthData.components.database.status) : 'bg-blue-500/10')}>
                <Database className={cn("h-4 w-4", healthData?.components?.database ? getStatusColor(healthData.components.database.status) : 'text-blue-500')} />
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">数据库</p>
                <div className="flex items-baseline gap-1">
                  <span className={cn("text-sm font-bold", healthData?.components?.database ? getStatusColor(healthData.components.database.status) : '')}>
                    {healthData?.components?.database?.status === 'healthy' ? '正常' :
                     healthData?.components?.database?.status === 'warning' ? '警告' :
                     healthData?.components?.database?.status === 'critical' ? '异常' : '未知'}
                  </span>
                  {healthData?.components?.database?.latency !== undefined && (
                    <span className="text-[9px] text-muted-foreground">{healthData.components.database.latency}ms</span>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 账号池状态 */}
        <Card className="bg-background/40 backdrop-blur-md border-white/10">
          <CardContent className="p-2.5">
            <div className="flex items-center gap-2">
              <div className={cn("p-1.5 rounded-lg", healthData?.components?.accountPool ? getStatusBgColor(healthData.components.accountPool.status) : 'bg-purple-500/10')}>
                <Server className={cn("h-4 w-4", healthData?.components?.accountPool ? getStatusColor(healthData.components.accountPool.status) : 'text-purple-500')} />
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">账号池</p>
                <div className="flex items-baseline gap-1">
                  <span className={cn("text-sm font-bold", healthData?.components?.accountPool ? getStatusColor(healthData.components.accountPool.status) : '')}>
                    {healthData?.components?.accountPool?.availableAccounts ?? '--'}
                  </span>
                  <span className="text-[9px] text-muted-foreground">可用</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Token刷新状态 */}
        <Card className="bg-background/40 backdrop-blur-md border-white/10">
          <CardContent className="p-2.5">
            <div className="flex items-center gap-2">
              <div className={cn("p-1.5 rounded-lg", healthData?.components?.tokenRefresher ? getStatusBgColor(healthData.components.tokenRefresher.status) : 'bg-orange-500/10')}>
                <Zap className={cn("h-4 w-4", healthData?.components?.tokenRefresher ? getStatusColor(healthData.components.tokenRefresher.status) : 'text-orange-500')} />
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">Token刷新</p>
                <div className="flex items-baseline gap-1">
                  <span className={cn("text-sm font-bold", healthData?.components?.tokenRefresher ? getStatusColor(healthData.components.tokenRefresher.status) : '')}>
                    {healthData?.components?.tokenRefresher?.successRate !== undefined
                      ? `${(healthData.components.tokenRefresher.successRate * 100).toFixed(0)}%`
                      : '--'}
                  </span>
                  <span className="text-[9px] text-muted-foreground">成功率</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-3">
        {/* 左侧：性能指标 */}
        <div className="lg:col-span-7 space-y-3">
          {/* 后端性能指标 */}
          <Card className="bg-background/40 backdrop-blur-md border-white/10">
            <CardHeader className="border-b border-white/5 py-2 px-3">
              <CardTitle className="flex items-center gap-1.5 text-xs font-semibold">
                <Activity className="h-3.5 w-3.5 text-primary" />
                后端性能指标
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 max-h-[180px] overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-background/95 backdrop-blur-sm">
                  <tr className="border-b border-white/10">
                    <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">操作</th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">平均</th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">P95</th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">成功率</th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">调用</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {performanceData?.operations && performanceData.operations.length > 0 ? (
                    performanceData.operations.map((op, index) => (
                      <tr key={index} className="hover:bg-white/5">
                        <td className="px-2 py-1.5 font-medium">{op.name}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{formatDuration(op.avgDuration)}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-amber-500">{formatDuration(op.p95)}</td>
                        <td className="px-2 py-1.5 text-right">
                          <span className={cn("font-mono", op.successRate >= 0.95 ? 'text-green-500' : op.successRate >= 0.8 ? 'text-amber-500' : 'text-red-500')}>
                            {(op.successRate * 100).toFixed(0)}%
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{op.totalCalls.toLocaleString()}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="px-2 py-4 text-center text-muted-foreground">暂无数据</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>

          {/* 前端性能指标 */}
          <Card className="bg-background/40 backdrop-blur-md border-white/10">
            <CardHeader className="border-b border-white/5 py-2 px-3">
              <CardTitle className="flex items-center gap-1.5 text-xs font-semibold">
                <TrendingUp className="h-3.5 w-3.5 text-primary" />
                前端API性能
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 max-h-[150px] overflow-y-auto">
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-background/95 backdrop-blur-sm">
                  <tr className="border-b border-white/10">
                    <th className="text-left px-2 py-1.5 font-medium text-muted-foreground">端点</th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">平均</th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">P95</th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">错误率</th>
                    <th className="text-right px-2 py-1.5 font-medium text-muted-foreground">调用</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5">
                  {frontendMetrics.length > 0 ? (
                    frontendMetrics.map((metric, index) => (
                      <tr key={index} className="hover:bg-white/5">
                        <td className="px-2 py-1.5 font-mono truncate max-w-[120px]">{metric.endpoint}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{formatDuration(metric.avgDuration)}</td>
                        <td className="px-2 py-1.5 text-right font-mono text-amber-500">{formatDuration(metric.p95Duration)}</td>
                        <td className="px-2 py-1.5 text-right">
                          <span className={cn("font-mono", metric.errorRate <= 0.05 ? 'text-green-500' : metric.errorRate <= 0.2 ? 'text-amber-500' : 'text-red-500')}>
                            {(metric.errorRate * 100).toFixed(0)}%
                          </span>
                        </td>
                        <td className="px-2 py-1.5 text-right font-mono text-muted-foreground">{metric.totalCalls}</td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan={5} className="px-2 py-4 text-center text-muted-foreground">暂无数据</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>

        {/* 右侧：告警和账号池 */}
        <div className="lg:col-span-5 space-y-3">
          {/* 告警摘要 */}
          <div className="grid grid-cols-3 gap-2">
            <Card className="bg-background/40 backdrop-blur-md border-white/10">
              <CardContent className="p-2 text-center">
                <div className="text-xl font-bold">{alertsData?.summary?.total ?? 0}</div>
                <div className="text-[10px] text-muted-foreground">总告警</div>
              </CardContent>
            </Card>
            <Card className="bg-red-500/10 border-red-500/20">
              <CardContent className="p-2 text-center">
                <div className="text-xl font-bold text-red-500">{alertsData?.summary?.critical ?? 0}</div>
                <div className="text-[10px] text-red-500/70">严重</div>
              </CardContent>
            </Card>
            <Card className="bg-amber-500/10 border-amber-500/20">
              <CardContent className="p-2 text-center">
                <div className="text-xl font-bold text-amber-500">{alertsData?.summary?.warning ?? 0}</div>
                <div className="text-[10px] text-amber-500/70">警告</div>
              </CardContent>
            </Card>
          </div>

          {/* 告警列表 */}
          <Card className="bg-background/40 backdrop-blur-md border-white/10">
            <CardHeader className="border-b border-white/5 py-2 px-3">
              <CardTitle className="flex items-center gap-1.5 text-xs font-semibold">
                <AlertTriangle className="h-3.5 w-3.5 text-primary" />
                最近告警
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 max-h-[150px] overflow-y-auto">
              {alertsData?.alerts && alertsData.alerts.length > 0 ? (
                <div className="divide-y divide-white/5">
                  {alertsData.alerts.slice(0, 5).map((alert) => (
                    <div key={alert.id} className={cn("p-2 hover:bg-white/5", alert.resolved && "opacity-50")}>
                      <div className="flex items-start gap-2">
                        <div className={cn("p-1 rounded shrink-0", alert.severity === 'critical' ? 'bg-red-500/10' : 'bg-amber-500/10')}>
                          {alert.severity === 'critical' ? <XCircle className="h-3 w-3 text-red-500" /> : <AlertCircle className="h-3 w-3 text-amber-500" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1">
                            <span className={cn("text-[10px] font-medium px-1 py-0.5 rounded", alert.severity === 'critical' ? 'bg-red-500/10 text-red-500' : 'bg-amber-500/10 text-amber-500')}>
                              {alert.type}
                            </span>
                            {alert.resolved && <span className="text-[10px] text-green-500 bg-green-500/10 px-1 py-0.5 rounded">已解决</span>}
                          </div>
                          <p className="text-[11px] text-foreground mt-0.5 truncate">{alert.message}</p>
                          <div className="text-[9px] text-muted-foreground mt-0.5">{formatTimestamp(alert.timestamp)}</div>
                        </div>
                        {!alert.resolved && (
                          <button onClick={() => resolveAlert(alert.id)} className="text-[10px] text-primary hover:text-primary/80 px-1 py-0.5 rounded hover:bg-primary/10">
                            解决
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-4 text-center text-muted-foreground">
                  <CheckCircle className="h-8 w-8 mx-auto mb-2 text-green-500/50" />
                  <p className="text-xs">暂无告警</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 账号池详细状态 - 改进版 */}
          {accountPoolData && (
            <Card className="bg-background/40 backdrop-blur-md border-white/10">
              <CardHeader className="border-b border-white/5 py-2 px-3">
                <CardTitle className="flex items-center gap-1.5 text-xs font-semibold">
                  <Server className="h-3.5 w-3.5 text-primary" />
                  账号池状态
                  {accountPoolData.activePool?.enabled ? (
                    <span className="text-[9px] bg-green-500/10 text-green-500 px-1 py-0.5 rounded">启用</span>
                  ) : (
                    <span className="text-[9px] bg-muted/10 text-muted-foreground px-1 py-0.5 rounded">禁用</span>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent className="p-2 space-y-2 max-h-[280px] overflow-y-auto">
                {/* 活跃池 */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium">活跃池</span>
                    <span className="text-[10px] text-muted-foreground">
                      {accountPoolData.activePool?.activePool?.size ?? 0} / {accountPoolData.activePool?.activePool?.limit ?? 0}
                    </span>
                  </div>
                  <div className="w-full bg-muted/20 rounded-full h-1.5">
                    <div
                      className="bg-green-500 h-1.5 rounded-full transition-all"
                      style={{
                        width: `${accountPoolData.activePool?.activePool?.limit
                          ? (accountPoolData.activePool.activePool.size / accountPoolData.activePool.activePool.limit) * 100
                          : 0}%`
                      }}
                    />
                  </div>
                  {accountPoolData.activePool?.activePool?.accounts && accountPoolData.activePool.activePool.accounts.length > 0 && (
                    <div className="space-y-1">
                      {accountPoolData.activePool.activePool.accounts.map((acc) => (
                        <div key={acc.id} className={cn(
                          "flex items-center justify-between text-[10px] p-1.5 rounded-md",
                          acc.errorCount > 0 ? "bg-red-500/5 border border-red-500/20" : "bg-white/5"
                        )}>
                          <div className="flex-1 min-w-0">
                            <span className="text-foreground truncate block max-w-[100px]" title={acc.email}>{acc.email}</span>
                            {acc.lastError && (
                              <span className="text-[9px] text-red-400 truncate block" title={acc.lastError}>
                                {acc.lastError.substring(0, 30)}...
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            {/* 使用量显示 */}
                            <div className="flex items-center gap-0.5">
                              <div className="w-12 bg-muted/30 rounded-full h-1">
                                <div
                                  className={cn("h-1 rounded-full", getUsageBgColor(acc.usagePercent ?? 0))}
                                  style={{ width: `${Math.min(acc.usagePercent ?? 0, 100)}%` }}
                                />
                              </div>
                              <span className={cn("text-[9px] font-mono w-8 text-right", getUsageColor(acc.usagePercent ?? 0))}>
                                {(acc.usagePercent ?? 0).toFixed(0)}%
                              </span>
                            </div>
                            {/* 错误计数 */}
                            <span className={cn(
                              "px-1 py-0.5 rounded text-[9px] font-medium",
                              acc.errorCount > 0 ? 'bg-red-500/10 text-red-500' : 'bg-green-500/10 text-green-500'
                            )}>
                              {acc.errorCount > 0 ? `错误:${acc.errorCount}` : '正常'}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* 冷却池 */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] font-medium">冷却池</span>
                    <span className="text-[10px] text-muted-foreground">
                      {accountPoolData.activePool?.coolingPool?.size ?? 0} 个
                    </span>
                  </div>
                  {accountPoolData.activePool?.coolingPool?.accounts && accountPoolData.activePool.coolingPool.accounts.length > 0 ? (
                    <div className="space-y-1">
                      {accountPoolData.activePool.coolingPool.accounts.map((acc) => (
                        <div key={acc.id} className="flex items-center justify-between text-[10px] p-1.5 bg-amber-500/5 rounded-md border border-amber-500/20">
                          <div className="flex-1 min-w-0">
                            <span className="text-foreground truncate block max-w-[100px]" title={acc.email}>{acc.email}</span>
                            <span className="text-[9px] text-red-400 truncate block" title={acc.lastError}>
                              {acc.lastError?.substring(0, 40)}...
                            </span>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <span className="text-amber-500 text-[9px]">
                              {Math.ceil((acc.remainingCoolingMs || 0) / 60000)}分钟
                            </span>
                            <span className="bg-red-500/10 text-red-500 px-1 py-0.5 rounded text-[9px]">
                              错误:{acc.errorCount}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-[10px] text-muted-foreground text-center py-1">无冷却账号</div>
                  )}
                </div>

                {/* 统计信息 */}
                <div className="grid grid-cols-4 gap-1 pt-1.5 border-t border-white/5">
                  <div className="text-center p-1 bg-white/5 rounded">
                    <div className="text-sm font-bold text-green-500">{accountPoolData.activePool?.stats?.promotions ?? 0}</div>
                    <div className="text-[9px] text-muted-foreground">晋升</div>
                  </div>
                  <div className="text-center p-1 bg-white/5 rounded">
                    <div className="text-sm font-bold text-amber-500">{accountPoolData.activePool?.stats?.demotions ?? 0}</div>
                    <div className="text-[9px] text-muted-foreground">降级</div>
                  </div>
                  <div className="text-center p-1 bg-white/5 rounded">
                    <div className="text-sm font-bold text-blue-500">{accountPoolData.activePool?.stats?.recoveries ?? 0}</div>
                    <div className="text-[9px] text-muted-foreground">恢复</div>
                  </div>
                  <div className="text-center p-1 bg-white/5 rounded">
                    <div className="text-sm font-bold text-red-500">{accountPoolData.activePool?.stats?.errors ?? 0}</div>
                    <div className="text-[9px] text-muted-foreground">错误</div>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {/* 前端错误日志 */}
          {frontendErrors.length > 0 && (
            <Card className="bg-background/40 backdrop-blur-md border-white/10">
              <CardHeader className="border-b border-white/5 py-2 px-3">
                <CardTitle className="flex items-center gap-1.5 text-xs font-semibold">
                  <XCircle className="h-3.5 w-3.5 text-red-500" />
                  前端错误日志
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 max-h-[120px] overflow-y-auto">
                <div className="divide-y divide-white/5">
                  {frontendErrors.slice(0, 5).map((err, index) => (
                    <div key={index} className="p-2 hover:bg-white/5">
                      <div className="flex items-start gap-2">
                        <div className="p-1 rounded bg-red-500/10 shrink-0">
                          <XCircle className="h-3 w-3 text-red-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-[11px] font-medium truncate">{err.message}</p>
                          {err.context && (
                            <div className="flex items-center gap-2 mt-0.5 text-[9px] text-muted-foreground">
                              {err.context.component && <span>组件: {err.context.component}</span>}
                              {err.context.action && <span>操作: {err.context.action}</span>}
                            </div>
                          )}
                          <div className="text-[9px] text-muted-foreground mt-0.5">{formatTimestamp(err.timestamp)}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}