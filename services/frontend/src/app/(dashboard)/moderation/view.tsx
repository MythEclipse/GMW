"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { HourHeatmap, RankedBars } from "@/components/charts/bars";
import { StatGrid, StatTile } from "@/components/StatTile";
import { Section, SectionGrid } from "@/components/shared/section";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { Badge } from "@/components/shared/tone";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  useCoverage,
  useFlaggedChannels,
  useFlaggedDomains,
  useHourlyModeration,
  useModerationActions,
  useModerationStats,
  useModerationTrends,
} from "@/hooks/use-data";
import { filterFromUrl, severityTone } from "@/lib/ai-status";
import {
  formatCompact,
  formatDateTime,
  formatNumber,
  formatPercent,
  humanize,
  messageBody,
  truncate,
} from "@/lib/format";
import type {
  Coverage,
  FlaggedChannel,
  FlaggedDomain,
  HourBucket,
  ModerationActionPage,
  ModerationStats,
  ModerationTrends,
  Severity,
} from "@/lib/types";
import { useWsEvent } from "@/lib/ws/context";

/**
 * A Select cannot hold an empty-string value (base-ui treats "" as "no
 * selection" and renders the placeholder), so "unfiltered" gets a sentinel
 * that is mapped back to "" in state.
 */
/**
 * Sentinel for "unfiltered" in the shadcn Select. A Select cannot hold "",
 * so the unfiltered state needs an explicit token; it is mapped back to
 * undefined before it reaches the backend and is never shown to the user,
 * because each Select passes an `items` label map so the trigger renders text
 * rather than the raw value.
 */
const ANY = "__any__";

const ACTION_STATUSES = ["executed", "pending", "failed"] as const;
const ACTION_TYPES = [
  "delete_message",
  "warn_user",
  "mute_user",
  "kick_user",
  "ban_user",
  "reset_nickname",
] as const;

/**
 * Label maps for the enforcement-log filters.
 *
 * Without `items`, `<Select.Value>` prints the raw item value, so the trigger
 * showed "__any__" instead of a human label.
 */
const STATUS_ITEMS: Record<string, string> = {
  [ANY]: "Any status",
  ...Object.fromEntries(ACTION_STATUSES.map((s) => [s, humanize(s)])),
};

const ACTION_ITEMS: Record<string, string> = {
  [ANY]: "Any action",
  ...Object.fromEntries(ACTION_TYPES.map((t) => [t, humanize(t)])),
};

