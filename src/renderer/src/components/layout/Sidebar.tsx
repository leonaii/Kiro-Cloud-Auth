import { useState, useEffect, useCallback } from 'react'
import { Home, Users, Settings, ChevronLeft, ChevronRight, Fingerprint, Sparkles, MessageSquare, FileText, Server, Clock, RefreshCw, Menu, BarChart3 } from 'lucide-react'
import { cn } from '@/lib/utils'
import kiroLogo from '@/assets/icon.png'
import { isElectron, fetchWithAuth } from '@/lib/api'
import { useMobile } from '@/hooks/use-mobile'
import { Sheet, SheetContent } from '@/components/ui/sheet'

export type PageType = 'home' | 'accounts' | 'machineId' | 'kiroSettings' | 'settings' | 'about' | 'chat' | 'logs' | 'systemLogs' | 'monitoring'

// Token 检测信息类型
interface TokenCheckInfo {
  nextCheckTime: number | null
  lastCheckTime: number | null
  checkInterval: number
  isRefreshing: boolean
  isRunning: boolean
  timeUntilNextCheck: number | null
}

interface SidebarProps {
  currentPage: PageType
  onPageChange: (page: PageType) => void
  collapsed: boolean
  onToggleCollapse: () => void
}

// 所有菜单项
const allMenuItems: { id: PageType; label: string; icon: React.ElementType; electronOnly?: boolean; webOnly?: boolean }[] = [
  { id: 'home', label: '数据统计', icon: Home },
  { id: 'chat', label: 'AI 对话', icon: MessageSquare },
  { id: 'accounts', label: '账号管理', icon: Users },
  { id: 'logs', label: '请求日志', icon: FileText, webOnly: false },
  { id: 'systemLogs', label: '系统日志', icon: Server, webOnly: false },
  { id: 'monitoring', label: '系统监控', icon: BarChart3, webOnly: false },
  { id: 'machineId', label: '机器码管理', icon: Fingerprint, electronOnly: true },
  { id: 'settings', label: '应用设置', icon: Settings },
  { id: 'kiroSettings', label: 'Kiro设置', icon: Sparkles, electronOnly: true },
]

// 根据环境过滤菜单项
const getMenuItems = () => {
  const electron = isElectron()
  return allMenuItems.filter(item => {
    if (item.electronOnly && !electron) return false
    if (item.webOnly && electron) return false
    return true
  })
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

// 格式化剩余时间
function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return '即将检测'
  const seconds = Math.floor(ms / 1000)
  const minutes = Math.floor(seconds / 60)
  const remainingSeconds = seconds % 60
  if (minutes > 0) {
    return `${minutes}分${remainingSeconds}秒`
  }
  return `${remainingSeconds}秒`
}

