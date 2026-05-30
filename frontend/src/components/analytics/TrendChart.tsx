import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";
import type { TrendBucket } from "../../api/analytics";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

interface TrendChartProps {
  trend: TrendBucket[];
  loading: boolean;
}

export function TrendChart({ trend, loading }: TrendChartProps) {
  if (loading && !trend?.length) {
    return <LoadingBox />;
  }

  if (!trend?.length) {
    return null;
  }

  const data = trend.map((b) => ({
    date: b.date,
    clean: b.clean,
    warned: b.warned,
    flagged: b.flagged,
    error: b.error,
    total: b.count,
  }));

  return (
    <Card className="col-span-3">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Tren Harian</CardTitle>
        <CardDescription className="text-xs">Volume pesan per hari dengan status moderasi.</CardDescription>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
            <XAxis dataKey="date" tick={{ fontSize: 10, fill: "#64748b" }} tickLine={false} axisLine={{ stroke: "#334155" }} tickFormatter={(d: string) => d.slice(5)} />
            <YAxis tick={{ fontSize: 10, fill: "#64748b" }} tickLine={false} axisLine={false} width={28} />
            <Tooltip
              contentStyle={{ backgroundColor: "#1e293b", border: "1px solid #334155", borderRadius: "6px", fontSize: "11px", color: "#e2e8f0" }}
              formatter={(value: unknown, name: unknown) => {
                const v = typeof value === "number" ? value : String(value);
                return [v, label(String(name))];
              }}
              labelFormatter={(l: unknown) => String(l)}
            />
            <Legend wrapperStyle={{ fontSize: "11px" }} />
            <Line type="monotone" dataKey="total" stroke="#3b82f6" strokeWidth={2} dot={false} name="Total" />
            <Line type="monotone" dataKey="clean" stroke="#10b981" strokeWidth={1.5} dot={false} name="Clean" />
            <Line type="monotone" dataKey="warned" stroke="#f59e0b" strokeWidth={1.5} dot={false} name="Warned" />
            <Line type="monotone" dataKey="flagged" stroke="#ef4444" strokeWidth={1.5} dot={false} name="Flagged" />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

function label(key: string): string {
  const map: Record<string, string> = { total: "Total", clean: "Clean", warned: "Warned", flagged: "Flagged" };
  return map[key] ?? key;
}

function LoadingBox() {
  return (
    <Card className="col-span-3">
      <CardContent className="flex h-[260px] items-center justify-center text-sm text-muted-foreground">
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
        <span className="ml-2">Memuat data...</span>
      </CardContent>
    </Card>
  );
}
