import { useState, useEffect, useCallback, useRef } from 'react'
import { Button, Badge } from '../ui'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  RefreshCw,
  Loader2,
  CheckCircle,
  XCircle,
  AlertTriangle,
  Info,
  Zap,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Filter,
  X,
  Server,
  Database,
  Key,
  Trash2,
  Activity
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMobile } from '@/hooks/use-mobile'
import { fetchWithAuth } from '@/lib/api'

interface LogEntry {
  id: string
  type: string
  level: 'info' | 'warn' | 'error' | 'success'
  action: string
  message: string
  details: Record<string, unknown> | null
  account_id: string | null
  account_email: string | null
  account_idp: string | null
  duration_ms: number | null
  server_id: string | null
  request_headers: Record<string, string> | null
  created_at: string
}

interface LogStats {
  total: number
  successCount: number
  errorCount: number
  warnCount: number
  infoCount: number
  byType: Array<{ type: string; count: number; success: number; errors: number }>
  hourly: Array<{ hour: string; count: number; success: number; errors: number }>
  recentErrors: Array<{
    type: string
    action: string
    message: string
    account_email: string | null
    created_at: string
  }>
}

interface Pagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

const LOG_TYPES = {
  token_refresh: { label: 'Token刷新', icon: Key, color: 'blue' },
  account_pool: { label: '账号池', icon: Database, color: 'purple' },
  cleanup: { label: '清理任务', icon: Trash2, color: 'orange' },
  system: { label: '系统', icon: Zap, color: 'gray' }
}

const LOG_LEVELS = {
  success: { label: '成功', icon: CheckCircle, color: 'green' },
  error: { label: '错误', icon: XCircle, color: 'rose' },
  warn: { label: '警告', icon: AlertTriangle, color: 'amber' },
  info: { label: '信息', icon: Info, color: 'blue' }
}

const IDP_COLORS: Record<string, string> = {
  Google: 'bg-blue-500',
  BuilderId: 'bg-orange-500',
  Github: 'bg-gray-700'
}

function getApiBase(): string {
  if (import.meta.env.VITE_API_BASE) {
    return import.meta.env.VITE_API_BASE
  }
  return '/api'
}

