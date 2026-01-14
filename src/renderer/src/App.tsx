import { useState, useEffect, useCallback, useRef } from 'react'
import { AccountManager } from './components/accounts'
import { Sidebar, type PageType } from './components/layout'
import {
  HomePage,
  SettingsPage,
  MachineIdPage,
  KiroSettingsPage,
  AboutPage,
  ChatPage,
  LoginPage,
  MonitoringPage
} from './components/pages'
import { HomePageWeb } from './components/pages/HomePageWeb'
import { RequestLogs, SystemLogs } from './components/logs'
import { VersionChecker } from './components/VersionChecker'
import { useAccountsStore } from './store/accounts'
import { isElectron, setUnauthorizedCallback } from './lib/api'

// 记住密码存储 key（与 LoginPage 保持一致）
const REMEMBER_LOGIN_KEY = 'kiro-remember-login'

// 简单解密函数（与 LoginPage 保持一致）
function decryptPassword(encrypted: string): string {
  try {
    const salt = 'kiro-2024-salt'
    const decoded = decodeURIComponent(atob(encrypted))
    if (decoded.startsWith(salt) && decoded.endsWith(salt)) {
      return decoded.slice(salt.length, -salt.length)
    }
    return ''
  } catch {
    return ''
  }
}

// 获取保存的登录信息
function getSavedPassword(): string | null {
  try {
    const saved = localStorage.getItem(REMEMBER_LOGIN_KEY)
    if (saved) {
      const data = JSON.parse(saved)
      const password = decryptPassword(data.password)
      if (password) {
        return password
      }
    }
  } catch {
    // 忽略解析错误
  }
  return null
}

// 清除保存的登录信息
function clearSavedPassword(): void {
  try {
    localStorage.removeItem(REMEMBER_LOGIN_KEY)
  } catch {
    // 忽略错误
  }
}

