import { BarChart3, MessageSquare, Radio } from "lucide-react";
import type { DashboardTab } from "../../types/ui";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

const navItems: Array<{ id: DashboardTab; label: string; icon: typeof Radio }> = [
  { id: "live", label: "Live", icon: Radio },
  { id: "messages", label: "Messages", icon: MessageSquare },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
];

interface SidebarProps {
  activeTab: DashboardTab;
  onTabChange: (tab: DashboardTab) => void;
}

export function Sidebar({ activeTab, onTabChange }: SidebarProps) {
  return (
    <aside className="hidden w-72 shrink-0 border-r border-border bg-card/60 p-5 backdrop-blur md:block">
      <div className="mb-8 flex items-center gap-3">
        <img src="/logo.svg" alt="GMW" className="h-11 w-11 rounded-2xl" />
        <div>
          <div className="flex items-baseline gap-2">
            <span className="font-bold tracking-tight text-primary text-lg">GMW</span>
            <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">v1.0</span>
          </div>
          <div className="text-xs text-muted-foreground">Discord Moderation Watcher</div>
        </div>
      </div>
      <nav className="space-y-2">
        {navItems.map((item) => {
          const Icon = item.icon;
          return (
            <Button
              key={item.id}
              variant={activeTab === item.id ? "secondary" : "ghost"}
              className={cn("w-full justify-start", activeTab === item.id && "bg-primary/15 text-primary")}
              onClick={() => onTabChange(item.id)}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Button>
          );
        })}
      </nav>
    </aside>
  );
}
