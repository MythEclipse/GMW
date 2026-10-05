"use client"

import { useEffect, useState } from "react"

/**
 * Debounce a value by `delay` ms.
 *
 * Used by the search box so a request is issued once the typing pauses instead
 * of once per keystroke. Returns the input immediately on the first render, so
 * a value passed in during SSR is never swallowed.
 */
export function useDebounced<T>(value: T, delay = 300): T {
	const [debounced, setDebounced] = useState(value)

	useEffect(() => {
		if (value === debounced) return
		const timer = setTimeout(() => setDebounced(value), delay)
		return () => clearTimeout(timer)
	}, [value, delay, debounced])

	return debounced
}
