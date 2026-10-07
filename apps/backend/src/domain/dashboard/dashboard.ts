/**
 * Query accepted by the dashboard's user list.
 *
 * Lives in `domain/` rather than in `application/dashboard/dashboard.service.ts`
 * because `infrastructure/repositories/dashboard.repository.ts` has to read it
 * too, and infrastructure may not depend on application — the dependency rule
 * points inward only. The application layer re-exports it, so existing importers
 * keep working.
 */
export interface ListUsersQuery {
	limit: number
	cursor?: string
	search?: string
}
