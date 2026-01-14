import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle, Button, PageHeader } from '../ui'
import { Github, Heart, Code, Info, Zap } from 'lucide-react'
import kiroLogo from '@/assets/icon.png'
import { useAccountsStore } from '@/store/accounts'
import { cn } from '@/lib/utils'

export function AboutPage() {
  const [version, setVersion] = useState('...')
  const { darkMode } = useAccountsStore()

  useEffect(() => {
    window.api.getAppVersion().then(setVersion)
  }, [])

  return (
    <div className="flex-1 p-6 space-y-6 overflow-auto">
      {/* Header */}
      <PageHeader
        title="Kiro 账户管理器"
        description={`版本 ${version}`}
        icon={
          <img
            src={kiroLogo}
            alt="Kiro"
            className={cn("h-12 w-auto transition-all", darkMode && "invert brightness-0")}
          />
        }
      >
      </PageHeader>

      {/* Description */}
      <Card className="border border-border/40 shadow-sm bg-card/50 backdrop-blur-sm hover:shadow-md transition-all duration-300">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Info className="h-4 w-4 text-primary" />
            </div>
            关于本应用
          </CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground space-y-3">
          <p>
            Kiro 账户管理器是一个功能强大的 Kiro IDE 多账号管理工具。
            支持多账号快速切换、自动 Token 刷新、分组标签管理、机器码管理等功能，
            帮助你高效管理和使用多个 Kiro 账号。
          </p>
        </CardContent>
      </Card>

      {/* Features */}
      <Card className="border border-border/40 shadow-sm bg-card/50 backdrop-blur-sm hover:shadow-md transition-all duration-300">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Zap className="h-4 w-4 text-primary" />
            </div>
            主要功能
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-2 text-sm text-muted-foreground">
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>多账号管理</strong>：支持添加、编辑、删除多个 Kiro 账号
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>一键切换</strong>：快速切换当前使用的账号
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>自动刷新</strong>：Token 过期前自动刷新，保持登录状态
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>分组与标签</strong>：多选账户批量设置分组/标签
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>OpenAI 兼容 API</strong>：支持 /v1/chat/completions 接口
            </li>
            <li className="flex items-start gap-2">
              <span className="text-primary mt-0.5">✓</span>
              <strong>负载均衡</strong>：自动选择低负载账号处理请求
            </li>
          </ul>
        </CardContent>
      </Card>

      {/* Tech Stack */}
      <Card className="border border-border/40 shadow-sm bg-card/50 backdrop-blur-sm hover:shadow-md transition-all duration-300">
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-3">
            <div className="p-2 rounded-lg bg-primary/10">
              <Code className="h-4 w-4 text-primary" />
            </div>
            技术栈
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {['Electron', 'React', 'TypeScript', 'Tailwind CSS', 'Zustand', 'Vite', 'Node.js', 'MySQL'].map((tech) => (
              <span
                key={tech}
                className="px-2.5 py-1 text-xs bg-muted rounded-full text-muted-foreground"
              >
                {tech}
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Footer */}
      <div className="text-center text-xs text-muted-foreground py-4">
        <p className="flex items-center justify-center gap-1">
          Made with <Heart className="h-3 w-3 text-primary" /> for Kiro users
        </p>
      </div>
    </div>
  )
}
