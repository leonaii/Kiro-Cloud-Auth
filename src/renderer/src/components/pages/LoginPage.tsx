import { useState, useEffect, useRef } from 'react'
import { Lock, Sparkles, Shield, Zap, Loader2, Check } from 'lucide-react'
import kiroLogo from '@/assets/icon.png'

// 记住密码存储 key
const REMEMBER_LOGIN_KEY = 'kiro-remember-login'

// 简单加密函数（Base64 + 混淆）
function encryptPassword(password: string): string {
  try {
    const salt = 'kiro-2024-salt'
    const combined = salt + password + salt
    return btoa(encodeURIComponent(combined))
  } catch {
    return ''
  }
}

// 简单解密函数
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

// 保存登录信息到 localStorage
function saveLoginInfo(password: string): void {
  try {
    const data = {
      password: encryptPassword(password),
      savedAt: Date.now()
    }
    localStorage.setItem(REMEMBER_LOGIN_KEY, JSON.stringify(data))
  } catch {
    // 忽略存储错误
  }
}

// 获取保存的登录信息
function getSavedLoginInfo(): { password: string } | null {
  try {
    const saved = localStorage.getItem(REMEMBER_LOGIN_KEY)
    if (saved) {
      const data = JSON.parse(saved)
      const password = decryptPassword(data.password)
      if (password) {
        return { password }
      }
    }
  } catch {
    // 忽略解析错误
  }
  return null
}

// 清除保存的登录信息
function clearSavedLoginInfo(): void {
  try {
    localStorage.removeItem(REMEMBER_LOGIN_KEY)
  } catch {
    // 忽略错误
  }
}

// 检查是否有保存的登录信息
function hasSavedLoginInfo(): boolean {
  try {
    return localStorage.getItem(REMEMBER_LOGIN_KEY) !== null
  } catch {
    return false
  }
}

interface LoginPageProps {
  onLoginSuccess: () => void
}

