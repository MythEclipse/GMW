import { useMemo, useState } from "react"
import { Markdown } from "#/components/features/markdown"
import { Avatar } from "#/components/features/message-feed-card"
import { Section } from "#/components/layout/section"
import { Input } from "#/components/ui/input"
import { EmptyState, ErrorState, NoResultsState } from "#/components/ui/states"
import { useUsers } from "#/hooks/use-data"
import { formatNumber, formatRelative } from "#/libs/format"
import type { IUserSummary } from "#/libs/types"

export function UsersView() {
	const [search, setSearch] = useState("")

	const users = useUsers(search)

	const rows = useMemo(() => {
		const data = users.data?.data ?? []
		const q = search.trim().toLowerCase()
		if (!q) return data
		return data.filter((u) => u.username.toLowerCase().includes(q))
	}, [users.data?.data, search])

	return (
		<div className="space-y-4">
			<header>
				<h1 className="font-display text-xl font-semibold tracking-tight text-ink">
					Users
				</h1>
				<p className="text-xs text-ink-muted">
					Members ranked by message volume, with their analysed profile
				</p>
			</header>

			<Input
				value={search}
				onChange={(event) => setSearch(event.target.value)}
				placeholder="Filter members…"
				aria-label="Filter members"
				className="w-full sm:w-72"
			/>

			{users.error && !users.data ? (
				<ErrorState error={users.error} onRetry={() => void users.refetch()} />
			) : rows.length === 0 ? (
				search ? (
					<NoResultsState query={search} />
				) : (
					<EmptyState title="No members yet" />
				)
			) : (
				<Section
					title={`${formatNumber(rows.length)} members`}
					bodyClassName="p-0"
				>
					<ul
						className="divide-y divide-hairline"
						aria-busy={users.isFetching || undefined}
					>
						{rows.map((user) => (
							<li key={user.user_id}>
								<UserRow user={user} />
							</li>
						))}
					</ul>
				</Section>
			)}
		</div>
	)
}

function UserRow({ user }: { user: IUserSummary }) {
	const summary = user.profile_summary

	return (
		<details className="group px-4 py-3">
			<summary className="flex cursor-pointer list-none items-center gap-3">
				<Avatar src={user.avatar_url} name={user.username} size={28} />
				<span className="min-w-0 flex-1">
					<span className="block truncate text-sm text-ink">
						{user.username}
					</span>
					<span className="block truncate font-mono text-micro text-ink-faint">
						{user.user_id}
					</span>
				</span>
				{typeof user.total_messages === "number" && (
					<span className="reactor-count shrink-0 font-mono text-xs text-ink-muted">
						{formatNumber(user.total_messages)} msgs
					</span>
				)}
				{typeof user.flagged_count === "number" && user.flagged_count > 0 && (
					<span className="reactor-count shrink-0 font-mono text-xs text-amber">
						{formatNumber(user.flagged_count)} flagged
					</span>
				)}
			</summary>

			<div className="mt-3 border-l-2 border-hairline pl-3">
				{summary ? (
					<>
						<Markdown compact>{summary}</Markdown>
						{typeof user.last_seen_at === "number" && (
							<p className="mt-2 text-xs text-ink-faint">
								Last seen {formatRelative(user.last_seen_at)}
							</p>
						)}
					</>
				) : (
					<p className="text-xs text-ink-faint italic">
						No profile has been generated for this member.
					</p>
				)}
			</div>
		</details>
	)
}
