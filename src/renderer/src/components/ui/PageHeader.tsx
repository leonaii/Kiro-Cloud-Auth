import { cn } from '@/lib/utils'
import { ReactNode } from 'react'

interface PageHeaderProps {
  title: string
  description?: string
  icon?: ReactNode
  className?: string
  children?: ReactNode
}

export function PageHeader({ title, description, icon, className, children }: PageHeaderProps) {
  return (
    <div className={cn("relative overflow-hidden rounded-2xl bg-gradient-to-r from-primary/10 via-primary/5 to-primary/10 p-8 border border-primary/10 shadow-sm", className)}>
      <div className="absolute top-0 right-0 w-64 h-64 bg-gradient-to-br from-primary/20 to-transparent rounded-full blur-3xl opacity-60 pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-48 h-48 bg-gradient-to-tr from-primary/20 to-transparent rounded-full blur-3xl opacity-60 pointer-events-none" />
      <div className="relative flex items-center gap-5">
        {icon && (
          <div className="p-3.5 rounded-2xl bg-gradient-to-br from-primary to-primary/80 shadow-lg shadow-primary/25 ring-1 ring-white/20 flex items-center justify-center text-primary-foreground">
            {icon}
          </div>
        )}
        <div className="flex-1 space-y-1">
          <h1 className="text-2xl font-bold text-foreground tracking-tight">{title}</h1>
          {description && <p className="text-muted-foreground">{description}</p>}
        </div>
        {children && <div className="flex items-center gap-2">{children}</div>}
      </div>
    </div>
  )
}