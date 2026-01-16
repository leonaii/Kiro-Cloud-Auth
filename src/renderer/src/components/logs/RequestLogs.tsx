import { useState, useEffect, useCallback, useRef } from 'react'
import { Button, Badge } from '../ui'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import {
  RefreshCw,
  Loader2,
  CheckCircle,
  XCircle,
  Clock,
  Zap,
  TrendingUp,
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Filter,
  X,
  Trash2,
  FileText,
  ChevronsLeft,
  ChevronsRight
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useMobile } from '@/hooks/use-mobile'
import { fetchWithAuth } from '@/lib/api'

interface LogEntry {
  id: number
  request_id: string
  account_id: string | null
  account_email: string | null
  account_idp: string | null
  model: string | null
  is_stream: boolean
  is_thinking: boolean
  thinking_budget: number
  status: 'success' | 'error'
  error_type: string | null
  error_message: string | null
  request_tokens: number
  response_tokens: number
  duration_ms: number
  time_to_first_byte: number | null
  client_ip: string | null
  user_agent: string | null
  server_id: string | null
  header_version: number | null
  request_headers: Record<string, string> | null
  api_protocol: 'openai' | 'claude' | null
  created_at: string
}

interface LogStats {
  total: number
  successCount: number
  errorCount: number
  successRate: string | number
  avgDuration: number
  totalRequestTokens: number
  totalResponseTokens: number
  hourly: Array<{ hour: string; count: number; success: number; errors: number }>
  errorTypes: Array<{ error_type: string; count: number }>
}

interface Pagination {
  page: number
  pageSize: number
  total: number
  totalPages: number
}

const IDP_COLORS: Record<string, string> = {
  'Google': 'bg-blue-500',
  'BuilderId': 'bg-orange-500',
  'Github': 'bg-gray-700'
}

function getApiBase(): string {
  if (import.meta.env.VITE_API_BASE) {
    return import.meta.env.VITE_API_BASE
  }
  return '/api'
}

