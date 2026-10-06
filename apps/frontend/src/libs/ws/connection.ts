import ReconnectingWebSocket from "partysocket/ws"
import type { IWsEvent, TConnectionStatus, TWsEventType } from "./types.ts"

type TListener = (event: IWsEvent) => void
type TStatusListener = (status: TConnectionStatus, detail?: string) => void

/**
 * The `/ws` event socket: a thin, typed wrapper over a reconnecting WebSocket.
 *
 * One socket is shared by the whole app via `WsProvider`; components subscribe
 * through `useWsEvent` rather than opening their own. Subscriptions are a
 * `Map<type, Set<listener>>` so a component only wakes for the events it
 * asked for, and a re-render does not silently drop a listener.
 */
export class WsConnection {
	private socket: ReconnectingWebSocket | null = null
	private readonly listeners = new Map<TWsEventType, Set<TListener>>()
	private readonly statusListeners = new Set<TStatusListener>()
	private status: TConnectionStatus = "connecting"
	private reconnectAttempts = 0

	connect(): void {
		if (this.socket) return

		const url = this.url()
		this.setStatus("connecting")

		const socket = new ReconnectingWebSocket(url, null, {
			maxRetries: Number.POSITIVE_INFINITY,
			minReconnectionDelay: 500,
			maxReconnectionDelay: 10_000,
			reconnectionDelayGrowFactor: 1.5,
		})
		this.socket = socket

		socket.addEventListener("open", () => {
			this.reconnectAttempts = 0
			this.setStatus("connected")
		})

		socket.addEventListener("message", (event: MessageEvent) => {
			this.handleMessage(event.data)
		})

		socket.addEventListener("error", () => {
			this.reconnectAttempts += 1
			this.setStatus("reconnecting", `attempt ${this.reconnectAttempts}`)
		})

		socket.addEventListener("close", () => {
			this.reconnectAttempts += 1
			this.setStatus("reconnecting", `attempt ${this.reconnectAttempts}`)
		})
	}

	private url(): string {
		// `import.meta.env`, not `process.env` — see the same note in
		// `#/libs/orpc/client.ts`. Both sockets read one VITE_WS_URL so the two
		// cannot drift apart.
		const configured = import.meta.env.VITE_WS_URL
		if (configured) return configured

		const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
		// Same-origin: the proxy forwards /ws to the backend.
		return `${protocol}//${window.location.host}/ws`
	}

	private handleMessage(raw: unknown): void {
		if (typeof raw !== "string") return // binary frames are voice PCM

		let parsed: IWsEvent
		try {
			parsed = JSON.parse(raw) as IWsEvent
		} catch {
			return
		}

		if (!parsed?.type) return

		const set = this.listeners.get(parsed.type)
		if (!set) return
		for (const listener of set) {
			try {
				listener(parsed)
			} catch (err) {
				// One bad subscriber must not stop the others from being notified.
				console.error(`[ws] listener for "${parsed.type}" threw`, err)
			}
		}
	}

	private setStatus(status: TConnectionStatus, detail?: string): void {
		this.status = status
		for (const listener of this.statusListeners) listener(status, detail)
	}

	getStatus(): TConnectionStatus {
		return this.status
	}

	subscribe(type: TWsEventType, listener: TListener): () => void {
		let set = this.listeners.get(type)
		if (!set) {
			set = new Set()
			this.listeners.set(type, set)
		}
		set.add(listener)

		return () => {
			set?.delete(listener)
			if (set && set.size === 0) this.listeners.delete(type)
		}
	}

	onStatusChange(listener: TStatusListener): () => void {
		this.statusListeners.add(listener)
		listener(this.status)
		return () => this.statusListeners.delete(listener)
	}

	/**
	 * Ask the backend to replay messages into this socket as
	 * `message_snapshot` frames, oldest-last, then one `message_snapshot_end`.
	 */
	streamMessages(options: {
		guildId?: string
		channelId?: string
		cursor?: string
		limit?: number
	}): void {
		if (this.socket?.readyState !== 1) return
		this.socket.send(
			JSON.stringify({ type: "stream_messages", payload: options }),
		)
	}

	close(): void {
		this.socket?.close()
		this.socket = null
	}
}
