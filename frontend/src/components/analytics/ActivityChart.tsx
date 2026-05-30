import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import type { HourlyBucket } from "../../api/analytics";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

interface ActivityChartProps {
  hourly: HourlyBucket[];
  loading: boolean;
}

export function ActivityChart({ hourly, loading }: ActivityChartProps) {
  if (loading && !hourly?.length) {
    return <LoadingBox />;
  }

  if (!hourly?.length) {
    return <EmptyBox text="Belum ada data untuk periode ini." />;
  }

  const data = hourly.map((b) => {
    const utcHour = parseInt(b.hour.slice(11, 13), 10);
    const jakartaHour = (utcHour + 7) % 24;
    return {
      hour: `${String(jakartaHour).padStart(2, "0")}:00`,
      clean: b.clean,
      warned: b.warned,
      flagged: b.flagged,
      error: b.error,
      total: b.count,
    };
  });

  return (
    <Card className="col-span-2">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Aktivitas per Jam</CardTitle>
        <CardDescription className="text-xs">Distribusi pesan per jam berdasarkan status moderasi.</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <AreaChart data={data} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
            <XAxis dataKey="hour" tick={{ fontSize: 10, fill: "#64748b" }} tickLine={false} axisLine={{ stroke: "#334155" }} />
            <YAxis tick={{ fontSize: 10, fill: "#64748b" }} tickLine={false} axisLine={false} width={28} />
            <Tooltip
              contentStyle={{
                backgroundColor: "#1e293b",
                border: "1px solid #334155",
                borderRadius: "6px",
                fontSize: "11px",
                color: "#e2e8f0",
              }}
              formatter={(value: unknown, name: unknown) => {
                const v = typeof value === "number" ? value : String(value);
                return [v, label(String(name))];
              }}
            />
            <Legend wrapperStyle={{ fontSize: "11px" }} />
            <Area type="monotone" dataKey="clean" stackId="1" stroke="#10b981" fill="#10b981" fillOpacity={0.6} name="clean" />
            <Area type="monotone" dataKey="warned" stackId="1" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.6} name="warned" />
            <Area type="monotone" dataKey="flagged" stackId="1" stroke="#ef4444" fill="#ef4444" fillOpacity={0.6} name="flagged" />
            <Area type="monotone" dataKey="error" stackId="1" stroke="#f97316" fill="#f97316" fillOpacity={0.4} name="error" />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function label(key: string): string {
  const map: Record<string, string> = { clean: "Clean", warned: "Warned", flagged: "Flagged", error: "Error" };
  return map[key] ?? key;
}

function LoadingBox() {
  return (
    <Card className="col-span-2">
      <CardContent className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        <span className="ml-2">Memuat data...</span>
      </CardContent>
    </Card>
  );
}

function EmptyBox({ text }: { text: string }) {
  return (
    <Card className="col-span-2">
      <CardContent className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
        {text}
      </CardContent>
    </Card>
  );
}
