type AdminWorkspaceLoadingStateProps = {
  label: string;
};

export function AdminWorkspaceLoadingState({ label }: AdminWorkspaceLoadingStateProps) {
  return (
    <div aria-busy="true" aria-label={label} className="admin-workspace" role="status">
      <aside className="admin-sidebar bg-card text-card-foreground">
        <div className="border-b border-border px-5 py-5">
          <div className="h-4 w-24 animate-pulse rounded-sm bg-muted" />
        </div>
        <div className="space-y-1.5 px-3 pb-4 pt-3">
          {Array.from({ length: 5 }, (_, index) => (
            <div className="flex min-h-10 items-center gap-3 px-2.5 py-2" key={index}>
              <div className="size-7 animate-pulse rounded-md bg-muted" />
              <div className="h-3 w-16 animate-pulse rounded-sm bg-muted" />
            </div>
          ))}
        </div>
      </aside>

      <div className="admin-main-shell">
        <header className="admin-topbar admin-topbar-compact">
          <div className="flex w-full items-center justify-between gap-3">
            <div className="size-9 animate-pulse rounded-md bg-muted lg:hidden" />
            <div className="ml-auto h-8 w-20 animate-pulse rounded-md bg-muted" />
          </div>
        </header>

        <div className="admin-main-content-shell">
          <main className="admin-main-content space-y-5">
            <div className="space-y-2">
              <div className="h-6 w-36 animate-pulse rounded-sm bg-muted" />
              <div className="h-4 w-64 animate-pulse rounded-sm bg-muted" />
            </div>
            <div className="border border-border bg-card">
              <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                <div className="h-8 w-44 animate-pulse rounded-md bg-muted" />
                <div className="h-8 w-20 animate-pulse rounded-md bg-muted" />
              </div>
              <div className="space-y-3 p-4">
                {Array.from({ length: 5 }, (_, index) => (
                  <div className="grid grid-cols-4 gap-4" key={index}>
                    <div className="col-span-2 h-4 animate-pulse rounded-sm bg-muted" />
                    <div className="h-4 animate-pulse rounded-sm bg-muted" />
                    <div className="h-4 animate-pulse rounded-sm bg-muted" />
                  </div>
                ))}
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
