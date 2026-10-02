import type { QueryClient } from "@tanstack/react-query"
import { createRootRouteWithContext, Link, Outlet } from "@tanstack/react-router"
import { MoonIcon, SunIcon } from "lucide-react"
import { Button } from "@workspace/ui/components/button"
import { useTheme } from "@/components/theme-provider.tsx"

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: Root,
  notFoundComponent: () => <p className="text-muted-foreground p-6 text-sm">Nothing here.</p>,
})

function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const dark = theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Toggle dark mode" onClick={() => setTheme(dark ? "light" : "dark")}>
      {dark ? <SunIcon /> : <MoonIcon />}
    </Button>
  )
}

function Root() {
  return (
    <div className="bg-background text-foreground min-h-svh">
      <header className="border-b">
        <div className="mx-auto flex h-12 max-w-3xl items-center justify-between px-4">
          <Link to="/" search={{ view: "inbox" }} className="flex items-center gap-2">
            <img src="/logo.png" alt="" className="size-7 rounded-md" />
            <span className="text-xl leading-none font-extrabold tracking-[-0.02em]" style={{ fontFamily: '"Syne", sans-serif' }}>
              grain
            </span>
            <span className="text-muted-foreground text-sm font-medium">support</span>
          </Link>
          <ThemeToggle />
        </div>
      </header>
      <Outlet />
    </div>
  )
}