export function RequestLogs() {
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [stats, setStats] = useState<LogStats | null>(null)
  const [pagination, setPagination] = useState<Pagination>({ page: 1, pageSize: 20, total: 0, totalPages: 0 })
  const [loading, setLoading] = useState(false)
  const [isInitialLoad, setIsInitialLoad] = useState(true)
  const [isPageChanging, setIsPageChanging] = useState(false)
  const [statsLoading, setStatsLoading] = useState(false)
  const [statusFilter, setStatusFilter] = useState<string>('')
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

  const fetchLogs = useCallback(async (page: number, isPageChange = false) => {
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
      if (statusFilter) params.append('status', statusFilter)
      if (serverFilter) params.append('serverId', serverFilter)

      const res = await fetchWithAuth(`${apiBase}/logs?${params}`, {
        signal: abortController.signal
      })

      if (currentRequestId !== requestIdRef.current) return

      const data = await res.json()
      setLogs(data.data || [])
      setPagination((prev) => ({
        ...prev,
        ...data.pagination,
        page: data.pagination?.page || page
      }))

      if (isInitialLoad) setIsInitialLoad(false)
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return
      console.error('Failed to fetch logs:', error)
    } finally {
      if (currentRequestId === requestIdRef.current) {
        setLoading(false)
        setIsPageChanging(false)
      }
    }
  }, [apiBase, pagination.pageSize, statusFilter, serverFilter, isInitialLoad])

  const fetchStats = useCallback(async () => {
    setStatsLoading(true)
    try {
      const res = await fetchWithAuth(`${apiBase}/logs/stats`)
      const data = await res.json()
      setStats(data)
    } catch (error) {
      console.error('Failed to fetch stats:', error)
    } finally {
      setStatsLoading(false)
    }
  }, [apiBase])

  useEffect(() => {
    fetchServerIds()
    fetchStats()
    fetchLogs(1)
  }, []) // eslint-disable-line

  useEffect(() => {
    if (!isInitialLoad) fetchLogs(1)
  }, [statusFilter, serverFilter]) // eslint-disable-line

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
    return new Date(dateStr).toLocaleString('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  }

  const formatDuration = (ms: number) => {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`
  }

  const handleClearLogs = async () => {
    if (!confirm('确定要清空所有请求日志吗？')) return
    try {
      await fetchWithAuth(`${apiBase}/logs`, { method: 'DELETE' })
      handleRefresh()
    } catch (e) {
      console.error('Failed to clear logs:', e)
    }
  }

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="px-4 md:px-6 py-3 border-b bg-card/50 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 text-primary shadow-sm">
              <FileText className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-bold tracking-tight">请求日志</h1>
              <p className="text-xs text-muted-foreground mt-0.5">/v1 API 请求记录（保留近 24 小时）</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleClearLogs} disabled={loading}>
              <Trash2 className="h-4 w-4 mr-2" />清空
            </Button>
            <Button variant="outline" size="sm" onClick={handleRefresh} disabled={loading || isPageChanging}>
              <RefreshCw className={cn('h-4 w-4 mr-2', (loading || isPageChanging) && 'animate-spin')} />刷新
            </Button>
          </div>
        </div>
      </div>

      <div className={cn("border-b bg-muted/20 shrink-0", isMobile ? "px-3 py-3" : "px-6 py-4")}>
        <div className={cn("grid gap-3", isMobile ? "grid-cols-2" : "grid-cols-5 gap-4")}>
          <StatCard icon={<Zap className="h-5 w-5" />} label="总请求" value={stats?.total || 0} loading={statsLoading} />
          <StatCard icon={<CheckCircle className="h-5 w-5 text-green-500" />} label="成功" value={stats?.successCount || 0} loading={statsLoading} color="green" />
          <StatCard icon={<XCircle className="h-5 w-5 text-rose-500" />} label="失败" value={stats?.errorCount || 0} loading={statsLoading} color="rose" />
          <StatCard icon={<TrendingUp className="h-5 w-5 text-blue-500" />} label="成功率" value={`${stats?.successRate || 0}%`} loading={statsLoading} color="blue" />
          <StatCard icon={<Clock className="h-5 w-5 text-amber-500" />} label="平均耗时" value={formatDuration(stats?.avgDuration || 0)} loading={statsLoading} color="amber" />
        </div>
      </div>

      <div className={cn("border-b bg-card/30 shrink-0", isMobile ? "px-3 py-2" : "px-6 py-3")}>
        {isMobile ? (
          <div className="flex items-center justify-between">
            <Button variant="outline" size="sm" className="gap-2" onClick={() => setShowFilterSheet(true)}>
              <Filter className="h-4 w-4" />
              筛选
              {(statusFilter || serverFilter) && (
                <Badge className="h-5 px-1.5 text-xs bg-primary">
                  {[statusFilter, serverFilter].filter(Boolean).length}
                </Badge>
              )}
            </Button>
            <span className="text-xs text-muted-foreground">{pagination.total} 条</span>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            <Filter className="h-4 w-4 text-muted-foreground" />
            <div className="flex items-center gap-2">
              <button className={cn('px-3 py-1.5 text-sm rounded-lg transition-colors', !statusFilter ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80')} onClick={() => setStatusFilter('')}>全部</button>
              <button className={cn('px-3 py-1.5 text-sm rounded-lg transition-colors', statusFilter === 'success' ? 'bg-green-500 text-white' : 'bg-muted hover:bg-muted/80')} onClick={() => setStatusFilter('success')}>成功</button>
              <button className={cn('px-3 py-1.5 text-sm rounded-lg transition-colors', statusFilter === 'error' ? 'bg-rose-500 text-white' : 'bg-muted hover:bg-muted/80')} onClick={() => setStatusFilter('error')}>失败</button>
            </div>
            {serverIds.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">服务器:</span>
                <select className="h-8 px-2 text-sm border rounded-lg bg-background" value={serverFilter} onChange={(e) => setServerFilter(e.target.value)}>
                  <option value="">全部</option>
                  {serverIds.map((id) => (<option key={id} value={id}>{id}</option>))}
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
            <SheetHeader><SheetTitle>筛选条件</SheetTitle></SheetHeader>
            <div className="py-4 space-y-4">
              <div className="space-y-2">
                <span className="text-sm font-medium">状态</span>
                <div className="flex flex-wrap gap-2">
                  <button className={cn('px-4 py-2 text-sm rounded-lg transition-colors', !statusFilter ? 'bg-primary text-primary-foreground' : 'bg-muted hover:bg-muted/80')} onClick={() => setStatusFilter('')}>全部</button>
                  <button className={cn('px-4 py-2 text-sm rounded-lg transition-colors', statusFilter === 'success' ? 'bg-green-500 text-white' : 'bg-muted hover:bg-muted/80')} onClick={() => setStatusFilter('success')}>成功</button>
                  <button className={cn('px-4 py-2 text-sm rounded-lg transition-colors', statusFilter === 'error' ? 'bg-rose-500 text-white' : 'bg-muted hover:bg-muted/80')} onClick={() => setStatusFilter('error')}>失败</button>
                </div>
              </div>
              {serverIds.length > 0 && (
                <div className="space-y-2">
                  <span className="text-sm font-medium">服务器</span>
                  <select className="w-full h-10 px-3 text-sm border rounded-lg bg-background" value={serverFilter} onChange={(e) => setServerFilter(e.target.value)}>
                    <option value="">全部</option>
                    {serverIds.map((id) => (<option key={id} value={id}>{id}</option>))}
                  </select>
                </div>
              )}
              <Button className="w-full" onClick={() => setShowFilterSheet(false)}>确定</Button>
            </div>
          </SheetContent>
        </Sheet>
      )}

      <div className={cn("flex-1 overflow-auto relative", isMobile ? "px-3 py-3" : "px-6 py-4")}>
        {loading && isInitialLoad ? (
          <div className="flex items-center justify-center h-full"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>
        ) : logs.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground"><AlertTriangle className="h-12 w-12 mb-4 opacity-50" /><p>暂无日志数据</p></div>
        ) : (
          <>
            {isPageChanging && (
              <div className="absolute top-0 left-0 right-0 z-10 flex justify-center py-2 bg-gradient-to-b from-background/80 to-transparent">
                <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/10 rounded-full text-sm text-primary"><Loader2 className="h-3 w-3 animate-spin" /><span>加载中...</span></div>
              </div>
            )}
            <div className={cn("space-y-2 transition-opacity duration-200", isPageChanging && "opacity-60")}>
              {logs.map((log) => (<LogItem key={log.id} log={log} onClick={() => setSelectedLog(log)} formatTime={formatTime} formatDuration={formatDuration} />))}
            </div>
          </>
        )}
      </div>

      {pagination.totalPages > 1 && (<PaginationBar page={pagination.page} totalPages={pagination.totalPages} isLoading={isPageChanging || loading} onPageChange={handlePageChange} isMobile={isMobile} />)}
      {selectedLog && (<LogDetailModal log={selectedLog} onClose={() => setSelectedLog(null)} isMobile={isMobile} />)}
    </div>
  )
}

function PaginationBar({ page, totalPages, isLoading, onPageChange, isMobile }: { page: number; totalPages: number; isLoading: boolean; onPageChange: (page: number) => void; isMobile: boolean }) {
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
    else if (e.key === 'Escape') { setShowJumpSheet(false); setJumpPage('') }
  }

  if (isMobile) {
    return (
      <div className="px-4 py-3 border-t bg-card/30 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1 || isLoading} onClick={() => onPageChange(1)}><ChevronsLeft className="h-4 w-4" /></Button>
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1 || isLoading} onClick={() => onPageChange(page - 1)}><ChevronLeft className="h-4 w-4" /></Button>
          </div>
          <button className="flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-muted/50 transition-colors" onClick={() => setShowJumpSheet(true)}>
            <span className="text-sm font-medium">{page}</span><span className="text-sm text-muted-foreground">/ {totalPages}</span>{isLoading && <Loader2 className="h-3 w-3 animate-spin ml-1" />}
          </button>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= totalPages || isLoading} onClick={() => onPageChange(page + 1)}><ChevronRight className="h-4 w-4" /></Button>
            <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= totalPages || isLoading} onClick={() => onPageChange(totalPages)}><ChevronsRight className="h-4 w-4" /></Button>
          </div>
        </div>
        <Sheet open={showJumpSheet} onOpenChange={setShowJumpSheet}>
          <SheetContent side="bottom" className="h-auto rounded-t-xl">
            <SheetHeader><SheetTitle>跳转到指定页</SheetTitle></SheetHeader>
            <div className="py-4 space-y-4">
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground shrink-0">跳转到第</span>
                <input type="number" min={1} max={totalPages} value={jumpPage} onChange={(e) => setJumpPage(e.target.value)} onKeyDown={handleKeyDown} className="flex-1 h-10 px-3 text-center text-lg font-medium border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder={page.toString()} autoFocus />
                <span className="text-sm text-muted-foreground shrink-0">/ {totalPages} 页</span>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => { setShowJumpSheet(false); setJumpPage('') }}>取消</Button>
                <Button className="flex-1" onClick={handleJump} disabled={!jumpPage || parseInt(jumpPage) < 1 || parseInt(jumpPage) > totalPages}>确定</Button>
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
        <div className="flex items-center gap-2"><span className="text-sm text-muted-foreground">第 {page} / {totalPages} 页</span>{isLoading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}</div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1 || isLoading} onClick={() => onPageChange(1)} title="第一页"><ChevronsLeft className="h-4 w-4" /></Button>
          <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1 || isLoading} onClick={() => onPageChange(page - 1)} title="上一页"><ChevronLeft className="h-4 w-4" /></Button>
          <div className="flex items-center gap-1.5 px-2">
            <span className="text-sm text-muted-foreground">跳至</span>
            <input type="number" min={1} max={totalPages} value={jumpPage} onChange={(e) => setJumpPage(e.target.value)} onKeyDown={handleKeyDown} onBlur={() => { if (jumpPage) handleJump() }} className="w-14 h-8 px-2 text-sm text-center border rounded-lg bg-background focus:outline-none focus:ring-2 focus:ring-primary/20" placeholder={page.toString()} />
            <span className="text-sm text-muted-foreground">页</span>
          </div>
          <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= totalPages || isLoading} onClick={() => onPageChange(page + 1)} title="下一页"><ChevronRight className="h-4 w-4" /></Button>
          <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= totalPages || isLoading} onClick={() => onPageChange(totalPages)} title="最后一页"><ChevronsRight className="h-4 w-4" /></Button>
        </div>
      </div>
    </div>
  )
}

function StatCard({ icon, label, value, loading, color }: { icon: React.ReactNode; label: string; value: string | number; loading?: boolean; color?: string }) {
  return (
    <div className="bg-card rounded-lg border p-4">
      <div className="flex items-center gap-3">
        <div className={cn('p-2 rounded-lg', color === 'green' && 'bg-green-500/10', color === 'rose' && 'bg-rose-500/10', color === 'blue' && 'bg-blue-500/10', color === 'amber' && 'bg-amber-500/10', !color && 'bg-muted')}>{icon}</div>
        <div><p className="text-xs text-muted-foreground">{label}</p>{loading ? <Loader2 className="h-4 w-4 animate-spin mt-1" /> : <p className="text-lg font-semibold">{value}</p>}</div>
      </div>
    </div>
  )
}

const PROTOCOL_COLORS: Record<string, string> = {
  'openai': 'bg-emerald-500',
  'claude': 'bg-amber-500'
}

function LogItem({ log, onClick, formatTime, formatDuration }: { log: LogEntry; onClick: () => void; formatTime: (s: string) => string; formatDuration: (ms: number) => string }) {
  return (
    <div className={cn('p-3 md:p-4 rounded-lg border bg-card hover:bg-muted/30 cursor-pointer transition-colors', log.status === 'error' && 'border-rose-200 dark:border-rose-900/50')} onClick={onClick}>
      <div className="flex items-start md:items-center gap-3 md:gap-4">
        <div className={cn('p-1.5 md:p-2 rounded-full shrink-0', log.status === 'success' ? 'bg-green-500/10 text-green-500' : 'bg-rose-500/10 text-rose-500')}>
          {log.status === 'success' ? <CheckCircle className="h-4 w-4 md:h-5 md:w-5" /> : <XCircle className="h-4 w-4 md:h-5 md:w-5" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5 md:gap-2 flex-wrap">
            {log.api_protocol && <span className={cn('px-1.5 py-0.5 text-xs rounded text-white font-medium', PROTOCOL_COLORS[log.api_protocol] || 'bg-gray-500')}>{log.api_protocol === 'openai' ? 'OpenAI' : 'Claude'}</span>}
            {log.account_idp && <span className={cn('px-1.5 py-0.5 text-xs rounded text-white', IDP_COLORS[log.account_idp] || 'bg-gray-500')}>{log.account_idp}</span>}
            <span className="font-medium truncate text-sm max-w-[120px] md:max-w-none">{log.account_email || '未知账号'}</span>
            <Badge variant="outline" className="text-xs hidden md:inline-flex">{log.model || 'unknown'}</Badge>
            {log.is_stream ? <Badge className="text-xs bg-blue-500 hover:bg-blue-600 text-white h-5">流式</Badge> : <Badge className="text-xs bg-gray-500 hover:bg-gray-600 text-white h-5 hidden md:inline-flex">非流式</Badge>}
            {log.is_thinking ? <Badge className="text-xs bg-purple-500 hover:bg-purple-600 text-white h-5">思考</Badge> : null}
          </div>
          <div className="flex items-center gap-2 md:gap-3 mt-1.5 text-xs text-muted-foreground flex-wrap">
            <span>{formatTime(log.created_at)}</span>
            {log.server_id && <><span className="hidden md:inline">•</span><span className="text-cyan-600 hidden md:inline">{log.server_id}</span></>}
            <span className="hidden md:inline">•</span><span>{formatDuration(log.duration_ms)}</span>
            <span className="hidden md:inline">•</span><span className="hidden md:inline">{log.request_tokens} / {log.response_tokens} tokens</span>
            {log.error_type && <><span className="hidden md:inline">•</span><span className="text-rose-500 truncate max-w-[100px]">{log.error_type}</span></>}
          </div>
        </div>
        <div className="hidden md:block text-xs text-muted-foreground font-mono">{log.request_id.substring(0, 8)}</div>
      </div>
    </div>
  )
}

function LogDetailModal({ log, onClose, isMobile }: { log: LogEntry; onClose: () => void; isMobile?: boolean }) {
  const formatDuration = (ms: number) => ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`

  if (isMobile) {
    return (
      <Sheet open={true} onOpenChange={(open) => !open && onClose()}>
        <SheetContent side="bottom" className="h-[85vh] rounded-t-xl">
          <SheetHeader><SheetTitle>请求详情</SheetTitle></SheetHeader>
          <div className="py-4 overflow-auto h-[calc(100%-3rem)] space-y-0">
            <DetailRow label="请求 ID" value={log.request_id} mono />
            <DetailRow label="状态" value={log.status === 'success' ? '成功' : '失败'} />
            <DetailRow label="API 协议" value={log.api_protocol === 'openai' ? 'OpenAI' : log.api_protocol === 'claude' ? 'Claude' : '-'} />
            <DetailRow label="Header 版本" value={`V${log.header_version || 1}`} />
            {log.server_id ? <DetailRow label="服务器" value={log.server_id} /> : null}
            <DetailRow label="账号" value={log.account_email || '-'} />
            {log.account_idp ? <DetailRow label="账号类型" value={log.account_idp} /> : null}
            <DetailRow label="模型" value={log.model || '-'} />
            <DetailRow label="流式" value={log.is_stream ? '是' : '否'} />
            <DetailRow label="思考模式" value={log.is_thinking ? '是' : '否'} />
            <DetailRow label="总耗时" value={formatDuration(log.duration_ms)} />
            {log.is_stream && log.time_to_first_byte !== null ? <DetailRow label="首字响应" value={formatDuration(log.time_to_first_byte)} /> : null}
            <DetailRow label="请求 Tokens" value={log.request_tokens.toString()} />
            <DetailRow label="响应 Tokens" value={log.response_tokens.toString()} />
            {log.is_thinking && log.thinking_budget > 0 ? <DetailRow label="思考 Tokens" value={log.thinking_budget.toLocaleString()} /> : null}
            <DetailRow label="客户端 IP" value={log.client_ip || '-'} />
            <DetailRow label="时间" value={new Date(log.created_at).toLocaleString('zh-CN')} />
            {log.error_type ? (
              <div className="border-t pt-2 mt-2">
                <h4 className="text-sm font-medium text-rose-500 mb-1">错误信息</h4>
                <DetailRow label="错误类型" value={log.error_type} />
                {log.error_message ? <div className="mt-1"><p className="text-xs text-muted-foreground mb-1">错误详情</p><pre className="p-2 bg-rose-50 dark:bg-rose-900/20 rounded-lg text-xs text-rose-700 dark:text-rose-400 whitespace-pre-wrap break-all">{log.error_message}</pre></div> : null}
              </div>
            ) : null}
            {log.request_headers ? (
              <div className="border-t pt-2 mt-2">
                <p className="text-xs text-muted-foreground mb-1">请求头</p>
                <pre className="p-2 bg-muted rounded-lg text-xs font-mono whitespace-pre-wrap break-all max-h-40 overflow-auto">{JSON.stringify(log.request_headers, null, 2)}</pre>
              </div>
            ) : null}
            {log.user_agent ? (
              <div className="border-t pt-2 mt-2">
                <p className="text-xs text-muted-foreground mb-1">User Agent</p>
                <p className="text-xs font-mono bg-muted p-2 rounded break-all">{log.user_agent}</p>
              </div>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div className="relative bg-background rounded-xl shadow-2xl w-[600px] max-h-[80vh] overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b">
          <h3 className="font-semibold">请求详情</h3>
          <Button variant="ghost" size="icon" onClick={onClose}><X className="h-5 w-5" /></Button>
        </div>
        <div className="p-5 overflow-auto max-h-[calc(80vh-60px)] space-y-0">
          <DetailRow label="请求 ID" value={log.request_id} mono />
          <DetailRow label="状态" value={log.status === 'success' ? '成功' : '失败'} />
          <DetailRow label="API 协议" value={log.api_protocol === 'openai' ? 'OpenAI' : log.api_protocol === 'claude' ? 'Claude' : '-'} />
          <DetailRow label="Header 版本" value={`V${log.header_version || 1}`} />
          {log.server_id ? <DetailRow label="服务器" value={log.server_id} /> : null}
          <DetailRow label="账号" value={log.account_email || '-'} />
          {log.account_idp ? <DetailRow label="账号类型" value={log.account_idp} /> : null}
          <DetailRow label="模型" value={log.model || '-'} />
          <DetailRow label="流式" value={log.is_stream ? '是' : '否'} />
          <DetailRow label="思考模式" value={log.is_thinking ? '是' : '否'} />
          <DetailRow label="总耗时" value={formatDuration(log.duration_ms)} />
          {log.is_stream && log.time_to_first_byte !== null ? <DetailRow label="首字响应" value={formatDuration(log.time_to_first_byte)} /> : null}
          <DetailRow label="请求 Tokens" value={log.request_tokens.toString()} />
          <DetailRow label="响应 Tokens" value={log.response_tokens.toString()} />
          {log.is_thinking && log.thinking_budget > 0 ? <DetailRow label="思考 Tokens" value={log.thinking_budget.toLocaleString()} /> : null}
          <DetailRow label="客户端 IP" value={log.client_ip || '-'} />
          <DetailRow label="时间" value={new Date(log.created_at).toLocaleString('zh-CN')} />
          {log.error_type ? (
            <div className="border-t pt-3 mt-2">
              <h4 className="text-sm font-medium text-rose-500 mb-2">错误信息</h4>
              <DetailRow label="错误类型" value={log.error_type} />
              {log.error_message ? <div className="mt-2"><p className="text-xs text-muted-foreground mb-1">错误详情</p><pre className="p-2 bg-rose-50 dark:bg-rose-900/20 rounded-lg text-xs text-rose-700 dark:text-rose-400 whitespace-pre-wrap break-all">{log.error_message}</pre></div> : null}
            </div>
          ) : null}
          {log.request_headers ? (
            <div className="border-t pt-3 mt-2">
              <p className="text-xs text-muted-foreground mb-1">请求头 (发送给 Kiro API)</p>
              <pre className="p-2 bg-muted rounded-lg text-xs font-mono whitespace-pre-wrap break-all max-h-48 overflow-auto">{JSON.stringify(log.request_headers, null, 2)}</pre>
            </div>
          ) : null}
          {log.user_agent ? (
            <div className="border-t pt-3 mt-2">
              <p className="text-xs text-muted-foreground mb-1">User Agent</p>
              <p className="text-xs font-mono bg-muted p-2 rounded break-all">{log.user_agent}</p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}

function DetailRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-border/50 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={cn('text-sm font-medium', mono && 'font-mono text-xs')}>{value}</span>
    </div>
  )
}

export default RequestLogs
