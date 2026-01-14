import { createPortal } from 'react-dom'
import { Button, Badge } from '@/components/ui'
import { History, Trash2, X, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

interface HistoryDialogProps {
  open: boolean
  onClose: () => void
  history: any[]
  accounts: Map<string, any>
  onClear: () => void
  onCopy: (text: string) => void
  formatTime: (timestamp: number) => string
}

export function HistoryDialog({ open, onClose, history, accounts, onClear, onCopy, formatTime }: HistoryDialogProps) {
  if (!open) return null

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-0">
      {/* 背景遮罩 */}
      <div
        className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-all duration-300"
        onClick={onClose}
      />

      {/* 对话框内容 */}
      <div className="relative bg-background/80 backdrop-blur-xl border border-white/10 rounded-2xl shadow-2xl w-[550px] max-h-[80vh] flex flex-col animate-in fade-in zoom-in-95 duration-200">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 bg-muted/20">
          <div className="flex items-center gap-3">
            <div className="p-1.5 rounded-lg bg-primary/10 text-primary">
                <History className="h-5 w-5" />
            </div>
            <h2 className="text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">变更历史</h2>
            <Badge variant="secondary" className="bg-background/50 border-white/10">{history.length} 条</Badge>
          </div>
          <div className="flex items-center gap-2">
            {history.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onClear}
                className="text-destructive hover:text-destructive hover:bg-destructive/10 rounded-lg h-8 px-2"
              >
                <Trash2 className="h-4 w-4 mr-1.5" />
                清空
              </Button>
            )}
            <Button
              variant="ghost"
              size="sm"
              className="h-8 w-8 p-0 hover:bg-white/10 rounded-full"
              onClick={onClose}
            >
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* 历史列表 */}
        <div className="flex-1 overflow-y-auto p-6">
          {history.length > 0 ? (
            <div className="space-y-3">
              {[...history].reverse().map((entry, index) => (
                <div key={entry.id} className="p-4 bg-white/5 rounded-xl border border-white/5 hover:border-white/10 transition-colors group">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2.5">
                      <span className="text-xs text-muted-foreground/70 font-mono">#{history.length - index}</span>
                      <Badge
                        variant="secondary"
                        className={cn(
                          "text-[10px] px-1.5 py-0 whitespace-nowrap border-0",
                          entry.action === 'initial' && "bg-blue-500/10 text-blue-600 dark:text-blue-400",
                          entry.action === 'manual' && "bg-purple-500/10 text-purple-600 dark:text-purple-400",
                          entry.action === 'auto_switch' && "bg-green-500/10 text-green-600 dark:text-green-400",
                          entry.action === 'restore' && "bg-orange-500/10 text-orange-600 dark:text-orange-400",
                          entry.action === 'bind' && "bg-cyan-500/10 text-cyan-600 dark:text-cyan-400"
                        )}
                      >
                        {entry.action === 'initial' && '初始'}
                        {entry.action === 'manual' && '手动'}
                        {entry.action === 'auto_switch' && '自动'}
                        {entry.action === 'restore' && '恢复'}
                        {entry.action === 'bind' && '绑定'}
                      </Badge>
                    </div>
                    <span className="text-xs text-muted-foreground font-mono">
                      {formatTime(entry.timestamp)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 p-2.5 bg-black/20 rounded-lg border border-white/5 group-hover:border-white/10 transition-colors">
                    <code className="text-sm flex-1 font-mono text-foreground/90">{entry.machineId}</code>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 w-6 p-0 shrink-0 hover:bg-white/10 rounded"
                      onClick={() => onCopy(entry.machineId)}
                      title="复制"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  {entry.accountId && (
                    <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                        <div className="w-1.5 h-1.5 rounded-full bg-primary/30" />
                        关联账户: <span className="text-foreground/80">{accounts.get(entry.accountId)?.nickname || accounts.get(entry.accountId)?.email || entry.accountId}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center py-12">
              <History className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
              <p className="text-muted-foreground font-medium">暂无变更记录</p>
              <p className="text-sm text-muted-foreground/50">机器码变更后将自动记录</p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body
  )
}