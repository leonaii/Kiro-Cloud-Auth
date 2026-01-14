
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
      return <CheckCircle className="h-5 w-5 text-green-500" />
    case 'warning':
      return <AlertCircle className="h-5 w-5 text-amber-500" />
    case 'critical':
      return <XCircle className="h-5 w-5 text-red-500" />
    default:
      return <Clock className="h-5 w-5 text-muted-foreground" />
  }
}

export function MonitoringPage(): React.ReactNode {
  const [healthData, setHealthData] = useState<HealthData | null>(null)
  const [performanceData, setPerformanceData] = useState<PerformanceData | null>(null)
  const [alertsData, setAlertsData] = useState<AlertsData | null>(null)
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
      const [healthRes, perfRes, alertsRes] = await Promise.all([
        fetchWithAuth(`${API_BASE}/monitoring/health`),
        fetchWithAuth(`${API_BASE}/monitoring/performance?timeRange=${timeRange}`),
        fetchWithAuth(`${API_BASE}/monitoring/alerts?limit=20`)
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
      <div className="flex-1 p-8 flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">加载监控数据...</p>
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 p-8 space-y-8 overflow-y-auto min-h-screen">
      {/* Header */}
      <div className="relative overflow-hidden rounded-2xl bg-background/40 backdrop-blur-xl border border-white/10 shadow-2xl p-8 group">
        <div className="absolute top-0 right-0 w-96 h-96 bg-primary/20 rounded-full blur-[100px] -translate-y-1/2 translate-x-1/2 opacity-30 group-hover:opacity-50 transition-opacity duration-700" />
        <div className="absolute bottom-0 left-0 w-64 h-64 bg-secondary/20 rounded-full blur-[80px] translate-y-1/2 -translate-x-1/2 opacity-30 group-hover:opacity-50 transition-opacity duration-700" />

        <div className="relative flex items-center justify-between z-10">
          <div className="flex items-center gap-6">
            <div className="relative group/logo">
              <div className="absolute inset-0 bg-primary/20 rounded-2xl blur-xl group-hover/logo:blur-2xl transition-all duration-500 opacity-0 group-hover/logo:opacity-100" />
              <div className="relative p-4 bg-primary/10 rounded-2xl">
                <BarChart3 className="h-12 w-12 text-primary" />
              </div>
            </div>
            <div className="space-y-2">
              <h1 className="text-4xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">
                系统监控
              </h1>
              <p className="text-lg text-muted-foreground font-medium max-w-2xl leading-relaxed">
                实时监控系统性能、告警和健康状态
              </p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* 时间范围选择 */}
            <select
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value as typeof timeRange)}
              className="px-4 py-2 text-sm border border-white/10 rounded-xl bg-black/20 focus:outline-none focus:ring-2 focus:ring-primary/20"
            >
              <option value="last_hour">最近1小时</option>
              <option value="last_24h">最近24小时</option>
              <option value="last_7d">最近7天</option>
            </select>

            {/* 自动刷新开关 */}
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={cn(
                "flex items-center gap-2 px-4 py-2 text-sm rounded-xl border transition-all",
                autoRefresh
                  ? "bg-primary/10 border-primary/20 text-primary"
                  : "bg-black/20 border-white/10 text-muted-foreground"
              )}
            >
              <RefreshCw className={cn("h-4 w-4", autoRefresh && "animate-spin")} />
              {autoRefresh ? '自动刷新' : '已暂停'}
            </button>

            {/* 手动刷新 */}
            <button
              onClick={fetchMonitoringData}
              className="p-2 rounded-xl bg-black/20 border border-white/10 hover:bg-white/5 transition-colors"
              title="刷新数据"
            >
              <RefreshCw className="h-5 w-5" />
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-500 flex items-center gap-2">
          <AlertTriangle className="h-5 w-5" />
          {error}
        </div>
      )}

      {/* 健康状态卡片 */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {/* 整体状态 */}
        <Card className={cn(
          "bg-background/40 backdrop-blur-md border-white/10 shadow-lg hover:shadow-xl transition-all duration-300",
          healthData && getStatusBgColor(healthData.overall)
        )}>
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className={cn(
                "p-4 rounded-2xl shadow-inner",
                healthData ? getStatusBgColor(healthData.overall) : 'bg-muted/10'
              )}>
                {healthData ? <StatusIcon status={healthData.overall} /> : <Clock className="h-6 w-6" />}
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">整体状态</p>
                <span className={cn(
                  "text-2xl font-bold tracking-tight capitalize",
                  healthData ? getStatusColor(healthData.overall) : ''
                )}>
                  {healthData?.overall === 'healthy' ? '健康' :
                   healthData?.overall === 'warning' ? '警告' :
                   healthData?.overall === 'critical' ? '严重' : '未知'}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 数据库状态 */}
        <Card className="bg-background/40 backdrop-blur-md border-white/10 shadow-lg hover:shadow-xl transition-all duration-300">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className={cn(
                "p-4 rounded-2xl shadow-inner",
                healthData?.components?.database ? getStatusBgColor(healthData.components.database.status) : 'bg-blue-500/10'
              )}>
                <Database className={cn(
                  "h-6 w-6",
                  healthData?.components?.database ? getStatusColor(healthData.components.database.status) : 'text-blue-500'
                )} />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">数据库</p>
                <div className="flex items-baseline gap-2">
                  <span className={cn(
                    "text-2xl font-bold tracking-tight capitalize",
                    healthData?.components?.database ? getStatusColor(healthData.components.database.status) : ''
                  )}>
                    {healthData?.components?.database?.status === 'healthy' ? '正常' :
                     healthData?.components?.database?.status === 'warning' ? '警告' :
                     healthData?.components?.database?.status === 'critical' ? '异常' : '未知'}
                  </span>
                  {healthData?.components?.database?.latency !== undefined && (
                    <span className="text-xs text-muted-foreground">
                      {healthData.components.database.latency}ms
                    </span>
                  )}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 账号池状态 */}
        <Card className="bg-background/40 backdrop-blur-md border-white/10 shadow-lg hover:shadow-xl transition-all duration-300">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className={cn(
                "p-4 rounded-2xl shadow-inner",
                healthData?.components?.accountPool ? getStatusBgColor(healthData.components.accountPool.status) : 'bg-purple-500/10'
              )}>
                <Server className={cn(
                  "h-6 w-6",
                  healthData?.components?.accountPool ? getStatusColor(healthData.components.accountPool.status) : 'text-purple-500'
                )} />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">账号池</p>
                <div className="flex items-baseline gap-2">
                  <span className={cn(
                    "text-2xl font-bold tracking-tight",
                    healthData?.components?.accountPool ? getStatusColor(healthData.components.accountPool.status) : ''
                  )}>
                    {healthData?.components?.accountPool?.availableAccounts ?? '--'}
                  </span>
                  <span className="text-xs text-muted-foreground">可用账号</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Token刷新状态 */}
        <Card className="bg-background/40 backdrop-blur-md border-white/10 shadow-lg hover:shadow-xl transition-all duration-300">
          <CardContent className="p-6">
            <div className="flex items-center gap-4">
              <div className={cn(
                "p-4 rounded-2xl shadow-inner",
                healthData?.components?.tokenRefresher ? getStatusBgColor(healthData.components.tokenRefresher.status) : 'bg-orange-500/10'
              )}>
                <Zap className={cn(
                  "h-6 w-6",
                  healthData?.components?.tokenRefresher ? getStatusColor(healthData.components.tokenRefresher.status) : 'text-orange-500'
                )} />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium text-muted-foreground">Token刷新</p>
                <div className="flex items-baseline gap-2">
                  <span className={cn(
                    "text-2xl font-bold tracking-tight",
                    healthData?.components?.tokenRefresher ? getStatusColor(healthData.components.tokenRefresher.status) : ''
                  )}>
                    {healthData?.components?.tokenRefresher?.successRate !== undefined
                      ? `${(healthData.components.tokenRefresher.successRate * 100).toFixed(1)}%`
                      : '--'}
                  </span>
                  <span className="text-xs text-muted-foreground">成功率</span>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* 左侧：性能指标 */}
        <div className="lg:col-span-7 space-y-8">
          {/* 后端性能指标 */}
          <Card className="bg-background/40 backdrop-blur-md border-white/10 shadow-lg">
            <CardHeader className="border-b border-white/5 pb-4">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <Activity className="h-4 w-4 text-primary" />
                后端性能指标
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/5">
                      <th className="text-left px-6 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">操作</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">平均</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">P50</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">P95</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">P99</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">成功率</th>
                      <th className="text-right px-6 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">调用次数</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {performanceData?.operations && performanceData.operations.length > 0 ? (
                      performanceData.operations.map((op, index) => (
                        <tr key={index} className="hover:bg-white/5 transition-colors">
                          <td className="px-6 py-4 text-sm font-medium text-foreground">{op.name}</td>
                          <td className="px-4 py-4 text-sm text-right font-mono text-muted-foreground">{formatDuration(op.avgDuration)}</td>
                          <td className="px-4 py-4 text-sm text-right font-mono text-muted-foreground">{formatDuration(op.p50)}</td>
                          <td className="px-4 py-4 text-sm text-right font-mono text-amber-500">{formatDuration(op.p95)}</td>
                          <td className="px-4 py-4 text-sm text-right font-mono text-red-500">{formatDuration(op.p99)}</td>
                          <td className="px-4 py-4 text-sm text-right">
                            <span className={cn(
                              "font-mono",
                              op.successRate >= 0.95 ? 'text-green-500' :
                              op.successRate >= 0.8 ? 'text-amber-500' : 'text-red-500'
                            )}>
                              {(op.successRate * 100).toFixed(1)}%
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm text-right font-mono text-muted-foreground">{op.totalCalls.toLocaleString()}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={7} className="px-6 py-8 text-center text-muted-foreground">
                          暂无性能数据
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          {/* 前端性能指标 */}
          <Card className="bg-background/40 backdrop-blur-md border-white/10 shadow-lg">
            <CardHeader className="border-b border-white/5 pb-4">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <TrendingUp className="h-4 w-4 text-primary" />
                前端API性能
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-white/10 bg-white/5">
                      <th className="text-left px-6 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">端点</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">平均延迟</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">P95延迟</th>
                      <th className="text-right px-4 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">错误率</th>
                      <th className="text-right px-6 py-3 text-xs font-semibold text-muted-foreground uppercase tracking-wider">调用次数</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {frontendMetrics.length > 0 ? (
                      frontendMetrics.map((metric, index) => (
                        <tr key={index} className="hover:bg-white/5 transition-colors">
                          <td className="px-6 py-4 text-sm font-medium text-foreground font-mono">{metric.endpoint}</td>
                          <td className="px-4 py-4 text-sm text-right font-mono text-muted-foreground">{formatDuration(metric.avgDuration)}</td>
                          <td className="px-4 py-4 text-sm text-right font-mono text-amber-500">{formatDuration(metric.p95Duration)}</td>
                          <td className="px-4 py-4 text-sm text-right">
                            <span className={cn(
                              "font-mono",
                              metric.errorRate <= 0.05 ? 'text-green-500' :
                              metric.errorRate <= 0.2 ? 'text-amber-500' : 'text-red-500'
                            )}>
                              {(metric.errorRate * 100).toFixed(1)}%
                            </span>
                          </td>
                          <td className="px-6 py-4 text-sm text-right font-mono text-muted-foreground">{metric.totalCalls}</td>
                        </tr>
                      ))
                    ) : (
                      <tr>
                        <td colSpan={5} className="px-6 py-8 text-center text-muted-foreground">
                          暂无前端API调用数据
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* 右侧：告警列表 */}
        <div className="lg:col-span-5 space-y-8">
          {/* 告警摘要 */}
          <div className="grid grid-cols-3 gap-4">
            <Card className="bg-background/40 backdrop-blur-md border-white/10 shadow-lg">
              <CardContent className="p-4 text-center">
                <div className="text-3xl font-bold text-foreground">{alertsData?.summary?.total ?? 0}</div>
                <div className="text-xs text-muted-foreground mt-1">总告警</div>
              </CardContent>
            </Card>
            <Card className="bg-red-500/10 border-red-500/20 shadow-lg">
              <CardContent className="p-4 text-center">
                <div className="text-3xl font-bold text-red-500">{alertsData?.summary?.critical ?? 0}</div>
                <div className="text-xs text-red-500/70 mt-1">严重</div>
              </CardContent>
            </Card>
            <Card className="bg-amber-500/10 border-amber-500/20 shadow-lg">
              <CardContent className="p-4 text-center">
                <div className="text-3xl font-bold text-amber-500">{alertsData?.summary?.warning ?? 0}</div>
                <div className="text-xs text-amber-500/70 mt-1">警告</div>
              </CardContent>
            </Card>
          </div>

          {/* 告警列表 */}
          <Card className="bg-background/40 backdrop-blur-md border-white/10 shadow-lg">
            <CardHeader className="border-b border-white/5 pb-4">
              <CardTitle className="flex items-center gap-2 text-base font-semibold">
                <AlertTriangle className="h-4 w-4 text-primary" />
                最近告警
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0 max-h-[400px] overflow-y-auto">
              {alertsData?.alerts && alertsData.alerts.length > 0 ? (
                <div className="divide-y divide-white/5">
                  {alertsData.alerts.map((alert) => (
                    <div
                      key={alert.id}
                      className={cn(
                        "p-4 hover:bg-white/5 transition-colors",
                        alert.resolved && "opacity-50"
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div className={cn(
                          "p-2 rounded-lg shrink-0",
                          alert.severity === 'critical' ? 'bg-red-500/10' : 'bg-amber-500/10'
                        )}>
                          {alert.severity === 'critical' ? (
                            <XCircle className="h-4 w-4 text-red-500" />
                          ) : (
                            <AlertCircle className="h-4 w-4 text-amber-500" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              "text-xs font-medium px-2 py-0.5 rounded-full",
                              alert.severity === 'critical' ? 'bg-red-500/10 text-red-500' : 'bg-amber-500/10 text-amber-500'
                            )}>
                              {alert.type}
                            </span>
                            {alert.resolved && (
                              <span className="text-xs text-green-500 bg-green-500/10 px-2 py-0.5 rounded-full">
                                已解决
                              </span>
                            )}
                          </div>
                          <p className="text-sm text-foreground mt-1">{alert.message}</p>
                          <div className="flex items-center gap-4 mt-2 text-xs text-muted-foreground">
                            <span>当前值: {alert.currentValue}</span>
                            <span>阈值: {alert.threshold}</span>
                            <span>{formatTimestamp(alert.timestamp)}</span>
                          </div>
                        </div>
                        {!alert.resolved && (
                          <button
                            onClick={() => resolveAlert(alert.id)}
                            className="text-xs text-primary hover:text-primary/80 px-2 py-1 rounded hover:bg-primary/10 transition-colors"
                          >
                            解决
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 text-center text-muted-foreground">
                  <CheckCircle className="h-12 w-12 mx-auto mb-4 text-green-500/50" />
                  <p>暂无告警</p>
                </div>
              )}
            </CardContent>
          </Card>

          {/* 前端错误日志 */}
          {frontendErrors.length > 0 && (
            <Card className="bg-background/40 backdrop-blur-md border-white/10 shadow-lg">
              <CardHeader className="border-b border-white/5 pb-4">
                <CardTitle className="flex items-center gap-2 text-base font-semibold">
                  <XCircle className="h-4 w-4 text-red-500" />
                  前端错误日志
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 max-h-[300px] overflow-y-auto">
                <div className="divide-y divide-white/5">
                  {frontendErrors.map((err, index) => (
                    <div key={index} className="p-4 hover:bg-white/5 transition-colors">
                      <div className="flex items-start gap-3">
                        <div className="p-2 rounded-lg bg-red-500/10 shrink-0">
                          <XCircle className="h-4 w-4 text-red-500" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-foreground truncate">{err.message}</p>
                          {err.context && (
                            <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                              {err.context.component && <span>组件: {err.context.component}</span>}
                              {err.context.action && <span>操作: {err.context.action}</span>}
                            </div>
                          )}
                          <div className="text-xs text-muted-foreground mt-1">
                            {formatTimestamp(err.timestamp)}
                          </div>
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