function App(): React.JSX.Element {
  const [currentPage, setCurrentPage] = useState<PageType>('home')
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false) // 默认展开
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null)
  const [requireAuth, setRequireAuth] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const { loadFromStorage } = useAccountsStore()
  const electron = isElectron()
  
  // 防抖计时器引用
  const refreshTimerRef = useRef<NodeJS.Timeout | null>(null)

  // 注册401错误回调（仅 Web 模式）
  useEffect(() => {
    if (!electron) {
      setUnauthorizedCallback(() => {
        console.log('[Auth] 401 Unauthorized detected, redirecting to login...')
        setIsAuthenticated(false)
        setRequireAuth(true)
      })
    }
  }, [electron])

  // 检查登录状态（Electron 和 Web 统一使用密码认证）
  useEffect(() => {
    const checkAuth = async () => {
      try {
        const response = await fetch('/api/auth/check', {
          credentials: 'include'
        })
        const data = await response.json()
        
        // 如果不需要认证，直接通过
        if (!data.requireAuth) {
          setIsAuthenticated(true)
          setRequireAuth(false)
          return
        }
        
        setRequireAuth(true)
        
        // 如果 cookie 有效，直接通过
        if (data.authenticated) {
          setIsAuthenticated(true)
          return
        }
        
        // Cookie 无效，尝试使用保存的密码自动登录
        const savedPassword = getSavedPassword()
        if (savedPassword) {
          try {
            const loginResponse = await fetch('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password: savedPassword }),
              credentials: 'include'
            })
            const loginData = await loginResponse.json()
            
            if (loginData.success) {
              // 自动登录成功
              setIsAuthenticated(true)
              return
            } else {
              // 密码错误，清除保存的密码
              clearSavedPassword()
            }
          } catch {
            // 网络错误，不清除密码，显示登录页让用户手动重试
          }
        }
        
        // 需要手动登录
        setIsAuthenticated(false)
      } catch {
        // 网络错误，尝试使用保存的密码
        const savedPassword = getSavedPassword()
        if (savedPassword) {
          try {
            const loginResponse = await fetch('/api/auth/login', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password: savedPassword }),
              credentials: 'include'
            })
            const loginData = await loginResponse.json()
            
            if (loginData.success) {
              setIsAuthenticated(true)
              setRequireAuth(true)
              return
            }
          } catch {
            // 忽略错误
          }
        }
        
        setIsAuthenticated(false)
        setRequireAuth(true)
      }
    }

    checkAuth()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleLoginSuccess = async () => {
    console.log('[App] Login successful, loading data...')
    setIsAuthenticated(true)
    // 登录成功后立即加载数据
    await loadFromStorage()
  }

  // 认证后加载数据（包括页面刷新的情况）
  useEffect(() => {
    // 只有认证通过后才加载数据
    if (isAuthenticated) {
      console.log('[App] Authenticated, loading data...')
      loadFromStorage().then(() => {
        console.log('[App] Data loaded')
      }).catch(error => {
        console.error('[App] Failed to load data:', error)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAuthenticated])

  // 全局禁用右键菜单（有自定义右键菜单的组件会阻止冒泡）
  useEffect(() => {
    const handleContextMenu = (e: MouseEvent) => {
      e.preventDefault()
    }
    document.addEventListener('contextmenu', handleContextMenu)
    return () => {
      document.removeEventListener('contextmenu', handleContextMenu)
    }
  }, [])

  // 处理页面切换并刷新数据
  const handlePageChange = useCallback(async (page: PageType) => {
    setCurrentPage(page)
    
    // 只有在已认证状态下才刷新数据
    if (!isAuthenticated) return
    
    // 清除之前的防抖计时器
    if (refreshTimerRef.current) {
      clearTimeout(refreshTimerRef.current)
    }
    
    // 根据页面类型决定是否需要刷新数据
    const needsRefresh = ['home', 'accounts'].includes(page)
    
    if (needsRefresh) {
      // 使用防抖处理，避免频繁切换时重复请求
      refreshTimerRef.current = setTimeout(async () => {
        setIsRefreshing(true)
        try {
          console.log(`[App] Page changed to ${page}, refreshing data...`)
          await loadFromStorage()
          console.log(`[App] Data refreshed for page: ${page}`)
        } catch (error) {
          console.error(`[App] Failed to refresh data for page ${page}:`, error)
        } finally {
          setIsRefreshing(false)
        }
      }, 300) // 300ms 防抖延迟
    }
  }, [isAuthenticated, loadFromStorage])

  // 清理防抖计时器
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
      }
    }
  }, [])

  const renderPage = () => {
    switch (currentPage) {
      case 'home':
        // Web 模式显示所有账号统计，Electron 模式显示当前账号详情
        return electron ? <HomePage /> : <HomePageWeb />
      case 'chat':
        return <ChatPage />
      case 'accounts':
        return <AccountManager />
      case 'machineId':
        return <MachineIdPage />
      case 'kiroSettings':
        return electron ? (
          <KiroSettingsPage />
        ) : (
          <div className="p-6">此功能仅在 Electron 模式下可用</div>
        )
      case 'settings':
        return <SettingsPage />
      case 'logs':
        return <RequestLogs />
      case 'systemLogs':
        return <SystemLogs />
      case 'monitoring':
        return <MonitoringPage />
      case 'about':
        return <AboutPage />
      default:
        return electron ? <HomePage /> : <HomePageWeb />
    }
  }

  // 加载中状态
  if (isAuthenticated === null) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">加载中...</p>
        </div>
      </div>
    )
  }

  // 需要登录且未登录
  if (requireAuth && !isAuthenticated) {
    return <LoginPage onLoginSuccess={handleLoginSuccess} />
  }

  // 已登录或不需要登录
  return (
    <div className="h-screen bg-background flex flex-col md:flex-row animate-fadeIn">
      <Sidebar
        currentPage={currentPage}
        onPageChange={handlePageChange}
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <main className="flex-1 overflow-auto">
        <div key={currentPage} className="page-transition h-full relative">
          {isRefreshing && (
            <div className="absolute top-2 right-2 z-50">
              <div className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            </div>
          )}
          {renderPage()}
        </div>
      </main>
      <VersionChecker />
    </div>
  )
}

export default App
