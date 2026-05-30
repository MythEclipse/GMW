import type { ModerationBreakdown } from "../../api/analytics";
import { Card, CardContent } from "../ui/card";
import { cn } from "../../lib/utils";

interface SummaryCardsProps {
  messages: ModerationBreakdown | null;
  activeUsersCount: number;
  totalChannels: number;
  loading: boolean;
}

export function SummaryCards({ messages, activeUsersCount, totalChannels, loading }: SummaryCardsProps) {
  const avgPerHour = messages ? Math.round(messages.total / Math.max(1, 24)) : 0;
  const cleanPct = messages && messages.total > 0 ? Math.round((messages.clean / messages.total) * 100) : 0;
  const warnedPct = messages && messages.total > 0 ? Math.round((messages.warned / messages.total) * 100) : 0;
  const flaggedPct = messages && messages.total > 0 ? Math.round((messages.flagged / messages.total) * 100) : 0;

  const cards = [
    { label: "Total Pesan", value: formatNum(messages?.total), accent: "text-foreground" },
    { label: "Rata-rata/jam", value: formatNum(avgPerHour), accent: "text-muted-foreground" },
    { label: "Clean", value: cleanPct > 0 ? `${cleanPct}%` : "—", accent: "text-emerald-400" },
    { label: "Warned", value: warnedPct > 0 ? `${warnedPct}%` : "—", accent: "text-amber-400" },
    { label: "Flagged", value: flaggedPct > 0 ? `${flaggedPct}%` : "—", accent: "text-red-400" },
    { label: "Pending", value: formatNum(messages?.pending), accent: "text-slate-400" },
    { label: "User Aktif", value: formatNum(activeUsersCount), accent: "text-violet-400" },
    { label: "Channel", value: formatNum(totalChannels), accent: "text-blue-400" },
  ];

  return (
    <div className="grid grid-cols-4 gap-2 lg:grid-cols-8">
      {cards.map((card) => (
        <Card key={card.label} className="overflow-hidden">
          <CardContent className="p-3">
            <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {card.label}
            </div>
            <div className={cn("mt-1 font-mono text-lg font-bold tabular-nums", card.accent)}>
              {loading ? (
                <span className="animate-pulse">…</span>
              ) : (
                card.value
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function formatNum(v: number | undefined | null): string {
  if (v == null || v === 0) return "—";
  return v.toLocaleString("id-ID");
}
