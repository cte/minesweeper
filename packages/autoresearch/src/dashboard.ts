import http from "node:http";
import { URL } from "node:url";

import { readResearchEvents } from "./events.js";
import { getAcceptedResultRecords, readResultRecords } from "./store.js";
import { readResearchState } from "./state.js";
import type { ResearchPaths, ResearchProject } from "./types.js";
import { resolveResearchPaths } from "./runtime.js";
import { tailText } from "./utils.js";

interface DashboardOptions {
  host: string;
  port: number;
}

function parseArgs(argv: string[]): DashboardOptions {
  const options: DashboardOptions = {
    host: "127.0.0.1",
    port: 4312,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--") {
      continue;
    }
    if (arg === "--host" && next) {
      options.host = next;
      i += 1;
    } else if (arg === "--port" && next) {
      options.port = Number(next);
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      console.error("Usage: research:dashboard -- [--host 127.0.0.1] [--port 4312]");
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port <= 0) {
    throw new Error("Port must be a positive integer");
  }
  return options;
}

function readDashboardPayload(project: ResearchProject, paths: ResearchPaths) {
  const state = readResearchState(project, paths);
  const results = readResultRecords(paths);
  const accepted = getAcceptedResultRecords(results);
  return {
    project: {
      name: project.projectName,
      projectRoot: project.projectRoot,
      editablePaths: project.editablePaths,
      primaryLabel: project.metrics.primaryLabel,
      secondaryLabel: project.metrics.secondaryLabel,
    },
    state,
    results,
    best: accepted.at(-1) ?? null,
    latest: results.at(-1) ?? null,
    events: readResearchEvents(paths).slice(-100),
    transcriptTail: tailText(paths.currentTranscriptPath, 50_000),
  };
}

function htmlPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Autoresearch Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f4ee;
      --panel: #fffdf7;
      --ink: #1e2420;
      --muted: #5b635d;
      --border: #d9d3c6;
      --accent: #0f766e;
      --accent-soft: #d6f0ed;
      --danger: #b42318;
      --warn: #b54708;
      --shadow: 0 16px 40px rgba(32, 38, 35, 0.08);
      font-family: "Iowan Old Style", "Palatino Linotype", "Book Antiqua", serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15,118,110,0.12), transparent 26%),
        radial-gradient(circle at top right, rgba(180,71,8,0.10), transparent 22%),
        var(--bg);
    }
    main {
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px;
    }
    .hero {
      display: grid;
      gap: 16px;
      margin-bottom: 20px;
    }
    .hero h1 {
      margin: 0;
      font-size: clamp(2rem, 4vw, 3.5rem);
      line-height: 0.95;
      letter-spacing: -0.04em;
    }
    .hero p {
      margin: 0;
      max-width: 60rem;
      color: var(--muted);
      font-size: 1rem;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(12, 1fr);
      gap: 16px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 18px;
      box-shadow: var(--shadow);
    }
    .span-4 { grid-column: span 4; }
    .span-6 { grid-column: span 6; }
    .span-8 { grid-column: span 8; }
    .span-12 { grid-column: span 12; }
    .eyebrow {
      margin: 0 0 6px;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--muted);
    }
    .big {
      font-size: 2rem;
      line-height: 1;
      margin: 0;
    }
    .status {
      display: inline-flex;
      gap: 8px;
      align-items: center;
      padding: 8px 12px;
      border-radius: 999px;
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 600;
    }
    .chart {
      width: 100%;
      height: 260px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      font-size: 0.92rem;
    }
    th, td {
      text-align: left;
      padding: 8px 0;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.1em;
    }
    .mono, pre {
      font-family: ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, monospace;
    }
    pre {
      margin: 0;
      max-height: 420px;
      overflow: auto;
      white-space: pre-wrap;
      font-size: 0.84rem;
      line-height: 1.45;
    }
    ul.log {
      margin: 0;
      padding: 0;
      list-style: none;
      display: grid;
      gap: 10px;
      max-height: 420px;
      overflow: auto;
    }
    ul.log li {
      border-left: 3px solid var(--border);
      padding-left: 10px;
    }
    .muted { color: var(--muted); }
    .keep { color: var(--accent); }
    .discard { color: var(--warn); }
    .crash { color: var(--danger); }
    @media (max-width: 980px) {
      .span-4, .span-6, .span-8, .span-12 { grid-column: span 12; }
    }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <div>
        <p class="eyebrow">Autonomous Loop</p>
        <h1 id="title">Autoresearch Dashboard</h1>
      </div>
      <p id="subtitle">Loading state…</p>
    </section>
    <section class="grid">
      <article class="card span-4">
        <p class="eyebrow">Status</p>
        <div id="status" class="status">Waiting</div>
        <p class="muted" id="status-message"></p>
      </article>
      <article class="card span-4">
        <p class="eyebrow">Best Eval</p>
        <p class="big" id="best-primary">n/a</p>
        <p class="muted" id="best-secondary"></p>
      </article>
      <article class="card span-4">
        <p class="eyebrow">Latest Decision</p>
        <p class="big" id="latest-decision">n/a</p>
        <p class="muted" id="latest-description"></p>
      </article>
      <article class="card span-8">
        <p class="eyebrow">Score Trajectory</p>
        <svg id="chart" class="chart" viewBox="0 0 900 260" preserveAspectRatio="none"></svg>
      </article>
      <article class="card span-4">
        <p class="eyebrow">Project</p>
        <p class="mono" id="project-root"></p>
        <p class="muted" id="editable-paths"></p>
        <p class="mono" id="branch-name"></p>
      </article>
      <article class="card span-6">
        <p class="eyebrow">Recent Results</p>
        <table>
          <thead>
            <tr><th>Decision</th><th>Primary</th><th>Secondary</th><th>Description</th></tr>
          </thead>
          <tbody id="results-body"></tbody>
        </table>
      </article>
      <article class="card span-6">
        <p class="eyebrow">Event Stream</p>
        <ul class="log" id="events"></ul>
      </article>
      <article class="card span-12">
        <p class="eyebrow">Live Transcript</p>
        <pre id="transcript"></pre>
      </article>
    </section>
  </main>
  <script>
    const chart = document.getElementById("chart");
    const title = document.getElementById("title");
    const subtitle = document.getElementById("subtitle");
    const status = document.getElementById("status");
    const statusMessage = document.getElementById("status-message");
    const bestPrimary = document.getElementById("best-primary");
    const bestSecondary = document.getElementById("best-secondary");
    const latestDecision = document.getElementById("latest-decision");
    const latestDescription = document.getElementById("latest-description");
    const projectRoot = document.getElementById("project-root");
    const editablePaths = document.getElementById("editable-paths");
    const branchName = document.getElementById("branch-name");
    const resultsBody = document.getElementById("results-body");
    const eventsList = document.getElementById("events");
    const transcript = document.getElementById("transcript");

    function fmt(value) {
      return typeof value === "number" ? value.toFixed(6) : "n/a";
    }

    function renderChart(results) {
      chart.innerHTML = "";
      const points = results
        .filter((record) => record.eval && typeof record.eval.primary === "number")
        .map((record, index) => ({ index, value: record.eval.primary, decision: record.decision }));
      if (points.length === 0) {
        return;
      }
      const width = 900;
      const height = 260;
      const pad = 24;
      const min = Math.min(...points.map((point) => point.value));
      const max = Math.max(...points.map((point) => point.value));
      const span = Math.max(1e-9, max - min);
      const coords = points.map((point) => {
        const x = pad + ((width - pad * 2) * point.index) / Math.max(1, points.length - 1);
        const y = height - pad - ((height - pad * 2) * (point.value - min)) / span;
        return { ...point, x, y };
      });
      const line = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      line.setAttribute("fill", "none");
      line.setAttribute("stroke", "#0f766e");
      line.setAttribute("stroke-width", "3");
      line.setAttribute("points", coords.map((point) => point.x + "," + point.y).join(" "));
      chart.appendChild(line);
      for (const point of coords) {
        const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
        circle.setAttribute("cx", String(point.x));
        circle.setAttribute("cy", String(point.y));
        circle.setAttribute("r", "5");
        circle.setAttribute("fill", point.decision === "keep" || point.decision === "baseline" ? "#0f766e" : point.decision === "discard" ? "#b54708" : "#b42318");
        chart.appendChild(circle);
      }
    }

    function renderResults(results, secondaryLabel) {
      resultsBody.innerHTML = "";
      for (const record of results.slice(-12).reverse()) {
        const tr = document.createElement("tr");
        const primary = record.eval ? fmt(record.eval.primary) : "n/a";
        const secondary = record.eval && record.eval.secondary !== null ? fmt(record.eval.secondary) : "n/a";
        tr.innerHTML = '<td class="' + record.decision + '">' + record.decision + '</td>' +
          '<td>' + primary + '</td>' +
          '<td>' + (secondaryLabel ? secondary : "n/a") + '</td>' +
          '<td>' + (record.description || "(none)") + '</td>';
        resultsBody.appendChild(tr);
      }
    }

    function renderEvents(events) {
      eventsList.innerHTML = "";
      for (const event of events.slice(-20).reverse()) {
        const li = document.createElement("li");
        li.innerHTML = '<div class="mono muted">' + event.timestamp + '</div><div>' + event.type + ': ' + event.message + '</div>';
        eventsList.appendChild(li);
      }
    }

    async function refresh() {
      const response = await fetch("/api/state");
      const payload = await response.json();
      title.textContent = payload.project.name + " Dashboard";
      subtitle.textContent = payload.project.projectRoot;
      status.textContent = payload.state.status + " · iteration " + payload.state.currentIteration;
      statusMessage.textContent = payload.state.message;
      projectRoot.textContent = payload.project.projectRoot;
      editablePaths.textContent = "Editable: " + payload.project.editablePaths.join(", ");
      branchName.textContent = payload.state.currentBranch || "(no branch)";
      if (payload.best && payload.best.eval) {
        bestPrimary.textContent = payload.project.primaryLabel + ": " + fmt(payload.best.eval.primary);
        bestSecondary.textContent = payload.project.secondaryLabel && payload.best.eval.secondary !== null
          ? payload.project.secondaryLabel + ": " + fmt(payload.best.eval.secondary)
          : "";
      } else {
        bestPrimary.textContent = "n/a";
        bestSecondary.textContent = "";
      }
      if (payload.latest) {
        latestDecision.textContent = payload.latest.decision;
        latestDecision.className = "big " + payload.latest.decision;
        latestDescription.textContent = payload.latest.description || payload.latest.reason || "";
      }
      renderChart(payload.results);
      renderResults(payload.results, payload.project.secondaryLabel);
      renderEvents(payload.events);
      transcript.textContent = payload.transcriptTail || "";
    }

    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>`;
}

export async function runResearchDashboardCli(project: ResearchProject, argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const paths = resolveResearchPaths(project);
  const server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (requestUrl.pathname === "/api/state") {
      const payload = readDashboardPayload(project, paths);
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(payload));
      return;
    }
    if (requestUrl.pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(htmlPage());
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
  });
  await new Promise<void>((resolve) => {
    server.listen(options.port, options.host, () => resolve());
  });
  console.log(`dashboard: http://${options.host}:${options.port}`);
}
