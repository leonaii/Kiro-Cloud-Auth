import { useState } from 'react'
import { Button, Card, CardContent, CardHeader, CardTitle } from '../ui'
import { Upload, Layers, RefreshCw, AlertTriangle, X } from 'lucide-react'

interface ImportDialogProps {
  open: boolean
  onClose: () => void
  onConfirm: (mode: 'merge' | 'overwrite') => void
  isLoading?: boolean
}

export function ImportDialog({ open, onClose, onConfirm, isLoading }: ImportDialogProps) {
  const [selectedMode, setSelectedMode] = useState<'merge' | 'overwrite'>('merge')
  const [confirmOverwrite, setConfirmOverwrite] = useState(false)

  if (!open) return null

  const handleConfirm = () => {
    if (selectedMode === 'overwrite' && !confirmOverwrite) {
      return
    }
    onConfirm(selectedMode)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-0">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm transition-all duration-300" onClick={onClose} />
      <Card className="relative w-full max-w-md mx-4 shadow-2xl bg-background/80 backdrop-blur-xl border-white/10 animate-in fade-in zoom-in-95 duration-300">
        <CardHeader className="pb-4 border-b border-white/10 bg-muted/20">
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2 text-lg font-bold bg-clip-text text-transparent bg-gradient-to-r from-foreground to-foreground/70">
              <Upload className="h-5 w-5 text-primary" />
              选择导入模式
            </CardTitle>
            <Button variant="ghost" size="sm" onClick={onClose} className="h-8 w-8 p-0 hover:bg-white/10 rounded-full">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 pt-6">
          {/* 增量模式 */}
          <div
            className={`p-4 rounded-xl border cursor-pointer transition-all duration-300 ${
              selectedMode === 'merge'
                ? 'border-primary/50 bg-primary/10 shadow-sm ring-1 ring-primary/20'
                : 'border-white/10 bg-background/30 hover:bg-white/5 hover:border-white/20'
            }`}
            onClick={() => {
              setSelectedMode('merge')
              setConfirmOverwrite(false)
            }}
          >
            <div className="flex items-start gap-3">
              <div className={`p-2.5 rounded-xl transition-colors duration-300 ${selectedMode === 'merge' ? 'bg-primary text-primary-foreground shadow-md' : 'bg-muted/50 text-muted-foreground'}`}>
                <Layers className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <p className="font-semibold text-foreground">增量导入</p>
                <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                  合并新数据到现有数据中，已存在的账号会跳过，不会删除任何数据
                </p>
                <div className="mt-3 text-xs text-green-600 dark:text-green-400 flex items-center gap-1.5 font-medium">
                  <span className="inline-block w-2 h-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.5)]" />
                  推荐 · 安全
                </div>
              </div>
            </div>
          </div>

          {/* 覆盖模式 */}
          <div
            className={`p-4 rounded-xl border cursor-pointer transition-all duration-300 ${
              selectedMode === 'overwrite'
                ? 'border-destructive/50 bg-destructive/10 shadow-sm ring-1 ring-destructive/20'
                : 'border-white/10 bg-background/30 hover:bg-white/5 hover:border-white/20'
            }`}
            onClick={() => setSelectedMode('overwrite')}
          >
            <div className="flex items-start gap-3">
              <div className={`p-2.5 rounded-xl transition-colors duration-300 ${selectedMode === 'overwrite' ? 'bg-destructive text-destructive-foreground shadow-md' : 'bg-muted/50 text-muted-foreground'}`}>
                <RefreshCw className="h-5 w-5" />
              </div>
              <div className="flex-1">
                <p className="font-semibold text-foreground">覆盖导入</p>
                <p className="text-sm text-muted-foreground mt-1 leading-relaxed">
                  清空所有现有数据，然后导入文件中的数据
                </p>
                <div className="mt-3 text-xs text-destructive flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  危险操作 · 数据将被清空
                </div>
              </div>
            </div>
          </div>

          {/* 覆盖模式确认 */}
          {selectedMode === 'overwrite' && (
            <div className="p-3 bg-destructive/10 rounded-xl border border-destructive/20 animate-in fade-in slide-in-from-top-2 duration-200">
              <label className="flex items-start gap-3 cursor-pointer select-none">
                <input
                  type="checkbox"
                  className="mt-1 w-4 h-4 rounded border-destructive/50 text-destructive focus:ring-destructive/30 bg-background/50"
                  checked={confirmOverwrite}
                  onChange={(e) => setConfirmOverwrite(e.target.checked)}
                />
                <span className="text-sm text-destructive font-medium">
                  我已知晓此操作将清空所有现有数据，且无法恢复
                </span>
              </label>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-4 border-t border-white/10">
            <Button variant="outline" onClick={onClose} className="rounded-xl h-10 px-6 hover:bg-white/10 border-white/10">
              取消
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={isLoading || (selectedMode === 'overwrite' && !confirmOverwrite)}
              variant={selectedMode === 'overwrite' ? 'destructive' : 'default'}
              className="rounded-xl h-10 px-6 shadow-md transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]"
            >
              {isLoading ? '导入中...' : '开始导入'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}