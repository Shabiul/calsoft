import type { Metadata } from "next";
import { OPERATIONS } from "@/server/api/openapi";

export const metadata: Metadata = { title: "API documentation" };

const tags = [...new Set(OPERATIONS.map((o) => o.tag))];

export default function ApiDocsPage() {
  return (
    <main className="mx-auto w-full min-w-0 max-w-4xl space-y-8 px-4 py-10">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold tracking-tight">MeetFlow REST API</h1>
        <p className="text-muted-foreground">
          Base URL <code>/api/v1</code>. Machine-readable spec: <a className="underline" href="/api/v1/openapi.json">/api/v1/openapi.json</a>.
        </p>
      </header>

      <section className="space-y-2 text-sm [&_code]:break-all">
        <h2 className="text-xl font-semibold">Authentication</h2>
        <p>Create an API key under Settings, then send it as a bearer token. Keys carry scopes; a missing scope returns 403 INSUFFICIENT_SCOPE.</p>
        <pre className="overflow-x-auto rounded-lg border bg-muted p-3">{`curl -H "Authorization: Bearer mf_live_..." https://your-host/api/v1/events`}</pre>
        <h2 className="pt-4 text-xl font-semibold">Conventions</h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>Rate limit per key: <code>X-RateLimit-Limit</code>, <code>X-RateLimit-Remaining</code>, <code>X-RateLimit-Reset</code>; 429 with <code>Retry-After</code> when exceeded.</li>
          <li>Errors: <code>{`{"error":{"code","message","details?","request_id"}}`}</code>. Every response has <code>X-Request-Id</code>.</li>
          <li>Pagination: <code>?limit=&amp;cursor=</code> returns <code>{`{data, has_more, next_cursor}`}</code>.</li>
          <li>Resources outside your account respond 404.</li>
          <li>Send <code>Idempotency-Key</code> on POST /bookings to make retries safe.</li>
        </ul>
      </section>

      {tags.map((tag) => (
        <section key={tag} className="space-y-3">
          <h2 className="text-xl font-semibold">{tag}</h2>
          <div className="divide-y rounded-xl border bg-card">
            {OPERATIONS.filter((o) => o.tag === tag).map((o) => (
              <div key={o.method + o.path} className="space-y-1 p-4 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded bg-primary/10 px-2 py-0.5 font-mono text-xs font-semibold uppercase">{o.method}</span>
                  <code className="font-mono">/api/v1{o.path}</code>
                  <span className="ml-auto rounded border px-2 py-0.5 text-xs text-muted-foreground">{o.scope}</span>
                </div>
                <p>{o.summary}</p>
                {o.body ? <p className="text-muted-foreground">Body: {o.body}</p> : null}
                {o.query?.length ? (
                  <p className="text-muted-foreground">
                    Query: {o.query.map(([n, d, r]) => `${n}${r ? "*" : ""} (${d})`).join("; ")}
                  </p>
                ) : null}
              </div>
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