export function LoginPage({ onLoginSuccess }: LoginPageProps) {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [shake, setShake] = useState(false)
  const [rememberMe, setRememberMe] = useState(() => hasSavedLoginInfo())
  const [autoLogging, setAutoLogging] = useState(false)
  const autoLoginAttempted = useRef(false)

  // 动态背景粒子效果
  useEffect(() => {
    const canvas = document.getElementById('particles-canvas') as HTMLCanvasElement
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    canvas.width = window.innerWidth
    canvas.height = window.innerHeight

    const particles: Array<{
      x: number
      y: number
      vx: number
      vy: number
      size: number
      opacity: number
    }> = []

    // 创建粒子
    for (let i = 0; i < 50; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height,
        vx: (Math.random() - 0.5) * 0.5,
        vy: (Math.random() - 0.5) * 0.5,
        size: Math.random() * 2 + 1,
        opacity: Math.random() * 0.5 + 0.2
      })
    }

    function animate() {
      if (!ctx || !canvas) return
      ctx.clearRect(0, 0, canvas.width, canvas.height)

      particles.forEach((p) => {
        p.x += p.vx
        p.y += p.vy

        if (p.x < 0 || p.x > canvas.width) p.vx *= -1
        if (p.y < 0 || p.y > canvas.height) p.vy *= -1

        ctx.beginPath()
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2)
        ctx.fillStyle = `rgba(139, 92, 246, ${p.opacity})`
        ctx.fill()
      })

      // 连接粒子
      particles.forEach((p1, i) => {
        particles.slice(i + 1).forEach((p2) => {
          const dx = p1.x - p2.x
          const dy = p1.y - p2.y
          const distance = Math.sqrt(dx * dx + dy * dy)

          if (distance < 150) {
            ctx.beginPath()
            ctx.moveTo(p1.x, p1.y)
            ctx.lineTo(p2.x, p2.y)
            ctx.strokeStyle = `rgba(139, 92, 246, ${0.1 * (1 - distance / 150)})`
            ctx.lineWidth = 0.5
            ctx.stroke()
          }
        })
      })

      requestAnimationFrame(animate)
    }

    animate()

    const handleResize = () => {
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  // 自动登录逻辑
  useEffect(() => {
    // 防止重复尝试自动登录
    if (autoLoginAttempted.current) return
    
    const savedInfo = getSavedLoginInfo()
    if (savedInfo && savedInfo.password) {
      autoLoginAttempted.current = true
      setAutoLogging(true)
      setPassword(savedInfo.password)
      
      // 自动提交登录
      const autoLogin = async () => {
        try {
          const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: savedInfo.password })
          })

          const data = await response.json()

          if (data.success) {
            // 登录成功，根据"记住密码"选项保存或清除密码
            if (rememberMe) {
              saveLoginInfo(password)
            } else {
              clearSavedLoginInfo()
            }
            onLoginSuccess()
          } else {
            // 自动登录失败，清除保存的密码
            clearSavedLoginInfo()
            setRememberMe(false)
            setPassword('')
            setError('自动登录失败，请重新输入密码')
          }
        } catch {
          // 网络错误，不清除密码，让用户手动重试
          setError('网络错误，请手动登录')
        } finally {
          setAutoLogging(false)
        }
      }
      
      autoLogin()
    }
  }, [onLoginSuccess])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      })

      const data = await response.json()

      if (data.success) {
        // 登录成功，根据"记住密码"选项保存或清除密码
        if (rememberMe) {
          saveLoginInfo(password)
        } else {
          clearSavedLoginInfo()
        }
        onLoginSuccess()
      } else {
        setError(data.message || '登录失败')
        setShake(true)
        setTimeout(() => setShake(false), 500)
      }
    } catch (err) {
      setError('网络错误，请稍后重试')
      setShake(true)
      setTimeout(() => setShake(false), 500)
    } finally {
      setLoading(false)
    }
  }

  // 自动登录中的全屏加载状态
  if (autoLogging) {
    return (
      <div className="relative h-screen w-screen overflow-hidden bg-background selection:bg-primary/20">
        {/* 渐变光晕 */}
        <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] bg-primary/20 rounded-full blur-[100px] animate-pulse" />
        <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-blue-500/10 rounded-full blur-[100px] animate-pulse delay-1000" />
        
        {/* 主内容 */}
        <div className="relative z-10 flex items-center justify-center h-full">
          <div className="text-center space-y-6">
            <div className="inline-flex items-center justify-center w-24 h-24 rounded-3xl bg-gradient-to-br from-primary/80 to-blue-600/80 shadow-2xl shadow-primary/30 animate-float backdrop-blur-xl border border-white/20">
              <img src={kiroLogo} alt="Kiro" className="w-14 h-14 drop-shadow-md" />
            </div>
            <div className="space-y-3">
              <h2 className="text-2xl font-bold text-foreground">自动登录中</h2>
              <div className="flex items-center justify-center gap-2 text-muted-foreground">
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>正在验证身份...</span>
              </div>
            </div>
          </div>
        </div>

        {/* CSS 动画 */}
        <style>{`
          @keyframes float {
            0%, 100% { transform: translateY(0px); }
            50% { transform: translateY(-10px); }
          }
          .animate-float {
            animation: float 3s ease-in-out infinite;
          }
        `}</style>
      </div>
    )
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-background selection:bg-primary/20">
      {/* 动态背景粒子 */}
      <canvas
        id="particles-canvas"
        className="absolute inset-0 opacity-20 dark:opacity-40"
      />

      {/* 渐变光晕 */}
      <div className="absolute top-1/4 left-1/4 w-[500px] h-[500px] bg-primary/20 rounded-full blur-[100px] animate-pulse" />
      <div className="absolute bottom-1/4 right-1/4 w-[500px] h-[500px] bg-blue-500/10 rounded-full blur-[100px] animate-pulse delay-1000" />

      {/* 主内容 */}
      <div className="relative z-10 flex items-center justify-center h-full">
        <div className={`w-full max-w-md px-8 ${shake ? 'animate-shake' : ''}`}>
          {/* Logo 和标题 */}
          <div className="text-center mb-10 animate-fade-in space-y-4">
            <div className="inline-flex items-center justify-center w-24 h-24 rounded-3xl bg-gradient-to-br from-primary/80 to-blue-600/80 shadow-2xl shadow-primary/30 animate-float backdrop-blur-xl border border-white/20">
              <img src={kiroLogo} alt="Kiro" className="w-14 h-14 drop-shadow-md" />
            </div>
            <div>
              <h1 className="text-4xl font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">
                Kiro 账户管理器
              </h1>
              <div className="flex items-center justify-center gap-2 mt-3 text-muted-foreground">
                <Shield className="w-3.5 h-3.5" />
                <span className="text-sm font-medium tracking-wide">安全 · 极速 · 智能</span>
              </div>
            </div>
          </div>

          {/* 登录卡片 */}
          <div className="group backdrop-blur-2xl bg-card/40 rounded-3xl shadow-2xl border border-white/10 dark:border-white/5 p-8 animate-slide-up hover:bg-card/50 transition-colors duration-500">
            <form onSubmit={handleSubmit} className="space-y-6">
              {/* 密码输入框 */}
              <div className="space-y-2.5">
                <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider ml-1 flex items-center gap-1.5">
                  <Lock className="w-3.5 h-3.5" />
                  访问密码
                </label>
                <div className="relative">
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="请输入访问密码..."
                    className="w-full px-5 py-4 bg-background/50 border border-border/50 rounded-2xl text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-primary/30 focus:border-primary/50 transition-all duration-300 shadow-inner"
                    disabled={loading}
                    autoFocus
                  />
                </div>
              </div>

              {/* 记住密码选项 */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setRememberMe(!rememberMe)}
                  className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all duration-200 ${
                    rememberMe
                      ? 'bg-primary border-primary text-primary-foreground'
                      : 'border-border/50 hover:border-primary/50'
                  }`}
                  disabled={loading}
                >
                  {rememberMe && <Check className="w-3 h-3" />}
                </button>
                <label
                  className="text-sm text-muted-foreground cursor-pointer select-none"
                  onClick={() => !loading && setRememberMe(!rememberMe)}
                >
                  记住密码（下次自动登录）
                </label>
              </div>

              {/* 错误提示 */}
              {error && (
                <div className="p-4 bg-destructive/10 border border-destructive/20 rounded-2xl flex items-center gap-3 text-destructive text-sm animate-fade-in">
                  <div className="w-1.5 h-1.5 rounded-full bg-destructive animate-pulse" />
                  {error}
                </div>
              )}

              {/* 登录按钮 */}
              <button
                type="submit"
                disabled={loading || !password}
                className="w-full py-4 px-6 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold rounded-2xl shadow-lg shadow-primary/25 hover:shadow-primary/40 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-300 transform hover:scale-[1.02] active:scale-[0.98] flex items-center justify-center gap-2.5"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span className="tracking-wide">验证中...</span>
                  </>
                ) : (
                  <>
                    <Zap className="w-5 h-5 fill-current" />
                    <span className="tracking-wide">立即登录</span>
                  </>
                )}
              </button>
            </form>

            {/* 装饰性特性列表 */}
            <div className="mt-8 pt-8 border-t border-border/30">
              <div className="grid grid-cols-3 gap-6">
                <div className="flex flex-col items-center gap-2 group/item">
                  <div className="w-10 h-10 rounded-2xl bg-primary/10 flex items-center justify-center text-primary group-hover/item:scale-110 transition-transform duration-300">
                    <Shield className="w-5 h-5" />
                  </div>
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">本地加密</span>
                </div>
                <div className="flex flex-col items-center gap-2 group/item">
                  <div className="w-10 h-10 rounded-2xl bg-blue-500/10 flex items-center justify-center text-blue-500 group-hover/item:scale-110 transition-transform duration-300">
                    <Sparkles className="w-5 h-5" />
                  </div>
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">智能管理</span>
                </div>
                <div className="flex flex-col items-center gap-2 group/item">
                  <div className="w-10 h-10 rounded-2xl bg-purple-500/10 flex items-center justify-center text-purple-500 group-hover/item:scale-110 transition-transform duration-300">
                    <Zap className="w-5 h-5" />
                  </div>
                  <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">极速体验</span>
                </div>
              </div>
            </div>
          </div>

          {/* 底部提示 */}
          <div className="text-center mt-8 space-y-2">
            <p className="text-muted-foreground/40 text-xs font-mono">
              SESSION_ID: {Math.random().toString(36).substring(7).toUpperCase()}
            </p>
            <p className="text-muted-foreground/60 text-xs">
              登录有效期 30 天 · 请妥善保管您的访问密码
            </p>
          </div>
        </div>
      </div>

      {/* CSS 动画 */}
      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          25% { transform: translateX(-10px); }
          75% { transform: translateX(10px); }
        }
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-10px); }
        }
        @keyframes fade-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        @keyframes slide-up {
          from { 
            opacity: 0;
            transform: translateY(20px);
          }
          to { 
            opacity: 1;
            transform: translateY(0);
          }
        }
        .animate-shake {
          animation: shake 0.5s ease-in-out;
        }
        .animate-float {
          animation: float 3s ease-in-out infinite;
        }
        .animate-fade-in {
          animation: fade-in 0.5s ease-out;
        }
        .animate-slide-up {
          animation: slide-up 0.6s ease-out;
        }
      `}</style>
    </div>
  )
}