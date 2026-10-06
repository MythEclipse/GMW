import { cn } from "cn"
import { AlertCircle, Inbox, Loader2, RefreshCw, SearchX } from "lucide-react"
import { Button } from "#/components/ui/button"

/**
 * Loading / empty / error states.
 *
 * The contract every view follows: an error is ALWAYS paired with a retry that
 * calls the hook's `mutate`. An `ErrorState` without `onRetry` strands the user
 * on a dead panel until they reload the whole page by hand — that was the
 * default in the previous frontend, and it is why `onRetry` is required by type
 * rather than optional.
 */
export function LoadingState({
	label = "Loading",
	className,
}: {
	label?: string
	className?: string
}) {
	return (
		<div
			className={cn(
				"flex items-center justify-center gap-2 py-12 text-sm text-ink-muted",
				className,
			)}
			role="status"
		>
			<Loader2 className="size-4 animate-spin" aria-hidden />
			<span>{label}…</span>
		</div>
	)
}

export function ErrorState({
	error,
	onRetry,
	className,
}: {
	error: unknown
	onRetry?: () => void
	className?: string
}) {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "Unknown error"

	return (
		<div
			className={cn(
				"flex flex-col items-center gap-3 rounded-lg border border-hairline bg-surface px-6 py-8 text-center",
				className,
			)}
			role="alert"
		>
			<AlertCircle className="size-5 text-vermilion" aria-hidden />
			<div className="space-y-1">
				<p className="text-sm font-medium text-ink">Failed to load</p>
				<p className="max-w-md text-xs text-ink-muted break-words">{message}</p>
			</div>
			{onRetry && (
				<Button variant="outline" size="sm" onClick={onRetry}>
					<RefreshCw aria-hidden />
					Retry
				</Button>
			)}
		</div>
	)
}

/** Nothing matched — distinct from "failed to load". */
export function EmptyState({
	title = "Nothing here yet",
	description,
	action,
	className,
}: {
	title?: string
	description?: string
	action?: React.ReactNode
	className?: string
}) {
	return (
		<div
			className={cn(
				"flex flex-col items-center gap-2 rounded-lg border border-dashed border-hairline px-6 py-10 text-center",
				className,
			)}
		>
			<Inbox className="size-5 text-ink-faint" aria-hidden />
			<p className="text-sm text-ink-soft">{title}</p>
			{description && (
				<p className="max-w-md text-xs text-ink-muted">{description}</p>
			)}
			{action}
		</div>
	)
}

export function NoResultsState({ query }: { query: string }) {
	return (
		<div className="flex flex-col items-center gap-2 py-10 text-center">
			<SearchX className="size-5 text-ink-faint" aria-hidden />
			<p className="text-sm text-ink-soft">No matches for “{query}”</p>
		</div>
	)
}
