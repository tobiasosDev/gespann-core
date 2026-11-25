import { ExternalLink, Lock } from "lucide-react";
import { useState } from "react";
import { api, type RepoGroup, useResource } from "../api.ts";
import { Button, Card, CardHeader, Empty, Input, LinkButton } from "../components/ui.tsx";
import { navigate } from "../nav.tsx";

export function NewProject({ installUrl }: { installUrl: string | null }) {
  const { data, error } = useResource<{ groups: RepoGroup[] }>("/repos");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState<number | null>(null);
  const add = async (installation: number, repo: number) => {
    setBusy(repo);
    try {
      const r = await api<{ id: number }>("/projects", { installation, repo });
      navigate(`/projects/${r.id}`);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <h1 className="mb-1 text-xl font-semibold">Add project</h1>
      <p className="mb-4 text-[13px] text-muted-foreground">Repositories where the gespann GitHub App is installed.</p>
      <div className="mb-3 flex gap-2">
        <Input placeholder="Filter repositories" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-xs" />
        {installUrl && (
          <LinkButton href={installUrl} variant="outline">
            Install on more repos <ExternalLink className="size-3.5" />
          </LinkButton>
        )}
      </div>
      {error && <p className="mb-3 text-bad">{error}</p>}
      {!data && !error && <p className="text-muted-foreground">Loading…</p>}
      {data?.groups.length === 0 && (
        <Card>
          <Empty>The app is not installed on any account you can access.</Empty>
        </Card>
      )}
      <div className="space-y-4">
        {data?.groups.map((g) => (
          <Card key={g.installation}>
            <CardHeader title={g.account} />
            {g.repos
              .filter((r) => r.full_name.toLowerCase().includes(filter.toLowerCase()))
              .map((r) => (
                <div key={r.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-0">
                  <span className="flex-1 truncate">{r.full_name}</span>
                  {r.private && <Lock className="size-3.5 text-muted-foreground" aria-label="private" />}
                  {r.project ? (
                    <Button variant="ghost" size="sm" onClick={() => navigate(`/projects/${r.project}`)}>
                      Open
                    </Button>
                  ) : (
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => add(g.installation, r.id)}>
                      {busy === r.id ? "Adding…" : "Add"}
                    </Button>
                  )}
                </div>
              ))}
          </Card>
        ))}
      </div>
    </>
  );
}
