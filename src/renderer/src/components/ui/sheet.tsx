import * as React from "react"
import { createPortal } from "react-dom"
import { X } from "lucide-react"
import { cn } from "@/lib/utils"

interface SheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
  side?: "left" | "right" | "top" | "bottom"
  className?: string
}

// 创建 Context 以便子组件可以访问 side 属性
const SheetContext = React.createContext<{ side: "left" | "right" | "top" | "bottom" }>({ side: "right" })

export function Sheet({
  open,
  onOpenChange,
  children,
  side = "right",
  className
}: SheetProps) {
  const [isVisible, setIsVisible] = React.useState(false)
  const [isAnimating, setIsAnimating] = React.useState(false)

  React.useEffect(() => {
    if (open) {
      setIsVisible(true)
      // Small delay to allow render before animation
      requestAnimationFrame(() => setIsAnimating(true))
    } else {
      setIsAnimating(false)
      const timer = setTimeout(() => setIsVisible(false), 300) // Match transition duration
      return () => clearTimeout(timer)
    }
  }, [open])

  if (!isVisible) return null

  const sideStyles = {
    left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
    right: "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm",
    top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
    bottom: "inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
  }

  const transformStyles = {
    left: isAnimating ? "translate-x-0" : "-translate-x-full",
    right: isAnimating ? "translate-x-0" : "translate-x-full",
    top: isAnimating ? "translate-y-0" : "-translate-y-full",
    bottom: isAnimating ? "translate-y-0" : "translate-y-full",
  }

  return createPortal(
    <SheetContext.Provider value={{ side }}>
      <div className="fixed inset-0 z-[100] flex">
        {/* Overlay */}
        <div
          className={cn(
            "fixed inset-0 bg-black/80 transition-opacity duration-300 ease-in-out",
            isAnimating ? "opacity-100" : "opacity-0"
          )}
          onClick={() => onOpenChange(false)}
        />
        
        {/* Content Wrapper - 负责定位和动画 */}
        <div
          className={cn(
            "fixed z-[101] bg-background shadow-lg transition-transform duration-300 ease-in-out",
            sideStyles[side],
            transformStyles[side],
            className
          )}
        >
          {children}
          <button
            className="absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary"
            onClick={() => onOpenChange(false)}
          >
            <X className="h-4 w-4" />
            <span className="sr-only">Close</span>
          </button>
        </div>
      </div>
    </SheetContext.Provider>,
    document.body
  )
}

interface SheetContentProps {
  children: React.ReactNode
  className?: string
  side?: "left" | "right" | "top" | "bottom" // 允许覆盖 side，虽然通常由 Sheet 控制
}

export function SheetContent({ children, className, side }: SheetContentProps) {
  // 这里我们实际上不需要 side prop，因为 Sheet 组件控制了外层容器
  // 但为了兼容性，我们保留它
  return <div className={cn("flex flex-col h-full p-6", className)}>{children}</div>
}

export function SheetHeader({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-col space-y-2 text-center sm:text-left", className)}>{children}</div>
}

export function SheetTitle({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("text-lg font-semibold text-foreground", className)}>{children}</div>
}