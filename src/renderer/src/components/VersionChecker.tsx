import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { RefreshCw, AlertCircle, Clock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/lib/api'

const HEARTBEAT_INTERVAL = 30 * 1000 // 30 秒心跳检测
const AUTO_RELOAD_COUNTDOWN = 60 // 60 秒自动重载倒计时

export function VersionChecker(): React.JSX.Element | null {
  const [showUpdateDialog, setShowUpdateDialog] = useState(false)
  const [serverVersion, setServerVersion] = useState<string | null>(null)
  const [countdown, setCountdown] = useState(AUTO_RELOAD_COUNTDOWN)
  const clientVersionRef = useRef<string | null>(null)
  const isCheckingRef = useRef(false)
  const countdownTimerRef = useRef<NodeJS.Timeout | null>(null)

  // 清除倒计时定时器
  const clearCountdownTimer = useCallback(() => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current)
      countdownTimerRef.current = null
    }
  }, [])

  // 刷新页面函数
  const handleRefresh = useCallback(async (): Promise<void> => {
    clearCountdownTimer()
    try {
      // 使用 Electron IPC 重载应用，避免被 will-navigate 事件拦截
      if (window.api?.reloadApp) {
        const result = await window.api.reloadApp()
        if (!result.success) {
          console.error('[VersionChecker] Failed to reload app:', result.error)
          // 降级方案：使用 window.location.reload()
          window.location.reload()
        }
      } else {
        // Web 模式降级方案
        window.location.reload()
      }
    } catch (error) {
      console.error('[VersionChecker] Error reloading app:', error)
      // 降级方案：使用 window.location.reload()
      window.location.reload()
    }
  }, [clearCountdownTimer])

  // 启动倒计时
  const startCountdown = useCallback(() => {
    clearCountdownTimer()
    setCountdown(AUTO_RELOAD_COUNTDOWN)
    
    countdownTimerRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          // 倒计时结束，自动刷新
          handleRefresh()
          return 0
        }
        return prev - 1
      })
    }, 1000)
  }, [clearCountdownTimer, handleRefresh])

  useEffect(() => {
    // 心跳检测函数
    const checkVersion = async (): Promise<void> => {
      if (isCheckingRef.current) return
      isCheckingRef.current = true

      try {
        const result = await api.healthCheck()
        const newServerVersion = result.version

        if (newServerVersion) {
          // 首次获取版本号
          if (clientVersionRef.current === null) {
            clientVersionRef.current = newServerVersion
            console.log(`[VersionChecker] Initial version: ${newServerVersion}`)
          } else if (clientVersionRef.current !== newServerVersion) {
            // 版本不一致，显示更新提示
            console.log(
              `[VersionChecker] Version mismatch: client=${clientVersionRef.current}, server=${newServerVersion}`
            )
            setServerVersion(newServerVersion)
            setShowUpdateDialog(true)
          }
        }
      } catch (error) {
        console.error('[VersionChecker] Health check failed:', error)
      } finally {
        isCheckingRef.current = false
      }
    }

    // 立即检查一次
    checkVersion()

    // 定时心跳检测
    const timer = setInterval(checkVersion, HEARTBEAT_INTERVAL)

    return () => {
      clearInterval(timer)
      clearCountdownTimer()
    }
  }, [clearCountdownTimer])

  // 当显示更新对话框时启动倒计时
  useEffect(() => {
    if (showUpdateDialog) {
      startCountdown()
    }
    return () => {
      clearCountdownTimer()
    }
  }, [showUpdateDialog, startCountdown, clearCountdownTimer])

  // 阻止 Escape 键关闭对话框
  useEffect(() => {
    if (!showUpdateDialog) return

    const handleKeyDown = (e: KeyboardEvent) => {
      // 阻止 Escape 键和其他可能关闭对话框的按键
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
      }
    }

    // 使用 capture 阶段捕获事件，确保在其他处理程序之前执行
    document.addEventListener('keydown', handleKeyDown, true)
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true)
    }
  }, [showUpdateDialog])

  if (!showUpdateDialog) return null

  // 计算进度百分比
  const progressPercent = ((AUTO_RELOAD_COUNTDOWN - countdown) / AUTO_RELOAD_COUNTDOWN) * 100

  // 阻止点击事件冒泡，防止意外关闭
  const handleBackdropClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  return createPortal(
    <div 
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      onClick={handleBackdropClick}
      onMouseDown={handleBackdropClick}
    >
      {/* 遮罩层 - 不可点击穿透 */}
      <div 
        className="absolute inset-0 bg-black/50"
        onClick={handleBackdropClick}
        onMouseDown={handleBackdropClick}
      />

      {/* 对话框 */}
      <div 
        className="relative bg-background rounded-xl shadow-2xl w-full max-w-sm m-4 animate-in zoom-in-95 duration-200 border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 自动重载进度条 */}
        <div className="absolute top-0 left-0 right-0 h-1 bg-muted overflow-hidden">
          <div 
            className="h-full bg-amber-500 transition-all duration-1000 ease-linear"
            style={{ width: `${progressPercent}%` }}
          />
        </div>

        {/* 头部 */}
        <div className="bg-gradient-to-r from-amber-500/10 to-amber-500/5 p-6 border-b">
          <div className="flex items-center gap-3">
            <div className="w-12 h-12 rounded-xl bg-amber-500/20 flex items-center justify-center">
              <AlertCircle className="h-6 w-6 text-amber-500" />
            </div>
            <div className="flex-1">
              <h2 className="text-lg font-bold">发现新版本</h2>
              <p className="text-sm text-muted-foreground">v{serverVersion}</p>
            </div>
          </div>
        </div>

        {/* 内容 */}
        <div className="p-6 space-y-4">
          <p className="text-sm text-muted-foreground">
            服务器已更新到新版本，请点击更新版本。
          </p>

          {/* 倒计时提示 */}
          <div className="flex items-center gap-2 p-3 bg-amber-500/10 rounded-lg border border-amber-500/20">
            <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <span className="text-sm text-amber-600 dark:text-amber-400">
              {countdown} 秒后自动更新
            </span>
          </div>

          <Button className="w-full" onClick={handleRefresh}>
            <RefreshCw className="h-4 w-4 mr-2" />
            立即更新
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}