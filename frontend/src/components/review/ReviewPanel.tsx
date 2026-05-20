import type { MessageRecord } from "../../types/messages";
import { MessageFeed } from "../messages/MessageFeed";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";

export interface ReviewPanelProps {
  messages: MessageRecord[];
  onReanalyze: (id: string) => void;
}

export function ReviewPanel({ messages, onReanalyze }: ReviewPanelProps) {
  const flaggedItems = messages.filter(
    (message) => message.ai_status === "warn" || message.ai_status === "flagged",
  );
  const errorItems = messages.filter((message) => message.ai_status === "error");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Needs Review</CardTitle>
        <CardDescription>
          {flaggedItems.length} flagged messages, {errorItems.length} analysis errors.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="flags">
          <TabsList>
            <TabsTrigger value="flags">Flags ({flaggedItems.length})</TabsTrigger>
            <TabsTrigger value="errors">Errors ({errorItems.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="flags">
            <MessageFeed
              messages={flaggedItems}
              onReanalyze={onReanalyze}
              emptyText="No warned or flagged messages."
            />
          </TabsContent>
          <TabsContent value="errors">
            <MessageFeed
              messages={errorItems}
              onReanalyze={onReanalyze}
              emptyText="No analysis errors."
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
