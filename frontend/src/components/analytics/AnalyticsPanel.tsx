import { useCallback, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock,
  Flame,
  MessageSquare,
  Shield,
  Siren,
  TrendingDown,
  TrendingUp,
  Users,
  XCircle,
} from "lucide-react";
import type { Channel, Guild } from "../../types/voice";
import { useAnalytics } from "../../hooks/useAnalytics";
import type { AnalyticsOverview, HourlyBucket, TopicTrend, UserStat, ViolatorStat } from "../../api/analytics";
import { fetchViolators } from "../../api/analytics";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Select } from "../ui/select";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";

const TIME_RANGES = [
  { label: "1h", value: 1 },
  { label: "3h", value: 3 },
  { label: "6h", value: 6 },
  { label: "12h", value: 12 },
  { label: "24h", value: 24 },
  { label: "48h", value: 48 },
  { label: "7d", value: 168 },
];

interface AnalyticsPanelProps {
  guilds: Guild[];
  channels: Channel[];
  selectedGuild: string;
  selectedChannel: string;
  onGuildChange: (guildId: string) => void;
  onChannelChange: (channelId: string) => void;
}

// ── Color Palette ──────────────────────────────────────────────────────
const GLOW_COLORS = {
  clean: "from-emerald-500/20 via-emerald-500/5 to-transparent",
  warned: "from-amber-500/20 via-amber-500/5 to-transparent",
  flagged: "from-red-500/20 via-red-500/5 to-transparent",
  error: "from-orange-500/20 via-orange-500/5 to-transparent",
  neutral: "from-blue-500/15 via-blue-500/5 to-transparent",
};