// 格式化时间
function formatTime(timestamp: number | null): string {
  if (!timestamp) return '--:--'
  const date = new Date(timestamp)
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

interface SidebarContentProps {
  currentPage: PageType
  onPageChange: (page: PageType) => void
  collapsed: boolean
  onToggleCollapse: () => void
  tokenCheckInfo: TokenCheckInfo | null
  countdown: string
  isMobile: boolean
  appVersion: string
}

function SidebarContent({
  currentPage,
  onPageChange,
  collapsed,
  onToggleCollapse,
  tokenCheckInfo,
  countdown,
  isMobile,
  appVersion
}: SidebarContentProps) {
  return (
    <div className="flex flex-col h-full">
      {/* Logo 区域 */}
      <div className={cn(
        "flex items-center overflow-hidden shrink-0",
        collapsed ? "h-20 justify-center px-2" : "h-20 px-6 gap-3"
      )}>
        <div className={cn(
          "flex items-center justify-center rounded-xl transition-all duration-300",
          "bg-primary/10",
          collapsed ? "w-10 h-10" : "w-9 h-9 shrink-0"
        )}>
          <img
            src={kiroLogo}
            alt="Kiro"
            className={cn(
              "object-contain transition-all duration-300",
              collapsed ? "h-8 w-8" : "h-6 w-6"
            )}
          />
        </div>
        {!collapsed && (
          <div className="flex flex-col">
            <span className="font-bold text-foreground text-lg tracking-tight">Kiro</span>
            <span className="text-xs text-muted-foreground font-medium">账户管理器</span>
          </div>
        )}
      </div>

      {/* 菜单项 */}
      <nav className={cn(
        "flex-1 py-4 space-y-1 overflow-y-auto scrollbar-none",
        collapsed ? "px-3" : "px-4"
      )}>
        {getMenuItems().map((item, index) => {
          const Icon = item.icon
          const isActive = currentPage === item.id
          return (
            <button
              key={item.id}
              onClick={() => onPageChange(item.id)}
              className={cn(
                "group relative w-full flex items-center rounded-xl overflow-hidden",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                "transition-all duration-300 ease-out",
                isActive
                  ? "bg-primary text-primary-foreground shadow-md shadow-primary/20"
                  : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                collapsed ? "justify-center p-2.5" : "gap-3 px-3.5 py-2.5",
                "animate-slideInLeft",
                `stagger-${Math.min(index + 1, 8)}`
              )}
              title={collapsed ? item.label : undefined}
            >
              
              {/* 图标容器 */}
              <span className={cn(
                "flex items-center justify-center shrink-0 transition-all duration-300",
                isActive ? "text-primary-foreground" : "text-muted-foreground group-hover:text-foreground",
                collapsed ? "w-5 h-5" : "w-5 h-5"
              )}>
                <Icon className={cn(
                  "transition-all duration-300",
                  isActive && "scale-110",
                  "group-hover:scale-105",
                  collapsed ? "h-5 w-5" : "h-4 w-4"
                )} />
              </span>
              
              {/* 文字标签 */}
              {!collapsed && (
                <span className={cn(
                  "font-medium tracking-wide text-sm whitespace-nowrap flex-1 text-left",
                  "transition-all duration-300",
                  isActive ? "text-primary-foreground font-semibold" : "text-muted-foreground group-hover:text-foreground"
                )}>
                  {item.label}
                </span>
              )}
            </button>
          )
        })}
      </nav>

      {/* Token 检测时间显示（仅 Web 模式）!isElectron() && */}
      { tokenCheckInfo && (
        <div className={cn(
          "mx-3 mb-2 rounded-xl overflow-hidden",
          "bg-muted/30 border border-border/50",
        )}>
          {collapsed ? (
            // 收起状态：只显示图标
            <div className="p-3 flex justify-center" title={`下次检测: ${countdown || '--'}`}>
              <div className={cn(
                "w-10 h-10 rounded-lg flex items-center justify-center",
                "bg-success/10",
                tokenCheckInfo.isRefreshing && "animate-pulse"
              )}>
                {tokenCheckInfo.isRefreshing ? (
                  <RefreshCw className="h-5 w-5 text-success animate-spin" />
                ) : (
                  <Clock className="h-5 w-5 text-success" />
                )}
              </div>
            </div>
          ) : (
            // 展开状态：显示详细信息
            <div className="p-3 space-y-2">
              <div className="flex items-center gap-2">
                <div className={cn(
                  "w-8 h-8 rounded-lg flex items-center justify-center shrink-0",
                  "bg-success/10",
                  tokenCheckInfo.isRefreshing && "animate-pulse"
                )}>
                  {tokenCheckInfo.isRefreshing ? (
                    <RefreshCw className="h-4 w-4 text-success animate-spin" />
                  ) : (
                    <Clock className="h-4 w-4 text-success" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-xs text-muted-foreground font-medium">Token 自动检测</div>
                  <div className={cn(
                    "text-sm font-semibold",
                    tokenCheckInfo.isRunning ? "text-success" : "text-muted-foreground"
                  )}>
                    {tokenCheckInfo.isRefreshing ? (
                      <span className="text-warning">检测中...</span>
                    ) : tokenCheckInfo.isRunning ? (
                      countdown || '计算中...'
                    ) : (
                      '已停止'
                    )}
                  </div>
                </div>
              </div>
              
              {/* 上次检测时间 */}
              {tokenCheckInfo.lastCheckTime && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">上次检测</span>
                  <span className="text-foreground font-mono">
                    {formatTime(tokenCheckInfo.lastCheckTime)}
                  </span>
                </div>
              )}
              
              {/* 下次检测时间 */}
              {tokenCheckInfo.nextCheckTime && tokenCheckInfo.isRunning && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">下次检测</span>
                  <span className="text-foreground font-mono">
                    {formatTime(tokenCheckInfo.nextCheckTime)}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* 收起/展开按钮 - 仅在非移动端显示 */}
      {!isMobile && (
        <div className={cn(
          "p-4 border-t border-border/50",
          collapsed ? "px-3" : "px-4"
        )}>
          <button
            onClick={onToggleCollapse}
            className={cn(
              "group w-full flex items-center rounded-xl text-sm overflow-hidden",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
              "text-muted-foreground hover:text-foreground",
              "hover:bg-muted/50",
              "transition-all duration-200",
              collapsed ? "justify-center p-2.5" : "justify-center gap-2 px-4 py-2.5"
            )}
            title={collapsed ? "展开侧边栏" : "收起侧边栏"}
          >
            {collapsed ? (
              <ChevronRight className="h-5 w-5 transition-transform duration-300 group-hover:translate-x-0.5" />
            ) : (
              <>
                <ChevronLeft className="h-4 w-4 shrink-0 transition-transform duration-300 group-hover:-translate-x-0.5" />
                <span className="font-medium tracking-wide">收起侧边栏</span>
              </>
            )}
          </button>
        </div>
      )}

      {/* 版本号显示 */}
      <div className={cn(
        "py-2 text-center",
        collapsed ? "px-2" : "px-4",
        !isMobile && "border-t border-border/30"
      )}>
        <span className={cn(
          "text-[10px] text-muted-foreground/50 font-mono",
          collapsed && "text-[9px]"
        )}>
          {collapsed ? `v${appVersion}` : `Version ${appVersion}`}
        </span>
      </div>
    </div>
  )
}

export function Sidebar({ currentPage, onPageChange, collapsed, onToggleCollapse }: SidebarProps) {
  const [tokenCheckInfo, setTokenCheckInfo] = useState<TokenCheckInfo | null>(null)
  const [countdown, setCountdown] = useState<string>('')
  const [appVersion, setAppVersion] = useState<string>('1.0.0')
  const isMobile = useMobile()
  const [sheetOpen, setSheetOpen] = useState(false)
  
  // 获取 Token 检测信息
  const fetchTokenCheckInfo = useCallback(async () => {
    try {
      const API_BASE = getApiBase()
      // 使用专用的 token-check-info 接口，避免与 VersionChecker 重复调用 /api/health
      const res = await fetchWithAuth(`${API_BASE}/token-check-info`)
      const data = await res.json()
      // /api/token-check-info 直接返回 token 检测信息对象
      if (data) {
        setTokenCheckInfo(data)
      }
    } catch (error) {
      console.error('Failed to fetch token check info:', error)
    }
  }, [])
  
  // 获取后端版本号
  const fetchAppVersion = useCallback(async () => {
    try {
      const API_BASE = getApiBase()
      const res = await fetchWithAuth(`${API_BASE}/health`)
      const data = await res.json()
      if (data?.version) {
        setAppVersion(data.version)
      }
    } catch (error) {
      console.error('Failed to fetch app version:', error)
    }
  }, [])
  
  // 定期获取 Token 检测信息
  useEffect(() => {
    fetchTokenCheckInfo()
    const interval = setInterval(fetchTokenCheckInfo, 30000) // 每30秒刷新一次
    return () => clearInterval(interval)
  }, [fetchTokenCheckInfo])
  
  // 获取后端版本号（仅在组件挂载时获取一次）
  useEffect(() => {
    fetchAppVersion()
  }, [fetchAppVersion])
  
  // 倒计时更新
  useEffect(() => {
    if (!tokenCheckInfo?.nextCheckTime || !tokenCheckInfo.isRunning) {
      setCountdown('')
      return
    }
    
    const updateCountdown = () => {
      const now = Date.now()
      const remaining = tokenCheckInfo.nextCheckTime! - now
      setCountdown(formatTimeRemaining(remaining))
    }
    
    updateCountdown()
    const interval = setInterval(updateCountdown, 1000)
    return () => clearInterval(interval)
  }, [tokenCheckInfo?.nextCheckTime, tokenCheckInfo?.isRunning])
  
  if (isMobile) {
    return (
      <>
        <div className="fixed top-0 left-0 right-0 h-14 bg-background/80 backdrop-blur-md border-b border-border z-40 flex items-center px-4 justify-between">
           <div className="flex items-center gap-3">
             <button onClick={() => setSheetOpen(true)} className="p-2 -ml-2 hover:bg-muted rounded-md">
               <Menu className="h-5 w-5" />
             </button>
             <span className="font-bold text-lg">Kiro</span>
           </div>
        </div>
        <Sheet open={sheetOpen} onOpenChange={setSheetOpen} side="left">
          <SheetContent className="p-0 w-64 bg-background/95 backdrop-blur-xl">
             <SidebarContent
               currentPage={currentPage}
               onPageChange={(page) => {
                 onPageChange(page)
                 setSheetOpen(false)
               }}
               collapsed={false}
               onToggleCollapse={() => {}}
               tokenCheckInfo={tokenCheckInfo}
               countdown={countdown}
               isMobile={true}
               appVersion={appVersion}
             />
          </SheetContent>
        </Sheet>
        {/* 占位符，防止内容被 Header 遮挡 */}
        <div className="h-14 w-full shrink-0 md:hidden" />
      </>
    )
  }

  return (
    <aside
      className={cn(
        "h-screen flex flex-col transition-all duration-300 ease-out z-50",
        "bg-background/80 backdrop-blur-xl border-r border-border",
        collapsed ? "w-20" : "w-64"
      )}
    >
      <SidebarContent
        currentPage={currentPage}
        onPageChange={onPageChange}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        tokenCheckInfo={tokenCheckInfo}
        countdown={countdown}
        isMobile={false}
        appVersion={appVersion}
      />
    </aside>
  )
}