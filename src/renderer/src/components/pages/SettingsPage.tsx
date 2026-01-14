import { useAccountsStore } from '@/store/accounts'
import { Card, CardContent, CardHeader, CardTitle, Button } from '../ui'
import { Palette, Moon, Sun, Fingerprint, Info, ChevronDown, ChevronUp, Settings, Eye, EyeOff, RefreshCw, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useState } from 'react'
import { isElectron } from '@/lib/api'

// 主题配置 - 按色系分组
const themeGroups = [
  {
    name: '蓝色系',
    themes: [
      { id: 'default', name: '天空蓝', color: '#3b82f6' },
      { id: 'indigo', name: '靛蓝', color: '#6366f1' },
      { id: 'cyan', name: '清新青', color: '#06b6d4' },
      { id: 'sky', name: '晴空蓝', color: '#0ea5e9' },
      { id: 'teal', name: '水鸭蓝', color: '#14b8a6' },
    ]
  },
  {
    name: '紫红系',
    themes: [
      { id: 'purple', name: '优雅紫', color: '#a855f7' },
      { id: 'violet', name: '紫罗兰', color: '#8b5cf6' },
      { id: 'fuchsia', name: '洋红', color: '#d946ef' },
      { id: 'pink', name: '粉红', color: '#ec4899' },
      { id: 'rose', name: '玫瑰红', color: '#f43f5e' },
    ]
  },
  {
    name: '暖色系',
    themes: [
      { id: 'red', name: '热情红', color: '#ef4444' },
      { id: 'orange', name: '活力橙', color: '#f97316' },
      { id: 'amber', name: '琥珀金', color: '#f59e0b' },
      { id: 'yellow', name: '明黄', color: '#eab308' },
    ]
  },
  {
    name: '绿色系',
    themes: [
      { id: 'emerald', name: '翠绿', color: '#10b981' },
      { id: 'green', name: '草绿', color: '#22c55e' },
      { id: 'lime', name: '青柠', color: '#84cc16' },
    ]
  },
  {
    name: '中性色',
    themes: [
      { id: 'slate', name: '石板灰', color: '#64748b' },
      { id: 'zinc', name: '锌灰', color: '#71717a' },
      { id: 'stone', name: '暖灰', color: '#78716c' },
      { id: 'neutral', name: '中性灰', color: '#737373' },
    ]
  }
]