export function AnalyticsPanel({
  guilds,
  channels,
  selectedGuild,
  selectedChannel,
  onGuildChange,
  onChannelChange,
}: AnalyticsPanelProps) {
  const [hours, setHours] = useState(24);
  const [violators, setViolators] = useState<ViolatorStat[]>([]);
  const [violatorsLoading, setViolatorsLoading] = useState(false);

  const { overview, loading, error, refresh } = useAnalytics({
    guildId: selectedGuild,
    channelId: selectedChannel || undefined,
    hours,
  });

  const loadViolators = useCallback(async () => {
    if (!selectedGuild) return;
    setViolatorsLoading(true);
    try {
      const data = await fetchViolators({
        guildId: selectedGuild,
        channelId: selectedChannel || undefined,
        hours,
        limit: 20,
      });
      setViolators(data);
    } catch {
      // silent
    } finally {
      setViolatorsLoading(false);
    }
  }, [selectedGuild, selectedChannel, hours]);

  useEffect(() => {
    loadViolators();
  }, [loadViolators]);

  return (
    <div className="grid gap-6">
      {/* ── Control Bar ─────────────────────────────────────────────── */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <Card className="overflow-hidden border-0 bg-gradient-to-r from-card via-card to-blue-950/20 shadow-lg shadow-blue-500/5">
          <div className="absolute inset-0 bg-gradient-to-r from-blue-500/5 via-transparent to-transparent pointer-events-none" />
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <BarChart3 className="h-6 w-6 text-blue-400" />
              Analytics & Insights
            </CardTitle>
            <CardDescription>
              Pantau statistik moderasi, topik trending, dan aktivitas user dalam satu dasbor.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-4">
              <Select
                value={selectedGuild}
                onChange={(e) => onGuildChange(e.target.value)}
                placeholder="Select guild"
                options={guilds.map((g) => ({ value: g.id, label: g.name }))}
              />
              <Select
                value={selectedChannel}
                onChange={(e) => onChannelChange(e.target.value)}
                placeholder="All channels"
                options={[
                  { value: "", label: "All channels" },
                  ...channels.map((c) => ({ value: c.id, label: c.name })),
                ]}
              />
              <div className="flex gap-1 rounded-xl bg-muted/50 p-1 backdrop-blur">
                {TIME_RANGES.map((tr) => (
                  <button
                    key={tr.value}
                    type="button"
                    onClick={() => setHours(tr.value)}
                    className={cn(
                      "relative flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition-all",
                      hours === tr.value
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {hours === tr.value && (
                      <motion.div
                        layoutId="timeRangeActive"
                        className="absolute inset-0 rounded-lg bg-background shadow-sm"
                        transition={{ type: "spring", bounce: 0.2, duration: 0.4 }}
                      />
                    )}
                    <span className="relative z-10">{tr.label}</span>
                  </button>
                ))}
              </div>
              <Button
                onClick={() => { refresh(); loadViolators(); }}
                disabled={loading}
                className="bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white shadow-lg shadow-blue-500/25 transition-all hover:shadow-blue-500/40"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <motion.span
                      animate={{ rotate: 360 }}
                      transition={{ repeat: Number.POSITIVE_INFINITY, duration: 1, ease: "linear" }}
                      className="inline-block h-3.5 w-3.5 rounded-full border-2 border-white/30 border-t-white"
                    />
                    Loading...
                  </span>
                ) : (
                  <span className="flex items-center gap-2">
                    <Activity className="h-4 w-4" />
                    Refresh
                  </span>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {error && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <Card className="border-red-500/30 bg-red-500/5">
            <CardContent className="flex items-center gap-3 py-4">
              <XCircle className="h-5 w-5 shrink-0 text-red-400" />
              <p className="text-sm text-red-300">{error}</p>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {!selectedGuild ? (
        <EmptyState icon={BarChart3} text="Pilih guild untuk melihat analitik." />
      ) : (
        <AnimatePresence mode="wait">
          <motion.div
            key={`${selectedGuild}-${hours}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="grid gap-6"
          >
            {/* ── KPI Stat Cards ─────────────────────────────────────── */}
            <StatsGrid overview={overview} loading={loading} totalChannels={overview?.total_channels ?? 0} />

            {/* ── Hourly Activity Chart ──────────────────────────────── */}
            <AnimatedCard glow="neutral">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Activity className="h-5 w-5 text-blue-400" />
                  Aktivitas Pesan Per Jam
                </CardTitle>
                <CardDescription>
                  Distribusi pesan per jam dengan breakdown status moderasi.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <HourlyChart hourly={overview?.hourly} loading={loading} />
              </CardContent>
            </AnimatedCard>

            {/* ── Topics + Leaderboard row ───────────────────────────── */}
            <div className="grid gap-6 lg:grid-cols-2">
              <AnimatedCard glow="neutral">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Flame className="h-5 w-5 text-orange-400" />
                    Topik Trending
                  </CardTitle>
                  <CardDescription>
                    Yang paling ramai dibicarakan orang.
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <TopicCloud topics={overview?.topics} loading={loading} />
                </CardContent>
              </AnimatedCard>

              <AnimatedCard glow="neutral">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Users className="h-5 w-5 text-violet-400" />
                    User Paling Aktif
                  </CardTitle>
                  <CardDescription>
                    Leaderboard berdasarkan jumlah pesan.
                  </CardDescription>
                </CardHeader>
                <CardContent className="p-0">
                  <UserLeaderboard users={overview?.top_users} loading={loading} compact />
                </CardContent>
              </AnimatedCard>
            </div>

            {/* ── VIOLATORS LEADERBOARD ──────────────────────────────── */}
            <AnimatedCard glow="flagged">
              <CardHeader>
                <div className="flex items-center justify-between">
                  <div>
                    <CardTitle className="flex items-center gap-2">
                      <Siren className="h-5 w-5 text-red-400" />
                      Pelanggar Terbanyak
                    </CardTitle>
                    <CardDescription>
                      User dengan skor pelanggaran tertinggi (flagged × 3 + warned × 1).
                    </CardDescription>
                  </div>
                  <Badge variant="destructive" className="animate-pulse">
                    {violators.length} pelanggar
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <ViolatorsLeaderboard users={violators} loading={violatorsLoading} />
              </CardContent>
            </AnimatedCard>

            {/* ── Full User Leaderboard ──────────────────────────────── */}
            <AnimatedCard glow="neutral">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Users className="h-5 w-5 text-cyan-400" />
                  Leaderboard Lengkap
                </CardTitle>
                <CardDescription>
                  Detail aktivitas user: pesan, edit, hapus, flag, dan waktu aktif terakhir.
                </CardDescription>
              </CardHeader>
              <CardContent className="p-0">
                <UserLeaderboard users={overview?.top_users} loading={loading} />
              </CardContent>
            </AnimatedCard>
          </motion.div>
        </AnimatePresence>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════
// SUB-COMPONENTS
// ══════════════════════════════════════════════════════════════════════════

// ── Animated Card Wrapper ──────────────────────────────────────────────
function AnimatedCard({
  children,
  glow,
  className,
}: {
  children: React.ReactNode;
  glow?: keyof typeof GLOW_COLORS;
  className?: string;
}) {
  const glowClass = GLOW_COLORS[glow ?? "neutral"];
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-50px" }}
      transition={{ duration: 0.4, ease: "easeOut" }}
      className={cn("group relative", className)}
    >
      {/* Animated border glow on hover */}
      <div className="absolute -inset-px rounded-2xl bg-gradient-to-r from-blue-500/0 via-blue-500/0 to-blue-500/0 opacity-0 transition-all duration-500 group-hover:from-blue-500/20 group-hover:via-violet-500/10 group-hover:to-blue-500/20 group-hover:opacity-100 blur-md pointer-events-none" />
      <Card className="relative overflow-hidden border-muted/60 bg-card/80 backdrop-blur shadow-lg transition-shadow group-hover:shadow-xl group-hover:shadow-blue-500/5">
        <div className={cn("absolute inset-0 bg-gradient-to-b pointer-events-none", glowClass)} />
        {children}
      </Card>
    </motion.div>
  );
}

// ── Stats Grid ─────────────────────────────────────────────────────────
function StatsGrid({
  overview,
  loading,
  totalChannels,
}: {
  overview: AnalyticsOverview | null;
  loading: boolean;
  totalChannels: number;
}) {
  const cards = [
    {
      label: "Total Pesan",
      value: overview?.messages.total ?? null,
      icon: MessageSquare,
      color: "text-blue-400",
      bg: "bg-blue-500/10",
      border: "border-blue-500/20",
      sub: totalChannels > 0 ? `${totalChannels} channel` : "",
      trend: null,
    },
    {
      label: "Clean",
      value: overview?.messages.clean ?? null,
      icon: CheckCircle2,
      color: "text-emerald-400",
      bg: "bg-emerald-500/10",
      border: "border-emerald-500/20",
      sub: overview ? `${pct(overview.messages.clean, overview.messages.total)}%` : "",
      trend: "up",
    },
    {
      label: "Warned",
      value: overview?.messages.warned ?? null,
      icon: AlertTriangle,
      color: "text-amber-400",
      bg: "bg-amber-500/10",
      border: "border-amber-500/20",
      sub: overview ? `${pct(overview.messages.warned, overview.messages.total)}%` : "",
      trend: overview && overview.messages.warned > 0 ? "down" : null,
    },
    {
      label: "Flagged",
      value: overview?.messages.flagged ?? null,
      icon: Siren,
      color: "text-red-400",
      bg: "bg-red-500/10",
      border: "border-red-500/20",
      sub: overview ? `${pct(overview.messages.flagged, overview.messages.total)}%` : "",
      trend: overview && overview.messages.flagged > 0 ? "down" : null,
    },
    {
      label: "Error",
      value: overview?.messages.error ?? null,
      icon: XCircle,
      color: "text-orange-400",
      bg: "bg-orange-500/10",
      border: "border-orange-500/20",
      sub: null,
      trend: null,
    },
    {
      label: "Pending",
      value: overview?.messages.pending ?? null,
      icon: Clock,
      color: "text-slate-400",
      bg: "bg-slate-500/10",
      border: "border-slate-500/20",
      sub: null,
      trend: null,
    },
    {
      label: "Rata-rata Skor",
      value: overview?.messages.average_score ?? null,
      icon: Shield,
      color: "text-cyan-400",
      bg: "bg-cyan-500/10",
      border: "border-cyan-500/20",
      sub: null,
      trend: null,
    },
    {
      label: "User Aktif",
      value: overview?.active_users_count ?? null,
      icon: Users,
      color: "text-violet-400",
      bg: "bg-violet-500/10",
      border: "border-violet-500/20",
      sub: null,
      trend: null,
    },
  ];

  return (
    <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
      {cards.map((card, i) => {
        const Icon = card.icon;
        return (
          <motion.div
            key={card.label}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: i * 0.05, duration: 0.3 }}
          >
            <Card className={cn("group relative overflow-hidden border transition-all hover:shadow-lg", card.border, card.bg)}>
              {/* Background pulse */}
              <div className={cn("absolute -right-4 -top-4 h-20 w-20 rounded-full opacity-20 blur-xl transition-opacity group-hover:opacity-30", card.color.replace("text-", "bg-"))} />
              <CardContent className="relative py-4">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                    {card.label}
                  </p>
                  <Icon className={cn("h-4 w-4 opacity-50", card.color)} />
                </div>
                <div className="mt-2 flex items-end gap-2">
                  <span className={cn("text-3xl font-bold tabular-nums tracking-tight", card.color)}>
                    {loading ? (
                      <motion.span
                        animate={{ opacity: [0.4, 1, 0.4] }}
                        transition={{ repeat: Number.POSITIVE_INFINITY, duration: 1.5 }}
                      >
                        …
                      </motion.span>
                    ) : (
                      card.value ?? "—"
                    )}
                  </span>
                  {card.trend && (
                    <span className="pb-1">
                      {card.trend === "up" ? (
                        <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
                      ) : (
                        <TrendingDown className="h-3.5 w-3.5 text-red-400" />
                      )}
                    </span>
                  )}
                </div>
                {card.sub && (
                  <p className="mt-1 text-xs text-muted-foreground">{card.sub}</p>
                )}
              </CardContent>
            </Card>
          </motion.div>
        );
      })}
    </div>
  );
}

// ── Hourly Chart ───────────────────────────────────────────────────────
function HourlyChart({ hourly, loading }: { hourly: HourlyBucket[] | undefined; loading: boolean }) {
  const containerRef = useRef<HTMLDivElement>(null);

  if (loading && !hourly?.length) {
    return <LoadingSkeleton />;
  }

  if (!hourly?.length) {
    return (
      <div className="flex h-56 flex-col items-center justify-center gap-2 text-muted-foreground">
        <BarChart3 className="h-10 w-10 opacity-20" />
        <p className="text-sm">Belum ada data untuk periode ini.</p>
      </div>
    );
  }

  const maxCount = Math.max(...hourly.map((b) => b.count), 1);
  const labels = hourly.map((b) => b.hour.slice(11, 16));

  return (
    <div ref={containerRef} className="space-y-3">
      <div className="relative flex h-52 items-end gap-[2px]">
        {/* Grid lines */}
        {[0.25, 0.5, 0.75, 1].map((pct) => (
          <div
            key={pct}
            className="absolute left-0 right-0 border-t border-white/[0.04]"
            style={{ bottom: `${pct * 100}%` }}
          />
        ))}
        {hourly.map((bucket, i) => {
          const heightPct = (bucket.count / maxCount) * 100;
          const total = bucket.clean + bucket.warned + bucket.flagged + bucket.error || 1;
          const cleanH = (bucket.clean / total) * heightPct;
          const warnedH = (bucket.warned / total) * heightPct;
          const flaggedH = (bucket.flagged / total) * heightPct;
          const errorH = (bucket.error / total) * heightPct;

          return (
            <motion.div
              key={bucket.hour}
              initial={{ height: 0 }}
              animate={{ height: `${heightPct}%` }}
              transition={{ delay: i * 0.02, duration: 0.5, ease: "easeOut" }}
              className="group relative flex flex-1 flex-col justify-end"
            >
              {/* Stacked segments */}
              <div className="relative w-full" style={{ height: `${heightPct}%` }}>
                <div
                  className="absolute bottom-0 w-full rounded-t-sm bg-emerald-500/80 transition-colors hover:bg-emerald-400"
                  style={{ height: `${cleanH}%` }}
                  title={`Clean: ${bucket.clean}`}
                />
                <div
                  className="absolute w-full bg-amber-500/80 transition-colors hover:bg-amber-400"
                  style={{ bottom: `${cleanH}%`, height: `${warnedH}%` }}
                  title={`Warned: ${bucket.warned}`}
                />
                <div
                  className="absolute w-full bg-red-500/80 transition-colors hover:bg-red-400"
                  style={{ bottom: `${cleanH + warnedH}%`, height: `${flaggedH}%` }}
                  title={`Flagged: ${bucket.flagged}`}
                />
                <div
                  className="absolute top-0 w-full rounded-t-sm bg-orange-500/60 transition-colors hover:bg-orange-400"
                  style={{ height: `${errorH}%` }}
                  title={`Error: ${bucket.error}`}
                />
              </div>
              {/* Hover tooltip */}
              <div className="absolute -top-10 left-1/2 z-20 -translate-x-1/2 whitespace-nowrap rounded-lg bg-popover px-2.5 py-1.5 text-xs font-medium text-popover-foreground opacity-0 shadow-lg transition-opacity group-hover:opacity-100 pointer-events-none">
                {bucket.hour.slice(11, 16)} — {bucket.count} msgs
              </div>
            </motion.div>
          );
        })}
      </div>
      {/* X-axis labels */}
      <div className="flex justify-between px-1">
        {labels.filter((_, i) => i % Math.max(1, Math.floor(labels.length / 6)) === 0 || i === labels.length - 1).map((label, i) => (
          <span key={i} className="text-[10px] text-muted-foreground tabular-nums">{label}</span>
        ))}
      </div>
      {/* Legend */}
      <div className="flex flex-wrap items-center gap-5 text-xs text-muted-foreground">
        <Legend color="bg-emerald-500/80" label="Clean" />
        <Legend color="bg-amber-500/80" label="Warned" />
        <Legend color="bg-red-500/80" label="Flagged" />
        <Legend color="bg-orange-500/60" label="Error" />
      </div>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn("inline-block h-2.5 w-2.5 rounded-sm", color)} />
      {label}
    </span>
  );
}

// ── Topic Cloud ────────────────────────────────────────────────────────
const TOPIC_GRADIENTS = [
  "from-blue-500/30 via-blue-500/15 to-blue-600/20",
  "from-emerald-500/30 via-emerald-500/15 to-emerald-600/20",
  "from-violet-500/30 via-violet-500/15 to-violet-600/20",
  "from-amber-500/30 via-amber-500/15 to-amber-600/20",
  "from-cyan-500/30 via-cyan-500/15 to-cyan-600/20",
  "from-pink-500/30 via-pink-500/15 to-pink-600/20",
  "from-teal-500/30 via-teal-500/15 to-teal-600/20",
  "from-orange-500/30 via-orange-500/15 to-orange-600/20",
];

const TOPIC_TEXT = [
  "text-blue-300",
  "text-emerald-300",
  "text-violet-300",
  "text-amber-300",
  "text-cyan-300",
  "text-pink-300",
  "text-teal-300",
  "text-orange-300",
];

const TOPIC_BORDER = [
  "border-blue-500/30",
  "border-emerald-500/30",
  "border-violet-500/30",
  "border-amber-500/30",
  "border-cyan-500/30",
  "border-pink-500/30",
  "border-teal-500/30",
  "border-orange-500/30",
];

function TopicCloud({ topics, loading }: { topics: TopicTrend[] | undefined; loading: boolean }) {
  if (loading && !topics?.length) {
    return <LoadingSkeleton />;
  }

  if (!topics?.length) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
        <Flame className="h-10 w-10 opacity-20" />
        <p className="text-sm">Topik akan muncul setelah AI selesai menganalisis.</p>
      </div>
    );
  }

  const maxCount = Math.max(...topics.map((t) => t.count), 1);

  return (
    <div className="flex flex-wrap gap-2.5">
      {topics.map((topic, i) => {
        const scale = 0.65 + (topic.count / maxCount) * 1.35;
        return (
          <motion.span
            key={topic.topic}
            initial={{ opacity: 0, scale: 0.5 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: i * 0.04, type: "spring", bounce: 0.3 }}
            whileHover={{ scale: 1.08, y: -2 }}
            className={cn(
              "relative inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 cursor-default",
              "bg-gradient-to-br backdrop-blur transition-shadow hover:shadow-lg",
              TOPIC_GRADIENTS[i % TOPIC_GRADIENTS.length],
              TOPIC_BORDER[i % TOPIC_BORDER.length],
              TOPIC_TEXT[i % TOPIC_TEXT.length],
            )}
            style={{ fontSize: `${Math.round(scale * 100)}%` }}
            title={`${topic.count} kali disebut${topic.score > 0 ? ` · Skor: ${topic.score}` : ""}`}
          >
            {/* Sparkle dot */}
            <span className="absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full bg-white/30" />
            {topic.topic}
            <span className="text-[0.65em] font-mono opacity-50 tabular-nums">
              {topic.count}
            </span>
          </motion.span>
        );
      })}
    </div>
  );
}

// ── User Leaderboard ───────────────────────────────────────────────────
function UserLeaderboard({
  users,
  loading,
  compact,
}: {
  users: UserStat[] | undefined;
  loading: boolean;
  compact?: boolean;
}) {
  if (loading && !users?.length) {
    return <LoadingSkeleton />;
  }

  if (!users?.length) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
        <Users className="h-10 w-10 opacity-20" />
        <p className="text-sm">Belum ada aktivitas user.</p>
      </div>
    );
  }

  const maxMsgs = Math.max(...users.map((u) => u.message_count), 1);
  const medals = ["🥇", "🥈", "🥉"];

  const displayUsers = compact ? users.slice(0, 5) : users;

  return (
    <ScrollArea className={compact ? "max-h-[300px]" : "max-h-[500px]"}>
      <table className="w-full text-sm">
        <thead>
          <tr className="sticky top-0 z-10 bg-card/95 backdrop-blur border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="py-3 pl-6 pr-3 font-semibold">#</th>
            <th className="py-3 pr-3 font-semibold">User</th>
            {!compact && (
              <>
                <th className="py-3 pr-3 font-semibold text-right">Pesan</th>
                <th className="py-3 pr-3 font-semibold text-right">Edit</th>
                <th className="py-3 pr-3 font-semibold text-right">Hapus</th>
                <th className="py-3 pr-3 font-semibold text-right">Flag</th>
                <th className="py-3 pr-6 font-semibold text-right">Aktif</th>
              </>
            )}
            {compact && (
              <th className="py-3 pr-6 font-semibold text-right">Pesan</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/30">
          {displayUsers.map((user, i) => (
            <motion.tr
              key={user.user_id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.03 }}
              className="group transition-colors hover:bg-muted/20"
            >
              <td className="py-2.5 pl-6 pr-3 tabular-nums font-mono text-muted-foreground">
                {medals[i] ?? i + 1}
              </td>
              <td className="py-2.5 pr-3">
                <div className="flex items-center gap-2.5">
                  {user.avatar_url ? (
                    <img
                      src={user.avatar_url}
                      alt=""
                      className="h-7 w-7 rounded-full ring-1 ring-border/50"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-xs font-bold ring-1 ring-border/50">
                      {user.username.charAt(0).toUpperCase()}
                    </div>
                  )}
                  <span className="max-w-[100px] truncate font-medium">
                    {user.username}
                  </span>
                </div>
              </td>
              {!compact && (
                <>
                  <td className="py-2.5 pr-3 text-right tabular-nums">
                    <div className="flex items-center justify-end gap-2">
                      <div className="hidden h-1.5 w-10 overflow-hidden rounded-full bg-muted sm:block">
                        <motion.div
                          className="h-full rounded-full bg-gradient-to-r from-blue-500 to-blue-400"
                          initial={{ width: 0 }}
                          animate={{ width: `${(user.message_count / maxMsgs) * 100}%` }}
                          transition={{ delay: i * 0.05 + 0.2, duration: 0.6 }}
                        />
                      </div>
                      <span className="font-mono text-xs font-semibold">{user.message_count}</span>
                    </div>
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground text-xs">
                    {user.edited_count > 0 ? user.edited_count : "—"}
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground text-xs">
                    {user.deleted_count > 0 ? user.deleted_count : "—"}
                  </td>
                  <td className="py-2.5 pr-3 text-right tabular-nums text-xs">
                    {user.flagged_count > 0 ? (
                      <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                        {user.flagged_count}
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-2.5 pr-6 text-right tabular-nums text-muted-foreground text-xs">
                    {formatTimeAgo(user.last_active)}
                  </td>
                </>
              )}
              {compact && (
                <td className="py-2.5 pr-6 text-right">
                  <span className="font-mono text-sm font-bold tabular-nums">{user.message_count}</span>
                  <span className="ml-1 text-[10px] text-muted-foreground">msg</span>
                </td>
              )}
            </motion.tr>
          ))}
        </tbody>
      </table>
      {compact && users.length > 5 && (
        <div className="border-t border-border px-6 py-3 text-center text-xs text-muted-foreground">
          +{users.length - 5} user lainnya — lihat leaderboard lengkap di bawah
        </div>
      )}
    </ScrollArea>
  );
}

// ── Violators Leaderboard ──────────────────────────────────────────────
function ViolatorsLeaderboard({
  users,
  loading,
}: {
  users: ViolatorStat[] | undefined;
  loading: boolean;
}) {
  if (loading && !users?.length) {
    return <LoadingSkeleton />;
  }

  if (!users?.length) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
        <Shield className="h-10 w-10 opacity-20" />
        <p className="text-sm">Tidak ada pelanggaran terdeteksi. 🎉</p>
      </div>
    );
  }

  const maxScore = Math.max(...users.map((u) => u.violation_score), 1);

  // Danger level colors
  interface DangerLevel { bg: string; border: string; text: string; label: string }
  function dangerLevel(score: number): DangerLevel {
    if (score >= 10) return { bg: "bg-red-500/15 border-red-500/40", border: "border-red-500/40", text: "text-red-300", label: "HIGH" };
    if (score >= 5) return { bg: "bg-amber-500/10 border-amber-500/30", border: "border-amber-500/30", text: "text-amber-300", label: "MED" };
    return { bg: "bg-yellow-500/10 border-yellow-500/20", border: "border-yellow-500/20", text: "text-yellow-300", label: "LOW" };
  }

  return (
    <ScrollArea className="max-h-[500px]">
      <div className="divide-y divide-border/20">
        {users.map((user, i) => {
          const danger = dangerLevel(user.violation_score);
          return (
            <motion.div
              key={user.user_id}
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.04 }}
              className={cn(
                "group flex items-center gap-4 px-6 py-3 transition-colors hover:bg-red-500/5",
              )}
            >
              {/* Rank + Danger indicator */}
              <div className="relative flex-shrink-0">
                <div className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-xl border text-lg font-bold",
                  danger.bg, danger.border, danger.text,
                  i < 3 && "shadow-lg",
                )}>
                  {i + 1}
                </div>
                {i === 0 && (
                  <span className="absolute -right-1 -top-1 text-sm">🔥</span>
                )}
              </div>

              {/* Avatar */}
              {user.avatar_url ? (
                <img src={user.avatar_url} alt="" className="h-9 w-9 rounded-full ring-1 ring-border/50" loading="lazy" />
              ) : (
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-xs font-bold">
                  {user.username.charAt(0).toUpperCase()}
                </div>
              )}

              {/* Info */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate font-semibold text-sm">{user.username}</span>
                  <Badge
                    variant="outline"
                    className={cn(
                      "text-[9px] px-1.5 py-0 font-mono tracking-wider",
                      danger.text, danger.border,
                    )}
                  >
                    {danger.label}
                  </Badge>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                  {user.worst_flags.length > 0 ? (
                    user.worst_flags.map((flag) => (
                      <span
                        key={flag}
                        className="inline-flex items-center rounded-md bg-red-500/10 px-1.5 py-0.5 text-red-300/80"
                      >
                        {flag}
                      </span>
                    ))
                  ) : (
                    <span className="italic">no flags</span>
                  )}
                </div>
              </div>

              {/* Stats */}
              <div className="flex items-center gap-4 text-right tabular-nums flex-shrink-0">
                <div>
                  <div className="text-xs text-muted-foreground">Pesan</div>
                  <div className="font-mono text-sm font-medium">{user.total_messages}</div>
                </div>
                <div>
                  <div className="text-xs text-amber-400/70">Warned</div>
                  <div className="font-mono text-sm font-medium text-amber-400">{user.warned_count}</div>
                </div>
                <div>
                  <div className="text-xs text-red-400/70">Flagged</div>
                  <div className="font-mono text-sm font-bold text-red-400">{user.flagged_count}</div>
                </div>
                <div className="w-24">
                  <div className="text-xs text-muted-foreground mb-1">Skor</div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <motion.div
                      className={cn(
                        "h-full rounded-full",
                        user.violation_score >= 10
                          ? "bg-gradient-to-r from-red-600 to-red-400"
                          : user.violation_score >= 5
                            ? "bg-gradient-to-r from-amber-500 to-amber-400"
                            : "bg-gradient-to-r from-yellow-500 to-yellow-400",
                      )}
                      initial={{ width: 0 }}
                      animate={{ width: `${(user.violation_score / maxScore) * 100}%` }}
                      transition={{ delay: i * 0.05 + 0.2, duration: 0.6 }}
                    />
                  </div>
                  <div className={cn("mt-0.5 text-xs font-bold font-mono", danger.text)}>
                    {user.violation_score}
                  </div>
                </div>
              </div>
            </motion.div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

// ── Empty State ────────────────────────────────────────────────────────
function EmptyState({ icon: Icon, text }: { icon: typeof BarChart3; text: string }) {
  return (
    <Card className="border-dashed">
      <CardContent className="flex min-h-[300px] flex-col items-center justify-center gap-3">
        <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted/50">
          <Icon className="h-8 w-8 text-muted-foreground/40" />
        </div>
        <p className="text-sm text-muted-foreground">{text}</p>
      </CardContent>
    </Card>
  );
}

// ── Loading Skeleton ───────────────────────────────────────────────────
function LoadingSkeleton() {
  return (
    <div className="flex h-40 flex-col items-center justify-center gap-3">
      <motion.div
        className="h-10 w-10 rounded-full border-2 border-blue-500/20 border-t-blue-400"
        animate={{ rotate: 360 }}
        transition={{ repeat: Number.POSITIVE_INFINITY, duration: 1, ease: "linear" }}
      />
      <motion.p
        className="text-xs text-muted-foreground"
        animate={{ opacity: [0.4, 1, 0.4] }}
        transition={{ repeat: Number.POSITIVE_INFINITY, duration: 2 }}
      >
        Memuat data...
      </motion.p>
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────
function pct(part: number, total: number): number {
  if (!total) return 0;
  return Math.round((part / total) * 100);
}

function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "baru saja";
  if (minutes < 60) return `${minutes}m lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}j lalu`;
  const days = Math.floor(hours / 24);
  return `${days}h lalu`;
}
