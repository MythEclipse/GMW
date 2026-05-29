import { Wifi, WifiOff } from "lucide-react";
import type { WebSocketStatus } from "../../hooks/useDashboardSocket";
import type { DashboardTab } from "../../types/ui";
import type { VoiceStatus } from "../../types/voice";
import { Badge } from "../ui/badge";

const titles: Record<DashboardTab, string> = {
  voice: "Voice Control",
  media: "Media Player",
  messages: "Messages",
  recordings: "Voice Recordings",
  analytics: "Analytics & Insights",
  review: "Moderation Review",
};

interface HeaderProps {
  activeTab: DashboardTab;
  wsStatus: WebSocketStatus;
  voiceStatus: VoiceStatus;
}

export function Header({ activeTab, wsStatus, voiceStatus }: HeaderProps) {
  return (
    <header className="sticky top-0 z-10 border-b border-border bg-background/80 px-4 py-4 backdrop-blur md:px-8">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{titles[activeTab]}</h1>
          <p className="text-sm text-muted-foreground">Voice, media, and moderation in one dashboard.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Badge variant={wsStatus === "connected" ? "success" : wsStatus === "error" ? "destructive" : "warning"}>
            {wsStatus === "connected" ? <Wifi className="mr-1 h-3 w-3" /> : <WifiOff className="mr-1 h-3 w-3" />}
            WebSocket {wsStatus}
          </Badge>
          <Badge variant={voiceStatus.connected ? "success" : "secondary"}>
            Voice {voiceStatus.connected ? voiceStatus.activeChannelName || "connected" : "idle"}
          </Badge>
        </div>
      </div>
    </header>
  );
}
