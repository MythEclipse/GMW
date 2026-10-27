import { useGSAP } from "@gsap/react"
import { gsap } from "gsap"
import { type ReactNode, useRef } from "react"

gsap.registerPlugin(useGSAP)

/**
 * Motion for the console.
 *
 * Two primitives only, both driven by data or by arrival — never by a timer:
 *
 *  - `Reveal` staggers a view's panels in on mount, so a route reads top-down in
 *    the order it is meant to be read.
 *  - `Ticker` counts a number to its new value, so a WS push that changes a
 *    headline figure is visible instead of silently swapping digits.
 *
 * Everything here is wrapped in `gsap.matchMedia`, which means the animations
 * are simply not created when the reader asks for reduced motion — the content
 * renders at its final state, not at a disabled half-state.
 */

/**
 * Stagger a view's direct children in.
 *
 * Animates CHILDREN rather than requiring a `data-*` attribute on every panel:
 * a view's layout already groups its own bands, so the markup stays untouched
 * and a new panel added later joins the sequence for free.
 */
export function Reveal({
	children,
	className,
}: {
	children: ReactNode
	className?: string
}) {
	const scope = useRef<HTMLDivElement>(null)

	useGSAP(
		() => {
			const mm = gsap.matchMedia()
			mm.add("(prefers-reduced-motion: no-preference)", () => {
				const panels = gsap.utils.toArray<HTMLElement>(
					":scope > *",
					scope.current,
				)
				if (panels.length === 0) return
				gsap.from(panels, {
					y: 10,
					autoAlpha: 0,
					duration: 0.42,
					ease: "power3.out",
					// Capped: a page with twelve bands should not make the reader wait
					// 500ms for the last one.
					stagger: { each: 0.045, from: "start" },
					clearProps: "opacity,visibility,transform",
				})
			})
			return () => mm.revert()
		},
		{ scope },
	)

	return (
		<div ref={scope} className={className}>
			{children}
		</div>
	)
}

/**
 * A number that counts to its value.
 *
 * The element's text is written directly rather than through React state: a
 * 60fps re-render of the whole tile to move one digit is the expensive way to
 * get the same pixels, and it would fight the query cache.
 *
 * `value` may be null (no data yet) — that renders the placeholder and skips the
 * animation, so a panel that is still loading does not count up from zero.
 */
export function Ticker({
	value,
	format,
	placeholder = "—",
}: {
	value: number | null | undefined
	format: (n: number) => string
	placeholder?: string
}) {
	const ref = useRef<HTMLSpanElement>(null)
	const shown = useRef<number | null>(null)

	useGSAP(
		() => {
			const el = ref.current
			if (!el) return

			if (value == null || Number.isNaN(value)) {
				el.textContent = placeholder
				shown.current = null
				return
			}

			const from = shown.current
			shown.current = value
			// First paint has nothing to count from, and a number animating up from
			// zero on every navigation reads as a slot machine rather than as data.
			if (from === null || from === value) {
				el.textContent = format(value)
				return
			}

			const mm = gsap.matchMedia()
			mm.add("(prefers-reduced-motion: no-preference)", () => {
				const state = { n: from }
				gsap.to(state, {
					n: value,
					duration: 0.5,
					ease: "power2.out",
					onUpdate: () => {
						el.textContent = format(state.n)
					},
					onComplete: () => {
						el.textContent = format(value)
					},
				})
			})
			return () => mm.revert()
		},
		{ dependencies: [value], scope: ref },
	)

	return <span ref={ref}>{value == null ? placeholder : format(value)}</span>
}
