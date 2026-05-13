import { renderToString } from "react-dom/server";
import type { MessageRecord } from "../moderation/types";
import type { ChannelSummary, GuildSummary, VoiceChannelSummary, VoiceStatus } from "../voiceController";

interface DashboardProps {
  guilds: GuildSummary[];
  voiceChannels: VoiceChannelSummary[];
  watchChannels: ChannelSummary[];
  selectedGuildId: string;
  selectedChannelId: string;
  messages: MessageRecord[];
  status: VoiceStatus;
}

function parseMetadata(value: string | null): any {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function MessageCard({ message }: { message: MessageRecord }) {
  const metadata = parseMetadata(message.metadata);
  const content = message.edited_content || message.content || "(empty message)";

  return (
    <article className="event-card" data-message-id={message.id}>
      <div className="event-head">
        <div className="author">
          <div className="avatar">
            {message.avatar_url ? <img src={message.avatar_url} alt="" /> : null}
          </div>
          <div className="name">{message.username || message.user_id}</div>
        </div>
        <div className="time">{new Date(message.created_at).toLocaleString()}</div>
      </div>

      <div className="message-text">{content}</div>

      {metadata.stickers?.length ? (
        <div className="sticker-strip">
          {metadata.stickers.map((sticker: any) => (
            <img key={sticker.id} className="sticker-img" src={sticker.url} alt={sticker.name} />
          ))}
        </div>
      ) : null}

      {metadata.embeds?.length ? (
        <div className="feed">
          {metadata.embeds.map((embed: any, index: number) => (
            <div key={index} className="embed-card">
              {embed.title ? (
                embed.url ? (
                  <a className="embed-title" href={embed.url} target="_blank" rel="noreferrer">{embed.title}</a>
                ) : (
                  <div className="embed-title">{embed.title}</div>
                )
              ) : null}
              {embed.description ? <div className="embed-description">{embed.description}</div> : null}
              {embed.fields?.map((field: any, fieldIndex: number) => (
                <div key={fieldIndex} className="embed-description">{field.name}: {field.value}</div>
              ))}
              {embed.image || embed.thumbnail ? (
                <img className="embed-image" src={embed.image || embed.thumbnail} alt={embed.title || "embed image"} />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}

      {metadata.attachments?.length ? (
        <div className="attachment-strip">
          {metadata.attachments.map((attachment: any) => (
            <a key={attachment.id} className="attachment-chip" href={attachment.url} target="_blank" rel="noreferrer">
              {attachment.name} ({(attachment.size / 1024).toFixed(1)}KB)
            </a>
          ))}
        </div>
      ) : null}

      <div className="badges">
        {metadata.reference?.messageId ? <span className="badge">reply</span> : null}
        {message.thread_id ? (
          <span className="badge">{metadata.channel?.threadName ? `thread: ${metadata.channel.threadName}` : "thread"}</span>
        ) : null}
        {message.edited_at ? <span className="badge edit">edited</span> : null}
        {message.deleted_at ? <span className="badge delete">deleted</span> : null}
      </div>
    </article>
  );
}

function DashboardPage(props: DashboardProps) {
  return (
    <main className="shell">
      <section className="hero">
        <div className="brand-card">
          <div className="eyebrow"><span className="pulse" /> Discord moderation command center</div>
          <h1>Voice. Text. One Watch Floor.</h1>
          <p className="subtitle">Single-page watcher for live voice bridge and captured Discord messages, including stickers, embeds, replies, and uploaded image evidence inline.</p>
        </div>
        <div className="status-card">
          <div className="status-row"><span className="status-label">WebSocket</span><span className="status-value"><span id="wsDot" className="dot" /><span id="wsStatusText">Connecting</span></span></div>
          <div className="status-row"><span className="status-label">Voice Link</span><span id="voiceStatusText" className="status-value">{props.status.connected ? props.status.activeChannelName || "Connected" : "Not connected"}</span></div>
          <div className="status-row"><span className="status-label">Active Tab</span><span id="activeTabLabel" className="status-value">Voice</span></div>
        </div>
      </section>

      <nav className="tab-panel">
        <div className="tabs">
          <button className="tab-btn active" data-tab="voice">Voice</button>
          <button className="tab-btn" data-tab="text">Text</button>
        </div>
        <div className="filter-row">
          <span>Channel / Thread</span>
          <select id="channelFilter" defaultValue={props.selectedChannelId}>
            <option value="">Select channel</option>
            {props.watchChannels.map((channel) => (
              <option key={channel.id} value={channel.id}>{channel.name}</option>
            ))}
          </select>
        </div>
      </nav>

      <div id="errorBox" className="error" />

      <section id="voice" className="tab-content active">
        <div className="voice-layout">
          <div className="content-card">
            <div className="card-title"><h2>Voice Control</h2><span className="mini">bridge</span></div>
            <div className="field-group">
              <label htmlFor="guildSelect">Guild</label>
              <select id="guildSelect" defaultValue={props.selectedGuildId}>
                <option value="">Select guild</option>
                {props.guilds.map((guild) => <option key={guild.id} value={guild.id}>{guild.name}</option>)}
              </select>
            </div>
            <div className="field-group">
              <label htmlFor="channelSelect">Voice Channel</label>
              <select id="channelSelect">
                <option value="">Select voice channel</option>
                {props.voiceChannels.map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}
              </select>
            </div>
            <div className="button-row">
              <button id="joinVoiceBtn" className="btn btn-success">Join</button>
              <button id="disconnectVoiceBtn" className="btn btn-danger">Disconnect</button>
            </div>
            <div className="voice-status" id="voiceStatusNote">{props.status.connected ? `Connected to ${props.status.activeChannelName}` : "Idle"}</div>
          </div>

          <div className="content-card">
            <div className="card-title"><h2>Live Audio</h2><span className="mini" id="listenStatus">speaker off</span></div>
            <div style={{ display: "grid", gap: 12, gridTemplateColumns: "1fr 1fr", marginBottom: 14 }}>
              <button id="toggleBtn" className="btn btn-primary">Start Transmitting</button>
              <button id="listenBtn" className="btn btn-success">Join Listen Channel</button>
            </div>
            <div className="visualizer" id="visualizer" />
          </div>
        </div>

        <div className="content-card" style={{ marginTop: 18 }}>
          <div className="card-title"><h2>Participants</h2><span className="mini">speaking now</span></div>
          <div id="userList" className="participants" />
        </div>
      </section>

      <section id="text" className="tab-content">
        <div className="content-card">
          <div className="card-title"><h2>Text Watch</h2><span className="mini">create / edit / delete</span></div>
          <div id="textList" className="feed">
            {!props.selectedChannelId ? <div className="empty">Select channel to view text captures</div> : null}
            {props.selectedChannelId && props.messages.length === 0 ? <div className="empty">No text captures yet</div> : null}
            {props.messages.map((message) => <MessageCard key={message.id} message={message} />)}
          </div>
        </div>
      </section>
    </main>
  );
}

export function renderDashboardPage(props: DashboardProps): string {
  const app = renderToString(<DashboardPage {...props} />);
  const bootstrap = safeJson({
    guilds: props.guilds,
    voiceChannels: props.voiceChannels,
    watchChannels: props.watchChannels,
    selectedGuildId: props.selectedGuildId,
    selectedChannelId: props.selectedChannelId,
    messages: props.messages,
    status: props.status,
  });

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Discord Moderation Watcher</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Archivo+Black&family=JetBrains+Mono:wght@400;600;700&family=Manrope:wght@500;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/dashboard.css">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/tone/15.1.22/Tone.js"></script>
</head>
<body>
  <div id="root">${app}</div>
  <script id="__DASHBOARD_DATA__" type="application/json">${bootstrap}</script>
  <script src="/dashboard.js" defer></script>
</body>
</html>`;
}