export function ModerationView({
  initialStats,
  initialActions,
  initialTrends,
  initialDomains,
  initialFlaggedChannels,
  initialHourly,
  initialCoverage,
  days,
}: {
  initialStats: ModerationStats;
  initialActions: ModerationActionPage;
  initialTrends: ModerationTrends;
  initialDomains: FlaggedDomain[];
  initialFlaggedChannels: FlaggedChannel[];
  initialHourly: HourBucket[];
  initialCoverage: Coverage;
  days: number;
}) {
  // Seed the enforcement-log filters from the URL (W2) so the "Model errors"
  // stat tile can deep-link into `?status=failed` and land on the failed
  // actions rather than on the unfiltered table.
  //
  // Select state stays `""` for unfiltered (the shadcn Select cannot hold an
  // empty string, so the component maps ""<->ANY at its own boundary). The URL
  // layer therefore speaks the same dialect: validate against the allow-list,
  // and treat ANY/absent/invalid as unfiltered.
  const [params, setParams] = useSearchParams();
  const urlStatus = filterFromUrl(params.get("status"), ACTION_STATUSES, ANY);
  const urlAction = filterFromUrl(params.get("actionType"), ACTION_TYPES, ANY);

  const [status, setStatus] = useState(
    urlStatus === ANY ? "" : (urlStatus as string),
  );
  const [actionType, setActionType] = useState(
    urlAction === ANY ? "" : (urlAction as string),
  );

  // Adopt a URL change made from outside this view (a back/forward navigation,
  // or a stat tile landing on `?status=failed`). Never fight the user's own
  // Select: only overwrite when the URL actually specifies a filter.
  useEffect(() => {
    setStatus((current) =>
      urlStatus === ANY ? (current === "" ? current : "") : urlStatus,
    );
    setActionType((current) =>
      urlAction === ANY ? (current === "" ? current : "") : urlAction,
    );
  }, [urlStatus, urlAction]);

  // Publish state to the URL so a reload or a shared link reproduces the view.
  // Guarded on an actual difference so a Select change does not loop.
  useEffect(() => {
    const next = new URLSearchParams();
    if (status) next.set("status", status);
    if (actionType) next.set("actionType", actionType);
    const current = new URLSearchParams();
    if (urlStatus !== ANY) current.set("status", urlStatus);
    if (urlAction !== ANY) current.set("actionType", urlAction);
    if (next.toString() === current.toString()) return;
    setParams(next, { replace: true });
  }, [status, actionType, urlStatus, urlAction, setParams]);

  const stats = useModerationStats(initialStats);
  const actions = useModerationActions(status, actionType, initialActions);
  const trends = useModerationTrends(days, initialTrends);
  const domains = useFlaggedDomains(days, initialDomains);
  const flaggedChannels = useFlaggedChannels(days, initialFlaggedChannels);
  const hourly = useHourlyModeration(days, initialHourly);
  const coverage = useCoverage(days, initialCoverage);

  // An enforcement action is the terminal event for a message: refresh the
  // counters, the trends, and the action log together so the page never shows
  // a delete that the tiles have not counted yet.
  useWsEvent("moderation_action", () => {
    void stats.mutate();
    void actions.mutate();
    void trends.mutate();
  });
  useWsEvent("message_analyzed", () => {
    void coverage.mutate();
  });

  const categoryBars = useMemo(
    () =>
      (trends.data?.categories ?? []).map((c) => ({
        label: humanize(c.name),
        value: c.count,
      })),
    [trends.data?.categories],
  );

  const severityBars = useMemo(() => {
    // Severity is an ORDINAL scale, so these are sorted by intensity — not by
    // count, and not alphabetically. Postgres returns `GROUP BY severity` in
    // arbitrary order, which rendered as "Medium, None, Critical, High, Low":
    // a reader comparing two severities had to hunt for the right row.
    //
    // `none` sorts FIRST because it is the absence of a finding, not a level on
    // the scale; putting it last would imply it were the most severe thing here.
    const rank: Record<string, number> = {
      none: 0,
      low: 1,
      medium: 2,
      high: 3,
      critical: 4,
    };

    return (trends.data?.severities ?? [])
      .map((s) => ({
        label: humanize(s.level),
        value: s.count,
        rank: rank[String(s.level).toLowerCase()] ?? 99,
      }))
      .sort((a, b) => a.rank - b.rank)
      .map(({ rank: _rank, ...bar }) => bar);
  }, [trends.data?.severities]);

  // The two "model errors" figures measure DIFFERENT things, and the tile used
  // to present them as one fraction.
  //
  //   stats.data.failed      — all-time count of errored verdicts (no window)
  //   coverage.failed_rate   — failed / total WITHIN `analysis_attempts`, over
  //                           the last `days` days only
  //
  // So "1" next to "3.5% of attempts" read as 1/29 when the real denominator
  // is 4,378. The hint now states the window explicitly, and falls back to the
  // windowed count when the all-time figure is zero but the window caught some.
  const errorHint = useMemo(() => {
    if (stats.data?.failed) return "All time";
    if (coverage.data?.failed) {
      return `${formatNumber(coverage.data.failed)} in ${days}d`;
    }
    return "None recorded";
  }, [stats.data?.failed, coverage.data?.failed, coverage.data, days]);

  if (stats.error && !stats.data) {
    return (
      <ErrorState error={stats.error} onRetry={() => void stats.mutate()} />
    );
  }

  return (
    <div className="space-y-4">
      <header>
        <h1 className="font-display text-xl font-semibold tracking-tight text-ink">
          Moderation
        </h1>
        <p className="text-xs text-ink-muted">
          Verdicts, enforcement, and how much of the queue the model actually
          covers
        </p>
      </header>

      <StatGrid cols={4}>
        <StatTile
          label="Judged"
          value={formatCompact(stats.data?.executed)}
          exact={formatNumber(stats.data?.executed)}
          hint={`${formatNumber(stats.data?.total)} total analysed`}
          to="/messages?verdict=clean"
        />
        <StatTile
          label="Awaiting verdict"
          value={formatNumber(stats.data?.pending)}
          hint="Queued or claimed by a worker"
          tone={(stats.data?.pending ?? 0) > 200 ? "warning" : "neutral"}
          to="/messages?status=pending"
        />
        <StatTile
          label="Coverage"
          value={formatPercent(coverage.data?.coverage_rate)}
          hint={`${formatNumber(coverage.data?.completed)} of ${formatNumber(coverage.data?.total)} attempts`}
          tone={
            (coverage.data?.coverage_rate ?? 0) < 90 ? "warning" : "neutral"
          }
        />
        <StatTile
          label="Model errors"
          value={formatNumber(stats.data?.failed)}
          hint={errorHint}
          tone={(stats.data?.failed ?? 0) > 0 ? "warning" : "positive"}
          to="/moderation?status=failed"
        />
      </StatGrid>

      <SectionGrid cols={2}>
        <Section title="Flag categories" description={`Last ${days} days`}>
          {trends.error && !trends.data ? (
            <ErrorState
              error={trends.error}
              onRetry={() => void trends.mutate()}
            />
          ) : (
            <RankedBars data={categoryBars} showRank />
          )}
        </Section>

        <Section
          title="Severity distribution"
          description={`Last ${days} days`}
        >
          <RankedBars data={severityBars} />
        </Section>
      </SectionGrid>

      <Section
        title="When moderation happens"
        description="Actions by hour of day, last 30 days"
      >
        {hourly.error && !hourly.data ? (
          <ErrorState
            error={hourly.error}
            onRetry={() => void hourly.mutate()}
          />
        ) : (
          <HourHeatmap values={hourly.data ?? []} />
        )}
      </Section>

      <SectionGrid cols={2}>
        <Section
          title="Flagged domains"
          description="Links that appeared in flagged messages"
        >
          {domains.error && !domains.data ? (
            <ErrorState
              error={domains.error}
              onRetry={() => void domains.mutate()}
            />
          ) : (
            <RankedBars
              data={(domains.data ?? []).map((d) => ({
                label: d.domain,
                value: d.count,
              }))}
              showRank
            />
          )}
        </Section>

        <Section
          title="Most flagged channels"
          description={`Last ${days} days`}
        >
          <RankedBars
            data={(flaggedChannels.data ?? []).map((c) => ({
              label: c.channel_name || `#${c.channel_id}`,
              value: c.flagged_count,
            }))}
            showRank
          />
        </Section>
      </SectionGrid>

      <Section
        title="Enforcement log"
        description="Every action the backend took"
        action={
          <div className="flex items-center gap-2">
            <Select
              items={STATUS_ITEMS}
              value={status || ANY}
              onValueChange={(v) => setStatus(v === ANY ? "" : (v ?? ""))}
            >
              <SelectTrigger
                size="sm"
                className="min-h-11 sm:min-h-8 w-32"
                aria-label="Status"
              >
                <SelectValue placeholder="Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any status</SelectItem>
                {ACTION_STATUSES.filter(Boolean).map((s) => (
                  <SelectItem key={s} value={s}>
                    {humanize(s)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              items={ACTION_ITEMS}
              value={actionType || ANY}
              onValueChange={(v) => setActionType(v === ANY ? "" : (v ?? ""))}
            >
              <SelectTrigger
                size="sm"
                className="min-h-11 sm:min-h-8 w-40"
                aria-label="Action"
              >
                <SelectValue placeholder="Action" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY}>Any action</SelectItem>
                {ACTION_TYPES.filter(Boolean).map((t) => (
                  <SelectItem key={t} value={t}>
                    {humanize(t)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        }
        bodyClassName="p-0"
      >
        <ActionsTable
          page={actions.data}
          loading={actions.isValidating}
          error={actions.error}
          onRetry={() => void actions.mutate()}
        />
      </Section>
    </div>
  );
}

function ActionsTable({
  page,
  loading,
  error,
  onRetry,
}: {
  page: ModerationActionPage | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (error && !page) return <ErrorState error={error} onRetry={onRetry} />;

  const rows = page?.data ?? [];
  if (rows.length === 0) {
    return (
      <div className="p-4">
        <EmptyState title="No enforcement actions match" />
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      {/*
        The design gate forbids restyling Table primitives (their typography,
        colour and motion belong to the component), so every per-cell
        presentation choice is applied to a plain wrapper INSIDE the cell
        instead. The table keeps its own look; the content is ours to style.
      */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>User</TableHead>
            <TableHead>Message</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Severity</TableHead>
            <TableHead>By</TableHead>
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} data-loading={loading || undefined}>
              <TableCell>
                <span className="whitespace-nowrap font-mono text-xs text-ink-muted">
                  {formatDateTime(row.created_at)}
                </span>
              </TableCell>
              <TableCell>
                <span className="block whitespace-nowrap text-xs">
                  <span className="block truncate text-ink-soft">
                    {row.server_nick ?? row.username ?? "unknown"}
                  </span>
                  <span className="block font-mono text-micro text-ink-faint">
                    {row.user_id}
                  </span>
                </span>
              </TableCell>
              <TableCell>
                <span className="block max-w-72 text-xs text-ink-soft">
                  {/*
            `messageBody` before the truncate, so the 120 characters that
            survive are 120 characters of the author's text rather than 120
            characters of markdown source. Order matters: cleaning after
            truncating would cut a link in half and leave the dangling `(https:`
            behind.
          */}
                  {row.content ? truncate(messageBody(row.content), 120) : "—"}
                </span>
              </TableCell>
              <TableCell>
                <Badge>{humanize(row.action_type)}</Badge>
              </TableCell>
              <TableCell>
                <Badge tone={severityTone(row.severity as Severity | null)}>
                  {row.severity ?? "—"}
                </Badge>
              </TableCell>
              <TableCell>
                <span className="block whitespace-nowrap font-mono text-micro text-ink-faint">
                  {row.executed_by ?? "—"}
                </span>
              </TableCell>
              <TableCell>
                <Badge
                  tone={
                    row.status === "executed"
                      ? "positive"
                      : row.status === "failed"
                        ? "danger"
                        : "neutral"
                  }
                >
                  {row.status}
                </Badge>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