export function SystemLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [stats, setStats] = useState<LogStats | null>(null)
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    pageSize: 20,
    total: 0,
    totalPages: 0
  })
  const [loading, setLoading] = useState(false)
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const [isPageChanging, setIsPageChanging] = useState(false)
  const [statsLoading, setStatsLoading] = useState(false)
  const [typeFilter, setTypeFilter] = useState<string>('')
  const [levelFilter, setLevelFilter] = useState<string>('')
  const [serverFilter, setServerFilter] = useState<string>('')
  const [serverIds, setServerIds] = useState<string[]>([])
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null)
  const [showFilterSheet, setShowFilterSheet] = useState(false)

  const requestIdRef = useRef(0)
  const abortControllerRef = useRef<AbortController | null>(null)

  const apiBase = getApiBase()
  const isMobile = useMobile()

  const fetchServerIds = useCallback(async () => {
    try {
      const res = await fetchWithAuth(`${apiBase}/server-ids`)
      const data = await res.json()
      setServerIds(data.serverIds || [])
    } catch (error) {
      console.error('Failed to fetch server ids:', error)
    }
  }, [apiBase])

  const fetchLogs = useCallback(
    async (page: number, isPageChange = false) => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort()
      }

      const abortController = new AbortController()
      abortControllerRef.current = abortController
      const currentRequestId = ++requestIdRef.current

      if (isPageChange) {
        setIsPageChanging(true)
      } else if (isInitialLoad) {
        setLoading(true)
      }

      try {
        const params = new URLSearchParams({
          page: page.toString(),
          pageSize: pagination.pageSize.toString()
        })
        if (typeFilter) params.append('type', typeFilter)
        if (levelFilter) params.append('level', levelFilter)
        if (serverFilter) params.append('serverId', serverFilter)

        const res = await fetchWithAuth(`${apiBase}/system-logs?${params}`, {
          signal: abortController.signal
        })

        if (currentRequestId !== requestIdRef.current) return

        const data = await res.json()
        setLogs(data.data || [])
        setPagination((prev) => ({
          ...prev,
          page: data.pagination?.page || page,
          pageSize: data.pagination?.pageSize || prev.pageSize,
          total: data.pagination?.total || 0,
          totalPages: data.pagination?.totalPages || 0
        }))

        if (isInitialLoad) setIsInitialLoad(false)
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return
        console.error('Failed to fetch system logs:', error)
      } finally {
        if (currentRequestId === requestIdRef.current) {
          setLoading(false)
          setIsPageChanging(false)
        }
      }
    },
    [apiBase, pagination.pageSize, typeFilter, levelFilter, serverFilter, isInitialLoad]
  )

  const fetchStats = useCallback(async () => {
    setStatsLoading(true)
    try {
      const res = await fetchWithAuth(`${apiBase}/system-logs/stats`)
      const data = await res.json()
      setStats(data)
    } catch (error) {
      console.error('Failed to fetch system stats:', error)
    } finally {
      setStatsLoading(false)
    }
  }, [apiBase])

  useEffect(() => {
    fetchServerIds()
    fetchStats()
    fetchLogs(1)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isInitialLoad) fetchLogs(1)
  }, [typeFilter, levelFilter, serverFilter]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleRefresh = () => {
    fetchLogs(pagination.page)
    fetchStats()
  }

  const handlePageChange = (newPage: number) => {
    if (isPageChanging || loading) return
    if (newPage < 1 || newPage > pagination.totalPages) return
    fetchLogs(newPage, true)
  }

  const formatTime = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  const handleClearLogs = async () => {
    if (!confirm('确定要清空所有系统日志吗？')) return
    try {
      await fetchWithAuth(`${apiBase}/system-logs`, { method: 'DELETE' })
      handleRefresh()
    } catch (e) {
      console.error('Failed to clear logs:', e)
    }
  }

  return (
    <div className="flex flex-col h-full max-h-full bg-background overflow-hidden">
      <div className="px-4 md:px-6 py-3 border-b bg-card/50 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 text-primary shadow-sm">
              <Activity className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">系统日志</h1>
              <p className="text-xs text-muted-foreground mt-0.5">
                系统操作记录（保留近 24 小时）
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleClearLogs} disabled={loading}>
              <Trash2 className="h-4 w-4 mr-2" />
              清空
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={loading || isPageChanging}
            >
              <RefreshCw
                className={cn('h-4 w-4 mr-2', (loading || isPageChanging) && 'animate-spin')}
              />
              刷新
            </Button>
          </div>
        </div>
      </div>

      <div className={cn('border-b bg-muted/20 shrink-0', isMobile ? 'px-3 py-3' : 'px-6 py-4')}>
        <div className={cn('grid gap-3', isMobile ? 'grid-cols-2' : 'grid-cols-5 gap-4')}>
          <StatCard
            icon={<Zap className="h-5 w-5" />}
            label="总日志"
            value={stats?.overview?.total ?? 0}
            loading={statsLoading}
          />
          <StatCard
            icon={<CheckCircle className="h-5 w-5 text-green-500" />}
            label="成功"
            value={stats?.overview?.successCount ?? 0}
            loading={statsLoading}
            color="green"
          />
          <StatCard
            icon={<XCircle className="h-5 w-5 text-rose-500" />}
            label="错误"
            value={stats?.overview?.errorCount ?? 0}
            loading={statsLoading}
            color="rose"
          />
          <StatCard
            icon={<AlertTriangle className="h-5 w-5 text-amber-500" />}
            label="警告"
            value={stats?.overview?.warnCount ?? 0}
            loading={statsLoading}
            color="amber"
          />
          <StatCard
            icon={<Info className="h-5 w-5 text-blue-500" />}
            label="信息"
            value={stats?.overview?.infoCount ?? 0}
            loading={statsLoading}
            color="blue"
          />
        </div>
      </div>

      <div className={cn('border-b bg-card/30 shrink-0', isMobile ? 'px-3 py-2' : 'px-6 py-3')}>
        {isMobile ? (
          <div className="flex items-center justify-between">
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => setShowFilterSheet(true)}
            >
              <Filter className="h-4 w-4" />
              筛选
              {(typeFilter || levelFilter || serverFilter) && (
                <Badge className="h-5 px-1.5 text-xs bg-primary">
                  {[typeFilter, levelFilter, serverFilter].filter(Boolean).length}
                </Badge>
              )}
            </Button>
            <span className="text-xs text-muted-foreground">{pagination.total} 条</span>
          </div>
        ) : (
          <div className="flex items-center gap-4">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">类型:</span>
              <select
                className="h-8 px-2 text-sm border rounded-lg bg-background"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value)}
              >
                <option value="">全部</option>
                {Object.entries(LOG_TYPES).map(([key, { label }]) => (
                  <option key={key} value={key}>
                    {label}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">级别:</span>
              <div className="flex items-center gap-1">
                {['', 'success', 'error', 'warn', 'info'].map((level) => (
                  <button
                    key={level}
                    className={cn(
                      'px-2 py-1 text-xs rounded-md transition-colors',
                      levelFilter === level
                        ? level === 'success'
                          ? 'bg-green-500 text-white'
                          : level === 'error'
                            ? 'bg-rose-500 text-white'
                            : level === 'warn'
                              ? 'bg-amber-500 text-white'
                              : level === 'info'
                                ? 'bg-blue-500 text-white'
                                : 'bg-primary text-primary-foreground'
                        : 'bg-muted hover:bg-muted/80'
                    )}
                    onClick={() => setLevelFilter(level)}
                  >
                    {level === '' ? '全部' : LOG_LEVELS[level as keyof typeof LOG_LEVELS]?.label}
                  </button>
                ))}
              </div>
            </div>
            {serverIds.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">服务器:</span>
                <select
                  className="h-8 px-2 text-sm border rounded-lg bg-background"
                  value={serverFilter}
                  onChange={(e) => setServerFilter(e.target.value)}
                >
                  <option value="">全部</option>
                  {serverIds.map((id) => (
                    <option key={id} value={id}>
                      {id}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="flex-1" />
            <span className="text-sm text-muted-foreground">共 {pagination.total} 条记录</span>
          </div>
        )}
      </div>

      {isMobile && (
        <Sheet open={showFilterSheet} onOpenChange={setShowFilterSheet}>
          <SheetContent side="bottom" className="h-auto rounded-t-xl">
            <SheetHeader>
              <SheetTitle>筛选条件</SheetTitle>
            </SheetHeader>
            <div className="py-4 space-y-4">
              <div className="space-y-2">
                <span className="text-sm font-medium">类型</span>
                <select
                  className="w-full h-10 px-3 text-sm border rounded-lg bg-background"
                  value={typeFilter}
                  onChange={(e) => setTypeFilter(e.target.value)}
                >
                  <option value="">全部</option>
                  {Object.entries(LOG_TYPES).map(([key, { label }]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <span className="text-sm font-medium">级别</span>
                <div className="flex flex-wrap gap-2">
                  {['', 'success', 'error', 'warn', 'info'].map((level) => (
                    <button
                      key={level}
                      className={cn(
                        'px-3 py-2 text-sm rounded-lg transition-colors',
                        levelFilter === level
                          ? level === 'success'
                            ? 'bg-green-500 text-white'
                            : level === 'error'
                              ? 'bg-rose-500 text-white'
                              : level === 'warn'
                                ? 'bg-amber-500 text-white'
                                : level === 'info'
                                  ? 'bg-blue-500 text-white'
                                  : 'bg-primary text-primary-foreground'
                          : 'bg-muted hover:bg-muted/80'
                      )}
                      onClick={() => setLevelFilter(level)}
                    >
                      {level === '' ? '全部' : LOG_LEVELS[level as keyof typeof LOG_LEVELS]?.label}
                    </button>
                  ))}
                </div>
              </div>
              {serverIds.length > 0 && (
                <div className="space-y-2">
                  <span className="text-sm font-medium">服务器</span>
                  <select
                    className="w-full h-10 px-3 text-sm border rounded-lg bg-background"
                    value={serverFilter}
                    onChange={(e) => setServerFilter(e.target.value)}
                  >
                    <option value="">全部</option>
                    {serverIds.map((id) => (
                      <option key={id} value={id}>
                        {id}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <Button className="w-full" onClick={() => setShowFilterSheet(false)}>
                确定
              </Button>
            </div>
          </SheetContent>
        </Sheet>
      )}

      <div
        className={cn('flex-1 overflow-auto relative', isMobile ? 'px-3 py-3' : 'px-6 py-4')}
      >
        {loading && isInitialLoad ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Server className="h-12 w-12 mb-4 opacity-50" />
            <p>暂无系统日志</p>
          </div>
        ) : (
          <>
            {isPageChanging && (
              <div className="absolute top-0 left-0 right-0 z-10 flex justify-center py-2 bg-gradient-to-b from-background/80 to-transparent">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/10 rounded-full text-sm text-primary">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>加载中...</span>
                </div>
              </div>
            )}
            <div
              className={cn(
                'space-y-2 transition-opacity duration-200',
                isPageChanging && 'opacity-60'
              )}
            >
              {logs.map((log) => (
                <LogItem
                  key={log.id}
                  log={log}
                  onClick={() => setSelectedLog(log)}
                  formatTime={formatTime}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {pagination.totalPages > 1 && (
        <PaginationBar
          page={pagination.page}
          totalPages={pagination.totalPages}
          isLoading={isPageChanging || loading}
          onPageChange={handlePageChange}
          isMobile={isMobile}
        />
      )}

      {selectedLog && (
        <LogDetailModal
          log={selectedLog}
          onClose={() => setSelectedLog(null)}
          isMobile={isMobile}
        />
      )}
    </div>
  )
}

function PaginationBar({
  page,
  totalPages,
  isLoading,
  onPageChange,
  isMobile
}: {
  page: number
  totalPages: number
  isLoading: boolean
  onPageChange: (page: number) => void
  isMobile: boolean
}) {
  const [jumpPage, setJumpPage] = useState('')
  const [showJumpSheet, setShowJumpSheet] = useState(false)

  const handleJump = () => {
    const p = parseInt(jumpPage, 10)
    if (!isNaN(p) && p >= 1 && p <= totalPages && p !== page) {
      onPageChange(p)
      setJumpPage('')
      setShowJumpSheet(false)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleJump()
    else if (e.key === 'Escape') {
      setShowJumpSheet(false)
      setJumpPage('')
    }
  }

  if (isMobile) {
    return (
      <div className="px-4 py-3 border-t bg-card/30 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={page <= 1 || isLoading}
              onClick={() => onPageChange(1)}
            >
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={page <= 1 || isLoading}
              onClick={() => onPageChange(page - 1)}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
          <button
            className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-muted/50 transition-colors"
            onClick={() => setShowJumpSheet(true)}
          >
            <span className="text-sm font-medium">{page}</span>
            <span className="text-sm text-muted-foreground">/ {totalPages}</span>
            {isLoading && <Loader2 className="h-3 w-3 animate-spin ml-1" />}
          </button>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={page >= totalPages || isLoading}
              onClick={() => onPageChange(page + 1)}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8"
              disabled={page >= totalPages || isLoading}
              onClick={() => onPageChange(totalPages)}
            >
              <ChevronsRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
        <Sheet open={showJumpSheet} onOpenChange={setShowJumpSheet}>
          <SheetContent side="bottom" className="h-auto rounded-t-xl">
            <SheetHeader>
              <SheetTitle>跳转到指定页</SheetTitle>
            </SheetHeader>
            <div className="py-4 space-y-4">
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground shrink-0">跳转到第</span>
                <input
                  type="number"
                  min={1}
                  max={totalPages}
                  value={jumpPage}
                  onChange={(e) => setJumpPage(e.target.value)}
                  onKeyDown={handleKeyDown}
                  className="flex-1 h-10 px-3 text-center text-lg font-medium border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/20"
                  placeholder={page.toString()}
                  autoFocus
                />
                <span className="text-sm text-muted-foreground shrink-0">/ {totalPages} 页</span>
              </div>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => {
                    setShowJumpSheet(false)
                    setJumpPage('')
                  }}
                >
                  取消
                </Button>
                <Button
                  className="flex-1"
                  onClick={handleJump}
                  disabled={
                    !jumpPage || parseInt(jumpPage) < 1 || parseInt(jumpPage) > totalPages
                  }
                >
                  确定
                </Button>
              </div>
            </div>
          </SheetContent>
        </Sheet>
      </div>
    )
  }

  return (
    <div className="px-6 py-3 border-t bg-card/30 shrink-0">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">
            第 {page} / {totalPages} 页
          </span>
          {isLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page <= 1 || isLoading}
            onClick={() => onPageChange(1)}
            title="第一页"
          >
            <ChevronsLeft className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page <= 1 || isLoading}
            onClick={() => onPageChange(page - 1)}
            title="上一页"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <div className="flex items-center gap-1.5 px-2">
            <span className="text-sm text-muted-foreground">跳至</span>
            <input
              type="number"
              min={1}
              max={totalPages}
              value={jumpPage}
              onChange={(e) => setJumpPage(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={() => {
                if (jumpPage) handleJump()
              }}
              className="w-14 h-8 px-2 text-sm text-center border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/20"
              placeholder={page.toString()}
            />
            <span className="text-sm text-muted-foreground">页</span>
          </div>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page >= totalPages || isLoading}
            onClick={() => onPageChange(page + 1)}
            title="下一页"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            disabled={page >= totalPages || isLoading}
            onClick={() => onPageChange(totalPages)}
            title="最后一页"
          >
            <ChevronsRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  )
}

function StatCard({
  icon,
  label,
  value,
  loading,
  color
}: {
  icon: React.ReactNode
  label: string
  value: string | number
  loading?: boolean
  color?: string
}) {
  return (
    <div className="bg-card rounded-lg border p-4">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'p-2 rounded-lg',
            color === 'green' && 'bg-green-500/10',
            color === 'rose' && 'bg-rose-500/10',
            color === 'blue' && 'bg-blue-500/10',
            color === 'amber' && 'bg-amber-500/10',
            !color && 'bg-muted'
          )}
        >
          {icon}
        </div>
        <div>
          <p className="text-xs text-muted-foreground">{label}</p>
          {loading ? (
            <Loader2 className="h-4 w-4 animate-spin mt-1" />
          ) : (
            <p className="text-lg font-semibold">{value}</p>
          )}
        </div>
      </div>
    </div>
  )
}

function LogItem({
  log,
  onClick,
  formatTime
}: {
  log: LogEntry
  onClick: () => void
  formatTime: (s: string) => string
}) {
  const typeConfig = LOG_TYPES[log.type as keyof typeof LOG_TYPES] || LOG_TYPES.system
  const levelConfig = LOG_LEVELS[log.level]
  const TypeIcon = typeConfig.icon
  const LevelIcon = levelConfig.icon

  return (
    <div
      className={cn(
        'p-3 md:p-4 rounded-lg border bg-card hover:bg-muted/30 cursor-pointer transition-colors',
        log.level === 'error' && 'border-rose-200 dark:border-rose-900/50',
        log.level === 'warn' && 'border-amber-200 dark:border-amber-900/50'
      )}
      onClick={onClick}
    >
      <div className="flex items-start md:items-center gap-3 md:gap-4">
        <div
          className={cn(
            'p-1.5 md:p-2 rounded-full shrink-0',
            log.level === 'success' && 'bg-green-500/10 text-green-500',
            log.level === 'error' && 'bg-rose-500/10 text-rose-500',
            log.level === 'warn' && 'bg-amber-500/10 text-amber-500',
            log.level === 'info' && 'bg-blue-500/10 text-blue-500'
          )}
        >
          <LevelIcon className="h-4 w-4 md:h-5 md:w-5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge
              variant="outline"
              className={cn(
                'text-xs',
                typeConfig.color === 'blue' && 'border-blue-300 text-blue-600',
                typeConfig.color === 'purple' && 'border-purple-300 text-purple-600',
                typeConfig.color === 'cyan' && 'border-cyan-300 text-cyan-600',
                typeConfig.color === 'orange' && 'border-orange-300 text-orange-600',
                typeConfig.color === 'gray' && 'border-gray-300 text-gray-600'
              )}
            >
              <TypeIcon className="h-3 w-3 mr-1" />
              {typeConfig.label}
            </Badge>
            <span className="text-sm font-medium truncate">{log.action}</span>
          </div>
          <p className="text-xs md:text-sm text-muted-foreground mt-1 line-clamp-2">{log.message}</p>
          <div className="flex items-center gap-2 md:gap-3 mt-1.5 text-xs text-muted-foreground flex-wrap">
            <span>{formatTime(log.created_at)}</span>
            {log.server_id && (
              <>
                <span className="hidden md:inline">•</span>
                <span className="text-cyan-600">{log.server_id}</span>
              </>
            )}
            {log.account_email && (
              <>
                <span className="hidden md:inline">•</span>
                {log.account_idp && (
                  <span
                    className={cn(
                      'px-1.5 py-0.5 text-xs rounded text-white',
                      IDP_COLORS[log.account_idp] || 'bg-gray-500'
                    )}
                  >
                    {log.account_idp}
                  </span>
                )}
                <span className="truncate max-w-[150px]">{log.account_email}</span>
              </>
            )}
            {log.duration_ms !== null && (
              <>
                <span className="hidden md:inline">•</span>
                <span>{log.duration_ms}ms</span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function LogDetailModal({
  log,
  onClose,
  isMobile
}: {
  log: LogEntry
  onClose: () => void
  isMobile: boolean
}) {
  const typeConfig = LOG_TYPES[log.type as keyof typeof LOG_TYPES] || LOG_TYPES.system
  const levelConfig = LOG_LEVELS[log.level]
  const TypeIcon = typeConfig.icon
  const LevelIcon = levelConfig.icon

  const formatDetailTime = (dateStr: string) => {
    const date = new Date(dateStr)
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  // 移动端使用底部 Sheet
  if (isMobile) {
    return (
      <Sheet open={true} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="bottom" className="h-[85vh] rounded-t-xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <div
                className={cn(
                  'p-1.5 rounded-full',
                  log.level === 'success' && 'bg-green-500/10 text-green-500',
                  log.level === 'error' && 'bg-rose-500/10 text-rose-500',
                  log.level === 'warn' && 'bg-amber-500/10 text-amber-500',
                  log.level === 'info' && 'bg-blue-500/10 text-blue-500'
                )}
              >
                <LevelIcon className="h-4 w-4" />
              </div>
              <span>{log.action}</span>
            </SheetTitle>
          </SheetHeader>
          <div className="mt-4 space-y-2 overflow-auto max-h-[calc(100%-80px)]">
            <div className="flex items-center gap-2 flex-wrap">
              <Badge
                variant="outline"
                className={cn(
                  'text-xs',
                  typeConfig.color === 'blue' && 'border-blue-300 text-blue-600',
                  typeConfig.color === 'purple' && 'border-purple-300 text-purple-600',
                  typeConfig.color === 'orange' && 'border-orange-300 text-orange-600',
                  typeConfig.color === 'gray' && 'border-gray-300 text-gray-600'
                )}
              >
                <TypeIcon className="h-3 w-3 mr-1" />
                {typeConfig.label}
              </Badge>
              <Badge
                variant={
                  log.level === 'success'
                    ? 'default'
                    : log.level === 'error'
                      ? 'destructive'
                      : 'secondary'
                }
                className="text-xs"
              >
                {levelConfig.label}
              </Badge>
            </div>
            <div className="space-y-1.5">
              <div className="py-1">
                <p className="text-xs text-muted-foreground mb-0.5">消息</p>
                <p className="text-sm">{log.message}</p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="py-1">
                  <p className="text-xs text-muted-foreground mb-0.5">时间</p>
                  <p className="text-sm">{formatDetailTime(log.created_at)}</p>
                </div>
                {log.duration_ms !== null ? (
                  <div className="py-1">
                    <p className="text-xs text-muted-foreground mb-0.5">耗时</p>
                    <p className="text-sm">{log.duration_ms}ms</p>
                  </div>
                ) : null}
                {log.server_id ? (
                  <div className="py-1">
                    <p className="text-xs text-muted-foreground mb-0.5">服务器</p>
                    <p className="text-sm text-cyan-600">{log.server_id}</p>
                  </div>
                ) : null}
                {log.account_email ? (
                  <div className="py-1">
                    <p className="text-xs text-muted-foreground mb-0.5">账号</p>
                    <div className="flex items-center gap-1.5">
                      {log.account_idp && (
                        <span
                          className={cn(
                            'px-1.5 py-0.5 text-xs rounded text-white',
                            IDP_COLORS[log.account_idp] || 'bg-gray-500'
                          )}
                        >
                          {log.account_idp}
                        </span>
                      )}
                      <p className="text-sm truncate">{log.account_email}</p>
                    </div>
                  </div>
                ) : null}
              </div>
              {log.details && Object.keys(log.details).length > 0 ? (
                <div className="py-1">
                  <p className="text-xs text-muted-foreground mb-0.5">详情</p>
                  <pre className="text-xs bg-muted p-2 rounded-lg overflow-auto max-h-[200px]">
                    {JSON.stringify(log.details, null, 2)}
                  </pre>
                </div>
              ) : null}
              {log.request_headers && Object.keys(log.request_headers).length > 0 ? (
                <div className="py-1">
                  <p className="text-xs text-muted-foreground mb-0.5">请求头信息</p>
                  <div className="bg-muted p-2 rounded text-xs space-y-1 max-h-[200px] overflow-auto">
                    {Object.entries(log.request_headers).map(([key, value]) => (
                      <div key={key} className="flex gap-2">
                        <span className="font-medium text-muted-foreground min-w-[120px]">{key}:</span>
                        <span className="font-mono break-all flex-1">{value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </SheetContent>
      </Sheet>
    )
  }

  // 桌面端使用居中模态框
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-background rounded-xl shadow-2xl w-[600px] max-h-[80vh] overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-semibold flex items-center gap-2">
            <div
              className={cn(
                'p-1.5 rounded-full',
                log.level === 'success' && 'bg-green-500/10 text-green-500',
                log.level === 'error' && 'bg-rose-500/10 text-rose-500',
                log.level === 'warn' && 'bg-amber-500/10 text-amber-500',
                log.level === 'info' && 'bg-blue-500/10 text-blue-500'
              )}
            >
              <LevelIcon className="h-4 w-4" />
            </div>
            <span>{log.action}</span>
          </h3>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="h-5 w-5" />
          </Button>
        </div>
        <div className="p-4 overflow-auto max-h-[calc(80vh-56px)] space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge
              variant="outline"
              className={cn(
                'text-xs',
                typeConfig.color === 'blue' && 'border-blue-300 text-blue-600',
                typeConfig.color === 'purple' && 'border-purple-300 text-purple-600',
                typeConfig.color === 'orange' && 'border-orange-300 text-orange-600',
                typeConfig.color === 'gray' && 'border-gray-300 text-gray-600'
              )}
            >
              <TypeIcon className="h-3 w-3 mr-1" />
              {typeConfig.label}
            </Badge>
            <Badge
              variant={
                log.level === 'success'
                  ? 'default'
                  : log.level === 'error'
                    ? 'destructive'
                    : 'secondary'
              }
              className="text-xs"
            >
              {levelConfig.label}
            </Badge>
          </div>
          <div className="space-y-1.5">
            <div className="py-1">
              <p className="text-xs text-muted-foreground mb-0.5">消息</p>
              <p className="text-sm">{log.message}</p>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="py-1">
                <p className="text-xs text-muted-foreground mb-0.5">时间</p>
                <p className="text-sm">{formatDetailTime(log.created_at)}</p>
              </div>
              {log.duration_ms !== null ? (
                <div className="py-1">
                  <p className="text-xs text-muted-foreground mb-0.5">耗时</p>
                  <p className="text-sm">{log.duration_ms}ms</p>
                </div>
              ) : null}
              {log.server_id ? (
                <div className="py-1">
                  <p className="text-xs text-muted-foreground mb-0.5">服务器</p>
                  <p className="text-sm text-cyan-600">{log.server_id}</p>
                </div>
              ) : null}
              {log.account_email ? (
                <div className="py-1">
                  <p className="text-xs text-muted-foreground mb-0.5">账号</p>
                  <div className="flex items-center gap-1.5">
                    {log.account_idp && (
                      <span
                        className={cn(
                          'px-1.5 py-0.5 text-xs rounded text-white',
                          IDP_COLORS[log.account_idp] || 'bg-gray-500'
                        )}
                      >
                        {log.account_idp}
                      </span>
                    )}
                    <p className="text-sm truncate">{log.account_email}</p>
                  </div>
                </div>
              ) : null}
            </div>
            {log.details && Object.keys(log.details).length > 0 ? (
              <div className="py-1">
                <p className="text-xs text-muted-foreground mb-0.5">详情</p>
                <pre className="text-xs bg-muted p-2 rounded-lg overflow-auto max-h-[200px]">
                  {JSON.stringify(log.details, null, 2)}
                </pre>
              </div>
            ) : null}
            {log.request_headers && Object.keys(log.request_headers).length > 0 ? (
              <div className="py-1">
                <p className="text-xs text-muted-foreground mb-0.5">请求头信息</p>
                <div className="bg-muted p-2 rounded text-xs space-y-1 max-h-[200px] overflow-auto">
                  {Object.entries(log.request_headers).map(([key, value]) => (
                    <div key={key} className="flex gap-2">
                      <span className="font-medium text-muted-foreground min-w-[140px] shrink-0">{key}:</span>
                      <span className="font-mono break-all flex-1">{value}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
