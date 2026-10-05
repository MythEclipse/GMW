import { cn } from "cn"

/**
 * Section wrapper: a titled HUD panel with an optional action slot.
 *
 * The `hud-card` treatment (border, blur, lift-on-hover) lives in the CSS layer
 * so a panel never has to restate it, and so the oxlint `shadcn/no-restyle`
 * rule has a single class to recognise.
 */
export function Section({
	title,
	description,
	action,
	children,
	className,
	bodyClassName,
}: {
	title?: string
	description?: string
	action?: React.ReactNode
	children: React.ReactNode
	className?: string
	bodyClassName?: string
}) {
	return (
		<section className={cn("hud-card flex flex-col", className)}>
			{(title || action) && (
				<header className="flex items-start justify-between gap-3 border-b border-hairline px-4 py-3">
					<div className="min-w-0">
						{title && (
							<h2 className="truncate text-sm font-medium tracking-wide text-ink">
								{title}
							</h2>
						)}
						{description && (
							<p className="mt-0.5 text-xs text-ink-muted">{description}</p>
						)}
					</div>
					{action && <div className="shrink-0">{action}</div>}
				</header>
			)}
			<div className={cn("flex-1 p-4", bodyClassName)}>{children}</div>
		</section>
	)
}

/** A responsive grid of panels. `cols` is the desktop column count. */
export function SectionGrid({
	children,
	cols = 2,
	className,
}: {
	children: React.ReactNode
	cols?: 1 | 2 | 3 | 4
	className?: string
}) {
	const gridCols = {
		1: "lg:grid-cols-1",
		2: "lg:grid-cols-2",
		3: "lg:grid-cols-3",
		4: "lg:grid-cols-2 xl:grid-cols-4",
	}[cols]

	return (
		<div
			className={cn(
				// `items-start` so a panel is as tall as its own content. The default
				// `stretch` forced every panel in a row to the height of the tallest,
				// which left the short ranked list wearing a 15-row panel's height
				// and ~60% of it was empty space. Panels with similar content height
				// look identical either way, so this only changes the mismatched case.
				"grid grid-cols-1 items-start gap-4 md:grid-cols-2",
				gridCols,
				className,
			)}
		>
			{children}
		</div>
	)
}