export function SettingsPage(): React.JSX.Element {
  const {
    theme,
    darkMode,
    setTheme,
    setDarkMode,
    privacyMode,
    setPrivacyMode,
    autoRefreshEnabled,
    autoRefreshInterval,
    setAutoRefresh
  } = useAccountsStore()

  const [themeExpanded, setThemeExpanded] = useState(false)
  const electron = isElectron()

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* 页面头部 - 简洁风格 */}
      <div className="px-0 py-1 shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 text-primary shadow-sm">
            <Settings className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-lg font-bold tracking-tight">应用设置</h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              配置应用的各项功能与个性化选项
            </p>
          </div>
        </div>
      </div>

      {/* 主题设置 */}
      <Card className="border border-border/40 shadow-sm bg-card/50 backdrop-blur-sm hover:shadow-md transition-all duration-300">
        <CardHeader className="pb-4">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              <Palette className="h-4.5 w-4.5" />
            </div>
            主题设置
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* 深色模式 */}
          <div className="flex items-center justify-between p-1">
            <div>
              <p className="font-medium text-sm">深色模式</p>
              <p className="text-xs text-muted-foreground mt-0.5">切换深色/浅色主题</p>
            </div>
            <Button
              variant={darkMode ? "default" : "outline"}
              size="sm"
              onClick={() => setDarkMode(!darkMode)}
              className="rounded-full px-4"
            >
              {darkMode ? <Moon className="h-3.5 w-3.5 mr-2" /> : <Sun className="h-3.5 w-3.5 mr-2" />}
              {darkMode ? '深色' : '浅色'}
            </Button>
          </div>

          {/* 主题颜色 */}
          <div className="pt-4 border-t border-border/50">
            <button
              className="flex items-center justify-between w-full text-left group"
              onClick={() => setThemeExpanded(!themeExpanded)}
            >
              <div className="flex items-center gap-3">
                <p className="font-medium text-sm group-hover:text-primary transition-colors">主题颜色</p>
                {!themeExpanded && (
                  <div
                    className="w-5 h-5 rounded-full ring-2 ring-primary/30 ring-offset-2 ring-offset-card shadow-sm"
                    style={{ backgroundColor: themeGroups.flatMap(g => g.themes).find(t => t.id === theme)?.color || '#3b82f6' }}
                  />
                )}
              </div>
              {themeExpanded ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground group-hover:text-primary transition-colors" />
              )}
            </button>
            {themeExpanded && (
              <div className="space-y-4 mt-4 animate-in slide-in-from-top-2 duration-200">
                {themeGroups.map((group) => (
                  <div key={group.name} className="flex items-center gap-4">
                    <span className="text-xs font-medium text-muted-foreground w-12 shrink-0">{group.name}</span>
                    <div className="flex flex-wrap gap-2.5">
                      {group.themes.map((t) => (
                        <button
                          key={t.id}
                          className={cn(
                            "group relative w-8 h-8 rounded-full transition-all duration-300 flex items-center justify-center",
                            theme === t.id
                              ? 'ring-2 ring-primary ring-offset-2 ring-offset-card scale-110 shadow-md'
                              : 'hover:scale-110 hover:shadow-md hover:ring-2 hover:ring-primary/20 hover:ring-offset-1'
                          )}
                          style={{ backgroundColor: t.color }}
                          onClick={() => setTheme(t.id)}
                          title={t.name}
                        >
                          {theme === t.id && <Check className="w-3.5 h-3.5 text-white drop-shadow-md" />}
                          <span className="absolute -bottom-7 left-1/2 -translate-x-1/2 text-[10px] text-foreground font-medium whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity bg-popover px-2 py-1 rounded-md shadow-lg border pointer-events-none z-10">
                            {t.name}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* 隐私设置 */}
      <Card className="border border-border/40 shadow-sm bg-card/50 backdrop-blur-sm hover:shadow-md transition-all duration-300">
        <CardHeader className="pb-4">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10 text-primary">
              {privacyMode ? <EyeOff className="h-4.5 w-4.5" /> : <Eye className="h-4.5 w-4.5" />}
            </div>
            隐私设置
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between p-1">
            <div>
              <p className="font-medium text-sm">隐私模式</p>
              <p className="text-xs text-muted-foreground mt-0.5">隐藏邮箱和账号敏感信息</p>
            </div>
            <Button
              variant={privacyMode ? "default" : "outline"}
              size="sm"
              onClick={() => setPrivacyMode(!privacyMode)}
              className="rounded-full px-4"
            >
              {privacyMode ? <EyeOff className="h-3.5 w-3.5 mr-2" /> : <Eye className="h-3.5 w-3.5 mr-2" />}
              {privacyMode ? '已开启' : '已关闭'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Token 刷新设置 */}
      {/* {!electron && (
        <Card className="border border-border/40 shadow-sm bg-card/50 backdrop-blur-sm hover:shadow-md transition-all duration-300">
          <CardHeader className="pb-4">
            <CardTitle className="text-base flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10 text-primary">
                <RefreshCw className="h-4.5 w-4.5" />
              </div>
              自动刷新
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-between p-1">
              <div>
                <p className="font-medium text-sm">自动刷新</p>
                <p className="text-xs text-muted-foreground mt-0.5">Token 过期前自动刷新，并同步更新账户信息</p>
              </div>
              <Button
                variant={autoRefreshEnabled ? "default" : "outline"}
                size="sm"
                onClick={() => setAutoRefresh(!autoRefreshEnabled)}
                className="rounded-full px-4"
              >
                {autoRefreshEnabled ? '已开启' : '已关闭'}
              </Button>
            </div>

            {autoRefreshEnabled && (
              <div className="animate-in fade-in slide-in-from-top-2 duration-300">
                <div className="text-xs text-muted-foreground bg-muted/40 rounded-lg p-4 space-y-1.5 border border-border/50">
                  <p className="flex items-center gap-2"><div className="w-1 h-1 rounded-full bg-primary/50" /> Token 即将过期时自动刷新，保持登录状态</p>
                  <p className="flex items-center gap-2"><div className="w-1 h-1 rounded-full bg-primary/50" /> Token 刷新后自动更新账户用量、订阅等信息</p>
                  <p className="flex items-center gap-2"><div className="w-1 h-1 rounded-full bg-primary/50" /> 开启自动换号时，会定期检查所有账户余额</p>
                </div>
                <div className="flex items-center justify-between pt-4 mt-4 border-t border-border/50">
                  <div>
                    <p className="font-medium text-sm">检查间隔</p>
                    <p className="text-xs text-muted-foreground mt-0.5">每隔多久检查一次账户状态</p>
                  </div>
                  <select
                    className="w-[140px] h-9 px-3 rounded-lg border border-input bg-background/50 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all"
                    value={autoRefreshInterval}
                    onChange={(e) => setAutoRefresh(true, parseInt(e.target.value))}
                  >
                    <option value="1">1 分钟</option>
                    <option value="3">3 分钟</option>
                    <option value="5">5 分钟</option>
                    <option value="10">10 分钟</option>
                    <option value="15">15 分钟</option>
                    <option value="20">20 分钟</option>
                    <option value="30">30 分钟</option>
                    <option value="45">45 分钟</option>
                    <option value="60">60 分钟</option>
                  </select>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )} */}

      {/* 自动换号设置 - 已禁用
      <Card className="border-0 shadow-sm hover:shadow-md transition-shadow duration-200">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Repeat className="h-4 w-4 text-primary" />
            </div>
            自动换号
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">启用自动换号</p>
              <p className="text-sm text-muted-foreground">余额不足时自动切换到其他可用账号</p>
            </div>
            <Button
              variant={autoSwitchEnabled ? "default" : "outline"}
              size="sm"
              onClick={() => setAutoSwitch(!autoSwitchEnabled)}
            >
              {autoSwitchEnabled ? '已开启' : '已关闭'}
            </Button>
          </div>

          {autoSwitchEnabled && (
            <>
              <div className="flex items-center justify-between pt-2 border-t">
                <div>
                  <p className="font-medium">余额阈值</p>
                  <p className="text-sm text-muted-foreground">余额低于此值时自动切换</p>
                </div>
                <input
                  type="number"
                  className="w-20 h-9 px-3 rounded-lg border bg-background text-sm text-center focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                  value={autoSwitchThreshold}
                  min={0}
                  onChange={(e) => setAutoSwitch(true, parseInt(e.target.value) || 0)}
                />
              </div>

              <div className="flex items-center justify-between pt-2 border-t">
                <div>
                  <p className="font-medium flex items-center gap-2">
                    <Clock className="h-4 w-4" />
                    检查间隔
                  </p>
                  <p className="text-sm text-muted-foreground">每隔多久检查一次余额</p>
                </div>
                <select
                  className="h-9 px-3 rounded-lg border bg-background text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary"
                  value={autoSwitchInterval}
                  onChange={(e) => setAutoSwitch(true, undefined, parseInt(e.target.value))}
                >
                  <option value="1">1 分钟</option>
                  <option value="3">3 分钟</option>
                  <option value="5">5 分钟</option>
                  <option value="10">10 分钟</option>
                  <option value="15">15 分钟</option>
                  <option value="30">30 分钟</option>
                </select>
              </div>
            </>
          )}
        </CardContent>
      </Card>
      */}

      {/* 机器码管理提示 - 仅 Electron 显示 */}
      {/* {electron && (
        <Card className="border-0 shadow-sm bg-primary/5 border-primary/20 hover:shadow-md transition-shadow duration-200">
          <CardContent className="py-4">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-primary/10">
                <Fingerprint className="h-5 w-5 text-primary" />
              </div>
              <div className="flex-1">
                <p className="font-medium text-sm">机器码管理</p>
                <p className="text-xs text-muted-foreground">
                  修改设备标识符、切号自动换码、账户机器码绑定等功能
                </p>
              </div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Info className="h-3 w-3" />
                <span>请在侧边栏「机器码」中设置</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )} */}

      {/* 数据管理 - 已禁用
      <Card className="border-0 shadow-sm hover:shadow-md transition-shadow duration-200">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Database className="h-4 w-4 text-primary" />
            </div>
            数据管理
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium">导出数据</p>
              <p className="text-sm text-muted-foreground">支持 JSON、TXT、CSV、剪贴板等多种格式</p>
            </div>
            <Button variant="outline" size="sm" onClick={handleExport}>
              <Download className="h-4 w-4 mr-2" />
              导出
            </Button>
          </div>

          <div className="flex items-center justify-between pt-2 border-t">
            <div>
              <p className="font-medium">导入数据</p>
              <p className="text-sm text-muted-foreground">从 JSON 文件导入账号数据</p>
            </div>
            <Button variant="outline" size="sm" onClick={handleImportClick} disabled={isImporting}>
              <Upload className="h-4 w-4 mr-2" />
              导入
            </Button>
          </div>

          <div className="flex items-center justify-between pt-2 border-t">
            <div>
              <p className="font-medium text-destructive">清除所有数据</p>
              <p className="text-sm text-muted-foreground">删除所有账号、分组和标签</p>
            </div>
            <Button variant="destructive" size="sm" onClick={handleClearData}>
              <Trash2 className="h-4 w-4 mr-2" />
              清除
            </Button>
          </div>
        </CardContent>
      </Card>
      */}

    </div>
  )
}
