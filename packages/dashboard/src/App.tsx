import { startTransition, useDeferredValue, useEffect, useEffectEvent, useState } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

import type { DashboardPayload, ResearchEvent, ResultRecord } from "./dashboard-types.ts";
import { fetchDashboardState } from "./trpc.ts";

const POLL_INTERVAL_MS = 1000;

function formatMetric(value: number | null | undefined): string {
  return typeof value === "number" ? value.toFixed(6) : "n/a";
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) {
    return "n/a";
  }
  return new Date(value).toLocaleString();
}

function decisionTone(decision: ResultRecord["decision"] | null | undefined): string {
  switch (decision) {
    case "baseline":
    case "keep":
      return "good";
    case "discard":
      return "warn";
    case "crash":
      return "danger";
    default:
      return "neutral";
  }
}

function statusTone(status: DashboardPayload["state"]["status"] | null | undefined): string {
  switch (status) {
    case "editing":
    case "evaluating":
      return "good";
    case "stopped":
      return "warn";
    default:
      return "neutral";
  }
}

function MetricSummary({
  snapshot,
  primaryLabel,
  secondaryLabel,
}: {
  snapshot: ResultRecord["eval"] | null;
  primaryLabel: string;
  secondaryLabel: string | null;
}) {
  return (
    <div className="metric-summary">
      <div>
        <span className="metric-label">{primaryLabel}</span>
        <strong>{formatMetric(snapshot?.primary)}</strong>
      </div>
      {secondaryLabel ? (
        <div>
          <span className="metric-label">{secondaryLabel}</span>
          <strong>{formatMetric(snapshot?.secondary)}</strong>
        </div>
      ) : null}
    </div>
  );
}

function ScoreChart({
  results,
  primaryLabel,
}: {
  results: ResultRecord[];
  primaryLabel: string;
}) {
  const points = results.flatMap((record, index) =>
    record.eval ? [{ index, value: record.eval.primary, decision: record.decision }] : [],
  );

  if (points.length === 0) {
    return (
      <div className="empty-state">
        <p>No scored iterations yet.</p>
        <span>{primaryLabel} will appear here once the first result is recorded.</span>
      </div>
    );
  }

  const width = 960;
  const height = 320;
  const left = 28;
  const right = 22;
  const top = 20;
  const bottom = 34;
  const min = Math.min(...points.map((point) => point.value));
  const max = Math.max(...points.map((point) => point.value));
  const span = Math.max(1e-9, max - min);
  const mid = min + span / 2;
  const normalizeY = (value: number): number =>
    height - bottom - ((height - top - bottom) * (value - min)) / span;
  const normalizeX = (index: number): number =>
    left + ((width - left - right) * index) / Math.max(1, points.length - 1);
  const linePoints = points
    .map((point) => `${normalizeX(point.index)},${normalizeY(point.value)}`)
    .join(" ");

  return (
    <div className="chart-shell">
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-label={`${primaryLabel} trajectory`}
      >
        {[max, mid, min].map((tick) => (
          <g key={tick}>
            <line
              x1={left}
              x2={width - right}
              y1={normalizeY(tick)}
              y2={normalizeY(tick)}
              className="chart-grid"
            />
            <text x={left} y={normalizeY(tick) - 6} className="chart-label">
              {tick.toFixed(6)}
            </text>
          </g>
        ))}
        <polyline points={linePoints} className="chart-line" />
        {points.map((point) => (
          <circle
            key={`${point.index}-${point.decision}`}
            cx={normalizeX(point.index)}
            cy={normalizeY(point.value)}
            r="5.5"
            className={`chart-dot ${decisionTone(point.decision)}`}
          />
        ))}
      </svg>
      <div className="chart-caption">
        <span>{points.length} scored results</span>
        <span>
          range {min.toFixed(6)} to {max.toFixed(6)}
        </span>
      </div>
    </div>
  );
}

function EventStream({ events }: { events: ResearchEvent[] }) {
  if (events.length === 0) {
    return (
      <div className="empty-state compact">
        <p>No events yet.</p>
      </div>
    );
  }

  return (
    <ol className="event-list">
      {events
        .slice()
        .reverse()
        .map((event) => (
          <li key={`${event.timestamp}-${event.type}-${event.iteration}`}>
            <div className="event-meta">
              <span>{event.type}</span>
              <time>{formatTimestamp(event.timestamp)}</time>
            </div>
            <p>{event.message}</p>
          </li>
        ))}
    </ol>
  );
}

function TranscriptJump() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();

  if (isAtBottom) {
    return <span className="follow-pill">Following live output</span>;
  }

  return (
    <button className="follow-pill actionable" type="button" onClick={() => scrollToBottom()}>
      Jump to live tail
    </button>
  );
}

function TranscriptPanel({ transcript }: { transcript: string }) {
  return (
    <StickToBottom className="transcript-shell" initial="instant" resize="instant">
      <StickToBottom.Content className="transcript-content">
        <pre>{transcript.length > 0 ? transcript : "Waiting for transcript output..."}</pre>
      </StickToBottom.Content>
      <div className="transcript-toolbar">
        <TranscriptJump />
      </div>
    </StickToBottom>
  );
}

