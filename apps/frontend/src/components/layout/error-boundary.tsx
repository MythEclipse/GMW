import { Component, type ReactNode } from "react"
import { Button } from "#/components/ui/button"

interface IProps {
	children: ReactNode
	/** Rendered instead of the default card when a crash happens. */
	fallback?: (error: Error, reset: () => void) => ReactNode
}

interface IState {
	error: Error | null
}

/**
 * React error boundary for render crashes.
 *
 * Distinct from `ErrorState`, which shows a *fetch* failure. This catches a
 * throw during render — the one case a try/catch inside a component cannot
 * handle, because the component never finishes mounting.
 *
 * A crashing panel must not take down the whole shell, so the boundary is
 * scoped to the panel it wraps and offers a reset that remounts the subtree.
 */
export class ErrorBoundary extends Component<IProps, IState> {
	state: IState = { error: null }

	static getDerivedStateFromError(error: Error): IState {
		return { error }
	}

	componentDidCatch(error: Error, info: React.ErrorInfo): void {
		console.error("[ErrorBoundary] render crashed", error, info.componentStack)
	}

	private reset = (): void => {
		this.setState({ error: null })
	}

	render(): ReactNode {
		const { error } = this.state
		if (!error) return this.props.children

		if (this.props.fallback) return this.props.fallback(error, this.reset)

		return (
			<div
				className="flex flex-col items-start gap-3 rounded-lg border border-hairline bg-surface px-4 py-6"
				role="alert"
			>
				<div className="space-y-1">
					<p className="text-sm font-medium text-ink">
						This panel failed to render
					</p>
					<p className="max-w-md text-xs text-ink-muted break-words">
						{error.message}
					</p>
				</div>
				<Button variant="outline" size="sm" onClick={this.reset}>
					Try again
				</Button>
			</div>
		)
	}
}
