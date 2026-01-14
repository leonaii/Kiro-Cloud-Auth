import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Badge } from '../ui'
import { X, FileJson, FileText, Table, Clipboard, Check, Download } from 'lucide-react'
import { cn } from '@/lib/utils'

type ExportFormat = 'json' | 'txt' | 'csv' | 'clipboard'

interface ExportDialogProps {
  open: boolean
  onClose: () => void
  accounts: Array<{
    email: string
    nickname?: string
    idp?: string
    subscription?: {
      type?: string
      title?: string
    }
    usage?: {
      current?: number
      limit?: number
    }
    credentials?: {
      refreshToken?: string
      accessToken?: string
    }
  }>
  selectedCount: number
}

export function ExportDialog({ open, onClose, accounts, selectedCount }: ExportDialogProps) {
  const [selectedFormat, setSelectedFormat] = useState<ExportFormat>('json')
  const [includeCredentials, setIncludeCredentials] = useState(true)
  const [copied, setCopied] = useState(false)

  if (!open) return null

  const formats: { id: ExportFormat; name: string; icon: typeof FileJson; desc: string }[] = [
    { id: 'json', name: 'JSON', icon: FileJson, desc: '完整数据，可用于导入' },
    { id: 'txt', name: 'TXT', icon: FileText, desc: '纯文本格式，每行一个账号' },
    { id: 'csv', name: 'CSV', icon: Table, desc: 'Excel 兼容格式' },
    { id: 'clipboard', name: '剪贴板', icon: Clipboard, desc: '复制到剪贴板' },
  ]

  // 生成导出内容
  const generateContent = (format: ExportFormat): string => {
    switch (format) {
      case 'json':
        return JSON.stringify({
          version: '1.0',
          exportedAt: new Date().toISOString(),
          accounts: accounts.map(acc => ({
            email: acc.email,
            nickname: acc.nickname,
            idp: acc.idp,
            subscription: acc.subscription,
            usage: acc.usage,
            ...(includeCredentials ? { credentials: acc.credentials } : {})
          }))
        }, null, 2)

      case 'txt':
        return accounts.map(acc => {
          const lines = [
            `邮箱: ${acc.email}`,
            acc.nickname ? `昵称: ${acc.nickname}` : null,
            acc.idp ? `登录方式: ${acc.idp}` : null,
            acc.subscription?.title ? `订阅: ${acc.subscription.title}` : null,
            acc.usage ? `用量: ${acc.usage.current ?? 0}/${acc.usage.limit ?? 0}` : null,
          ].filter(Boolean)
          return lines.join('\n')
        }).join('\n\n---\n\n')

      case 'csv':
        const headers = ['邮箱', '昵称', '登录方式', '订阅类型', '订阅标题', '已用量', '总额度']
        const rows = accounts.map(acc => [
          acc.email,
          acc.nickname || '',
          acc.idp || '',
          acc.subscription?.type || '',
          acc.subscription?.title || '',
          String(acc.usage?.current ?? ''),
          String(acc.usage?.limit ?? '')
        ])
        // 添加 BOM 以支持 Excel 中文
        return '\ufeff' + [headers, ...rows].map(row => 
          row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(',')
        ).join('\n')

      case 'clipboard':
        return accounts.map(acc => 
          `${acc.email}${acc.nickname ? ` (${acc.nickname})` : ''} - ${acc.subscription?.title || '未知订阅'}`
        ).join('\n')

      default:
        return ''
    }
  }

  // 导出处理
  const handleExport = async () => {
    const content = generateContent(selectedFormat)
    const count = accounts.length

    if (selectedFormat === 'clipboard') {
      await navigator.clipboard.writeText(content)
      setCopied(true)
      setTimeout(() => {
        setCopied(false)
        onClose()
      }, 1500)
      return
    }

    const extensions: Record<string, string> = {
      json: 'json',
      txt: 'txt',
      csv: 'csv'
    }
    const filename = `kiro-accounts-${new Date().toISOString().slice(0, 10)}.${extensions[selectedFormat]}`
    
    const success = await window.api.exportToFile(content, filename)
    if (success) {
      alert(`已导出 ${count} 个账号`)
      onClose()
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-0">
      {/* 背景遮罩 */}
      <div 
        className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-all duration-300"
        onClick={onClose}
      />
      
      {/* 对话框 */}
      <div className="relative bg-background/80 backdrop-blur-xl border border-white/10 rounded-xl shadow-2xl w-[450px] animate-in fade-in zoom-in-95 duration-200">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-muted/20">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
              <Download className="h-4 w-4" />
            </div>
            <h2 className="text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">导出账号</h2>
            <Badge variant="secondary" className="bg-background/50 border-white/10 ml-2">
              {selectedCount > 0 ? `${selectedCount} 个选中` : `全部 ${accounts.length} 个`}
            </Badge>
          </div>
          <Button 
            variant="ghost" 
            size="sm" 
            className="h-8 w-8 p-0 hover:bg-white/10 rounded-full"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        
        {/* 格式选择 */}
        <div className="p-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            {formats.map(format => {
              const Icon = format.icon
              const isSelected = selectedFormat === format.id
              return (
                <button
                  key={format.id}
                  onClick={() => setSelectedFormat(format.id)}
                  className={cn(
                    "p-4 rounded-xl border text-left transition-all duration-300 relative overflow-hidden group",
                    isSelected 
                      ? "border-primary/50 bg-primary/10 shadow-sm ring-1 ring-primary/20" 
                      : "border-white/10 bg-background/30 hover:bg-white/5 hover:border-white/20"
                  )}
                >
                  <div className="flex items-center gap-2 mb-1.5 relative z-10">
                    <Icon className={cn("h-4 w-4 transition-colors duration-300", isSelected ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} />
                    <span className={cn("font-semibold transition-colors duration-300", isSelected ? "text-primary" : "text-foreground")}>
                      {format.name}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground relative z-10">{format.desc}</p>
                </button>
              )
            })}
          </div>

          {/* 选项 */}
          {selectedFormat === 'json' && (
            <div className="p-3 bg-muted/30 border border-white/5 rounded-xl animate-in fade-in slide-in-from-top-2 duration-200">
              <label className="flex items-center gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={includeCredentials}
                  onChange={(e) => setIncludeCredentials(e.target.checked)}
                  className="w-4 h-4 rounded border-primary/50 text-primary focus:ring-primary/30 bg-background/50"
                />
                <div>
                  <p className="text-sm font-medium text-foreground">包含凭证信息</p>
                  <p className="text-xs text-muted-foreground mt-0.5">包含 Token 等敏感数据，可用于完整导入</p>
                </div>
              </label>
            </div>
          )}
        </div>

        {/* 底部按钮 */}
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-white/10 bg-muted/20">
          <Button variant="outline" onClick={onClose} className="rounded-xl h-10 px-6 hover:bg-white/10 border-white/10">
            取消
          </Button>
          <Button 
            onClick={handleExport} 
            disabled={copied}
            className="rounded-xl h-10 px-6 shadow-md transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
          >
            {copied ? (
              <>
                <Check className="h-4 w-4 mr-2" />
                已复制
              </>
            ) : selectedFormat === 'clipboard' ? (
              <>
                <Clipboard className="h-4 w-4 mr-2" />
                复制到剪贴板
              </>
            ) : (
              <>
                <Download className="h-4 w-4 mr-2" />
                导出
              </>
            )}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  )
}