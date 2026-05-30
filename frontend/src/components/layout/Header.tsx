import { Wifi, WifiOff, Shield } from "lucide-react";
import type { WebSocketStatus } from "../../hooks/useDashboardSocket";
import type { DashboardTab } from "../../types/ui";
import type { VoiceStatus } from "../../types/voice";
import { Badge } from "../ui/badge";

const titles: Record<DashboardTab, string> = {
  live: "Voice, Media & Recordings",
  messages: "Messages & Moderation",
  analytics: "Analytics & Insights",
};

const subtitles: Record<DashboardTab, string> = {
  live: "Join voice channels, play media, stream audio, and browse recordings.",
  messages: "Capture, analyse, and moderate Discord messages.",
  analytics: "Server moderation statistics and trends.",
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
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Shield className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight">{titles[activeTab]}</h1>
            <p className="text-sm text-muted-foreground">{subtitles[activeTab]}</p>
          </div>
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