function App() {
  const [payload, setPayload] = useState<DashboardPayload | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const deferredTranscript = useDeferredValue(payload?.transcriptTail ?? "");

  const refresh = useEffectEvent(async (signal?: AbortSignal) => {
    setIsRefreshing(true);
    try {
      const next = await fetchDashboardState(signal);
      startTransition(() => {
        setPayload(next);
        setConnectionError(null);
        setLastSyncedAt(new Date().toISOString());
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return;
      }
      setConnectionError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsRefreshing(false);
    }
  });

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);

    const interval = window.setInterval(() => {
      void refresh();
    }, POLL_INTERVAL_MS);

    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, []);

  const results = payload?.results ?? [];
  const best = payload?.best ?? null;
  const latest = payload?.latest ?? null;
  const primaryLabel = payload?.project.primaryLabel ?? "primary";
  const secondaryLabel = payload?.project.secondaryLabel ?? null;

  return (
    <main className="app-shell">
      <section className="hero panel">
        <div className="hero-copy">
          <p className="eyebrow">Autonomous Research Loop</p>
          <h1>Autoresearch Dashboard</h1>
          <p className="hero-text">
            Live state, scoring history, recent decisions, and the active Codex transcript for the
            deterministic Minesweeper solver loop.
          </p>
        </div>
        <div className="hero-meta">
          <span className={`badge ${statusTone(payload?.state.status)}`}>
            {payload?.state.status ?? "loading"}
            {payload ? ` · iteration ${payload.state.currentIteration}` : ""}
          </span>
          <span className={`badge ${connectionError ? "danger" : "neutral"}`}>
            {connectionError
              ? `sync issue: ${connectionError}`
              : isRefreshing
                ? "syncing…"
                : "connected"}
          </span>
          <span className="badge neutral">last sync {formatTimestamp(lastSyncedAt)}</span>
        </div>
      </section>

      <section className="summary-grid">
        <article className="panel stat-card">
          <p className="eyebrow">Loop Status</p>
          <div className="card-header">
            <h2>{payload?.state.message ?? "Waiting for data..."}</h2>
            <span className={`badge ${statusTone(payload?.state.status)}`}>
              {payload?.state.currentBranch || "no branch"}
            </span>
          </div>
          <p className="supporting">
            {payload?.project.projectRoot ??
              "Project root will appear after the first API response."}
          </p>
        </article>

        <article className="panel stat-card">
          <p className="eyebrow">Best Eval</p>
          <h2>{formatMetric(best?.eval?.primary)}</h2>
          <MetricSummary
            snapshot={best?.eval ?? null}
            primaryLabel={primaryLabel}
            secondaryLabel={secondaryLabel}
          />
        </article>

        <article className="panel stat-card">
          <p className="eyebrow">Latest Decision</p>
          <div className="card-header">
            <h2>{latest?.decision ?? "n/a"}</h2>
            <span className={`badge ${decisionTone(latest?.decision)}`}>
              {latest?.candidate ?? "candidate"}
            </span>
          </div>
          <p className="supporting">
            {latest?.description || latest?.reason || "No recorded result yet."}
          </p>
        </article>

        <article className="panel stat-card">
          <p className="eyebrow">Latest Holdout</p>
          <h2>{formatMetric(latest?.holdout?.primary)}</h2>
          <MetricSummary
            snapshot={latest?.holdout ?? null}
            primaryLabel={primaryLabel}
            secondaryLabel={secondaryLabel}
          />
        </article>
      </section>

      <section className="content-grid">
        <article className="panel chart-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Score Trajectory</p>
              <h2>{primaryLabel} across accepted, discarded, and crash records</h2>
            </div>
            <p className="supporting">
              The loop still judges changes on eval first, then the secondary metric as a
              tie-breaker.
            </p>
          </div>
          <ScoreChart results={results} primaryLabel={primaryLabel} />
        </article>

        <article className="panel details-panel">
          <p className="eyebrow">Project</p>
          <dl className="details-list">
            <div>
              <dt>Root</dt>
              <dd>{payload?.project.projectRoot ?? "n/a"}</dd>
            </div>
            <div>
              <dt>Editable Paths</dt>
              <dd>{payload?.project.editablePaths.join(", ") ?? "n/a"}</dd>
            </div>
            <div>
              <dt>Events File</dt>
              <dd>{payload?.state.eventsPath ?? "n/a"}</dd>
            </div>
            <div>
              <dt>Transcript</dt>
              <dd>{payload?.state.currentTranscriptPath ?? "n/a"}</dd>
            </div>
          </dl>
        </article>

        <article className="panel table-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Recent Results</p>
              <h2>Latest benchmark decisions</h2>
            </div>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Decision</th>
                  <th>Eval</th>
                  <th>Holdout</th>
                  <th>Description</th>
                </tr>
              </thead>
              <tbody>
                {results.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="table-empty">
                      No results yet.
                    </td>
                  </tr>
                ) : (
                  results
                    .slice(-12)
                    .reverse()
                    .map((record) => (
                      <tr key={`${record.timestamp}-${record.commit}-${record.decision}`}>
                        <td>
                          <span className={`badge ${decisionTone(record.decision)}`}>
                            {record.decision}
                          </span>
                        </td>
                        <td>
                          <MetricSummary
                            snapshot={record.eval}
                            primaryLabel={primaryLabel}
                            secondaryLabel={secondaryLabel}
                          />
                        </td>
                        <td>
                          <MetricSummary
                            snapshot={record.holdout}
                            primaryLabel={primaryLabel}
                            secondaryLabel={secondaryLabel}
                          />
                        </td>
                        <td className="description-cell">
                          {record.description || record.reason || "(none)"}
                        </td>
                      </tr>
                    ))
                )}
              </tbody>
            </table>
          </div>
        </article>

        <article className="panel events-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Event Stream</p>
              <h2>Most recent runtime events</h2>
            </div>
          </div>
          <EventStream events={payload?.events ?? []} />
        </article>

        <article className="panel transcript-panel">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Live Transcript</p>
              <h2>Current Codex session output</h2>
            </div>
            <p className="supporting">
              The transcript tail is polled from the current runtime file and sticks to the bottom
              while you follow it live.
            </p>
          </div>
          <TranscriptPanel transcript={deferredTranscript} />
        </article>
      </section>
    </main>
  );
}

export default App;
