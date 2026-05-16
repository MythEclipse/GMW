import { RotateCw } from "lucide-react";
import type { MessageRecord } from "../../types/messages";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

export interface MessageCardProps {
  message: MessageRecord;
  onReanalyze: (id: string) => void;
}

function aiVariant(status: string) {
  if (status === "clean") return "success";
  if (status === "warn") return "warning";
  if (status === "flagged" || status === "error") return "destructive";
  return "secondary";
}

export function MessageCard({ message, onReanalyze }: MessageCardProps) {
  const displayContent = message.edited_content ?? message.content;
  const aiStatus = message.ai_status ?? "pending";

  return (
    <article className="rounded-2xl border border-border bg-card p-4 shadow-sm">
      <div className="flex gap-3">
        <img
          src={message.avatar_url ?? "https://cdn.discordapp.com/embed/avatars/0.png"}
          alt=""
          className="h-10 w-10 rounded-full object-cover"
        />
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{message.username || message.user_id}</span>
            <span className="text-xs text-muted-foreground">{new Date(message.created_at).toLocaleString()}</span>
            {message.edited_at ? <Badge variant="outline">edited</Badge> : null}
            {message.deleted_at ? <Badge variant="destructive">deleted</Badge> : null}
            <Badge variant={aiVariant(aiStatus)}>{aiStatus}</Badge>
          </div>
          <p className="whitespace-pre-wrap break-words text-sm leading-6 text-foreground/90">
            {displayContent || "(empty message)"}
          </p>
          {message.ai_analysis ? <div className="rounded-xl bg-muted p-3 text-sm text-muted-foreground">{message.ai_analysis}</div> : null}
          {message.ai_error ? <div className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">AI error: {message.ai_error}</div> : null}
          <Button size="sm" variant="outline" onClick={() => onReanalyze(message.id)} disabled={aiStatus === "pending"}>
            <RotateCw className="h-3.5 w-3.5" />
            Re-analyze
          </Button>
        </div>
      </div>
    </article>
  );
}
