"use client"

import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import { WsConnection } from "./connection"
import type { ConnectionStatus, WsEvent, WsEventType } from "./types"

interface WsContextValue {
	connection: WsConnection
	status: ConnectionStatus
	statusDetail: string | undefined
}

const WsContext = createContext<WsContextValue | null>(null)

export function WsProvider({ children }: { children: ReactNode }) {
	const connectionRef = useRef<WsConnection | null>(null)
	if (!connectionRef.current) {
		connectionRef.current = new WsConnection()
	}
	const connection = connectionRef.current

	const [status, setStatus] = useState<ConnectionStatus>("connecting")
	const [statusDetail, setStatusDetail] = useState<string | undefined>(
		undefined,
	)

	useEffect(() => {
		connection.connect()
		const unsubscribe = connection.onStatusChange((next, detail) => {
			setStatus(next)
			setStatusDetail(detail)
		})
		return () => {
			unsubscribe()
			connection.close()
		}
	}, [connection])

	const value = useMemo<WsContextValue>(
		() => ({ connection, status, statusDetail }),
		[connection, status, statusDetail],
	)

	return <WsContext.Provider value={value}>{children}</WsContext.Provider>
}

/** Access the shared socket. Throws outside `WsProvider`. */
export function useWs(): WsContextValue {
	const ctx = useContext(WsContext)
	if (!ctx) throw new Error("useWs must be used inside <WsProvider>")
	return ctx
}

/**
 * Subscribe to one event type for the lifetime of the component.
 *
 * The handler is held in a ref so a caller can pass an inline closure without
 * re-subscribing on every render — the subscription is keyed on `type` alone.
 */
export function useWsEvent<T = unknown>(
	type: WsEventType,
	handler: (event: WsEvent<T>) => void,
): void {
	const { connection } = useWs()
	const handlerRef = useRef(handler)
	handlerRef.current = handler

	const stableHandler = useCallback(
		(event: WsEvent) => handlerRef.current(event as WsEvent<T>),
		[],
	)

	useEffect(
		() => connection.subscribe(type, stableHandler),
		[connection, type, stableHandler],
	)
}
