import { Bot, BarChart3, MessageSquare, Music2, ShieldAlert, Volume2, Mic } from "lucide-react";
import type { DashboardTab } from "../../types/ui";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

const navItems: Array<{ id: DashboardTab; label: string; icon: typeof Volume2 }> = [
  { id: "voice", label: "Voice", icon: Volume2 },
  { id: "media", label: "Media", icon: Music2 },
  { id: "messages", label: "Messages", icon: MessageSquare },
  { id: "recordings", label: "Recordings", icon: Mic },
  { id: "analytics", label: "Analytics", icon: BarChart3 },
  { id: "review", label: "Review", icon: ShieldAlert },
];

interface SidebarProps {
  activeTab: DashboardTab;
  onTabChange: (tab: DashboardTab) => void;
}

export function Sidebar({ activeTab, onTabChange }: SidebarProps) {
  return (
    <aside className="hidden w-72 shrink-0 border-r border-border bg-card/60 p-5 backdrop-blur md:block">
      <div className="mb-8 flex items-center gap-3">
        <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/15 text-primary">
          <Bot className="h-6 w-6" />
        </div>
        <div>
          <div className="font-semibold tracking-tight">Bete Watcher</div>
          <div className="text-xs text-muted-foreground">Discord control center</div>
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
