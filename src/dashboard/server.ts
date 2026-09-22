import {
  createServer,
  IncomingMessage,
  Server,
  ServerResponse,
} from "node:http";
import { AddressInfo } from "node:net";
import { RunEvent } from "../agent/runner.js";
import {
  ModelConfiguration,
  StageModelSettings,
} from "../agent/model-config.js";
import { IncidentRecord } from "../pipeline/types.js";

export interface DashboardServerOptions {
  port: number;
  host?: string;
  models?: ModelConfiguration;
}

type DashboardMessage =
  | { kind: "snapshot"; record: IncidentRecord | null }
  | {
      kind: "agent_event";
      incidentId: string;
      event: RunEvent;
      at: string;
    };

export class TriageDashboardServer {
  private readonly clients = new Set<ServerResponse>();
  private server: Server | undefined;
  private record: IncidentRecord | undefined;
  private url: string | undefined;

  constructor(private readonly options: DashboardServerOptions) {}

  async start(): Promise<string> {
    if (this.server) {
      if (!this.url) throw new Error("Dashboard server has no URL");
      return this.url;
    }

    const server = createServer((request, response) => {
      const requestUrl = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );

      if (request.method === "GET" && requestUrl.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(dashboardHtml);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/state") {
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
        });
        response.end(JSON.stringify({ record: this.record ?? null }));
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/api/models") {
        void this.sendModels(response);
        return;
      }

      if (request.method === "POST" && requestUrl.pathname === "/api/models") {
        void this.updateModels(request, response);
        return;
      }

      if (request.method === "GET" && requestUrl.pathname === "/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
        });
        response.write("retry: 1000\n\n");
        this.clients.add(response);
        if (this.record) {
          writeSse(response, { kind: "snapshot", record: this.record });
        }
        request.on("close", () => this.clients.delete(response));
        return;
      }

      if (
        request.method === "POST" &&
        requestUrl.pathname === "/api/reset"
      ) {
        this.record = undefined;
        this.broadcast({ kind: "snapshot", record: null });
        response.writeHead(204);
        response.end();
        return;
      }

      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
    });

    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        this.server = undefined;
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.options.port, this.options.host ?? "127.0.0.1");
    });

    const address = server.address();
    if (!address || typeof address === "string") {
      await this.close();
      throw new Error("Dashboard server did not expose a TCP address");
    }
    this.url = formatUrl(address);
    return this.url;
  }

  publishState(record: IncidentRecord): void {
    this.record = record;
    this.broadcast({ kind: "snapshot", record });
  }

  publishAgentEvent(
    incidentId: string,
    event: RunEvent,
    at = new Date().toISOString(),
  ): void {
    this.broadcast({ kind: "agent_event", incidentId, event, at });
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.end();
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    this.url = undefined;
    if (!server) return;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  private broadcast(message: DashboardMessage): void {
    for (const client of this.clients) writeSse(client, message);
  }

  private async sendModels(response: ServerResponse): Promise<void> {
    if (!this.options.models) {
      sendJson(response, 404, { error: "Model configuration is unavailable" });
      return;
    }
    try {
      const [settings, providers] = await Promise.all([
        this.options.models.getSettings(),
        this.options.models.listProviders(),
      ]);
      sendJson(response, 200, { settings, providers });
    } catch (error) {
      sendJson(response, 500, { error: formatError(error) });
    }
  }

  private async updateModels(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!this.options.models) {
      sendJson(response, 404, { error: "Model configuration is unavailable" });
      return;
    }
    try {
      const settings = (await readJson(request)) as StageModelSettings;
      const saved = await this.options.models.updateSettings(settings);
      sendJson(response, 200, { settings: saved });
    } catch (error) {
      sendJson(response, 400, { error: formatError(error) });
    }
  }
}

function writeSse(response: ServerResponse, message: DashboardMessage): void {
  response.write(`data: ${JSON.stringify(message)}\n\n`);
}

function formatUrl(address: AddressInfo): string {
  const host = address.address === "::" ? "localhost" : address.address;
  return `http://${host}:${address.port}`;
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  let body = "";
  for await (const chunk of request) {
    body += Buffer.from(chunk).toString("utf8");
    if (body.length > 100_000) throw new Error("Request body is too large");
  }
  return JSON.parse(body);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const dashboardHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Incident triage</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #090b10;
      --panel: #11151d;
      --panel-raised: #171c26;
      --border: #252c38;
      --muted: #8b95a7;
      --text: #f2f5f9;
      --accent: #7c5cff;
      --accent-soft: rgba(124, 92, 255, 0.16);
      --green: #42d392;
      --yellow: #f6c85f;
      --red: #ff6b7a;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      background:
        radial-gradient(circle at 12% 0%, rgba(124, 92, 255, 0.14), transparent 32rem),
        var(--bg);
      color: var(--text);
      font: 14px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    main {
      width: min(1120px, calc(100% - 32px));
      margin: 0 auto;
      padding: 40px 0 64px;
    }

    header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
      margin-bottom: 28px;
    }

    .eyebrow {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    h1 {
      margin: 7px 0 6px;
      font-size: clamp(26px, 4vw, 38px);
      letter-spacing: -0.04em;
      line-height: 1.1;
    }

    #report {
      max-width: 720px;
      margin: 0;
      color: var(--muted);
    }

    .connection {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 7px 11px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: rgba(17, 21, 29, 0.8);
      color: var(--muted);
      font-size: 12px;
      white-space: nowrap;
    }

    .connection-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--yellow);
      box-shadow: 0 0 12px currentColor;
    }

    .connection.live .connection-dot { background: var(--green); }
    .connection.offline .connection-dot { background: var(--red); }

    .reset-button {
      display: none;
      align-items: center;
      justify-content: center;
      min-height: 38px;
      padding: 0 14px;
      border: 1px solid rgba(124, 92, 255, 0.55);
      border-radius: 9px;
      background: var(--accent-soft);
      color: #ded8ff;
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 750;
    }

    .reset-button.visible { display: inline-flex; }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .nav-button, .save-button {
      min-height: 38px;
      padding: 0 14px;
      border: 1px solid var(--border);
      border-radius: 9px;
      background: rgba(17, 21, 29, 0.8);
      color: var(--text);
      cursor: pointer;
      font: inherit;
      font-size: 12px;
      font-weight: 750;
    }

    .nav-button.active, .save-button {
      border-color: rgba(124, 92, 255, 0.55);
      background: var(--accent-soft);
      color: #ded8ff;
    }

    .screen[hidden] { display: none; }

    .panel {
      border: 1px solid var(--border);
      border-radius: 16px;
      background: linear-gradient(180deg, rgba(23, 28, 38, 0.88), rgba(17, 21, 29, 0.96));
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.22);
    }

    .progress-panel { padding: 24px; }

    .panel-heading {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 22px;
    }

    .panel-heading h2 {
      margin: 0;
      font-size: 15px;
      letter-spacing: -0.01em;
    }

    .status {
      padding: 5px 10px;
      border: 1px solid rgba(124, 92, 255, 0.4);
      border-radius: 999px;
      background: var(--accent-soft);
      color: #cfc4ff;
      font-size: 12px;
      font-weight: 700;
      text-transform: capitalize;
    }

    .steps {
      display: grid;
      grid-template-columns: repeat(6, 1fr);
      gap: 0;
    }

    .step {
      position: relative;
      min-width: 0;
      color: var(--muted);
      text-align: center;
    }

    .step:not(:last-child)::after {
      content: "";
      position: absolute;
      top: 15px;
      left: calc(50% + 18px);
      right: calc(-50% + 18px);
      height: 2px;
      background: var(--border);
    }

    .step.complete:not(:last-child)::after { background: var(--accent); }

    .step-dot {
      position: relative;
      z-index: 1;
      display: grid;
      width: 32px;
      height: 32px;
      margin: 0 auto 10px;
      place-items: center;
      border: 2px solid var(--border);
      border-radius: 50%;
      background: var(--panel);
      font-size: 11px;
      font-weight: 800;
    }

    .step.complete .step-dot {
      border-color: var(--accent);
      background: var(--accent);
      color: white;
    }

    .step.current { color: var(--text); }

    .step.current .step-dot {
      border-color: var(--accent);
      box-shadow: 0 0 0 5px var(--accent-soft);
      color: white;
    }

    .step-label {
      overflow: hidden;
      font-size: 12px;
      font-weight: 650;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .grid {
      display: grid;
      grid-template-columns: minmax(0, 1.5fr) minmax(280px, 0.75fr);
      gap: 16px;
      margin-top: 16px;
    }

    .activity, .summary { min-height: 260px; }

    .activity {
      display: flex;
      flex-direction: column;
      padding: 22px;
    }

    .agent-now {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      margin-bottom: 18px;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(9, 11, 16, 0.45);
    }

    .pulse {
      flex: 0 0 auto;
      width: 10px;
      height: 10px;
      margin-top: 5px;
      border-radius: 50%;
      background: var(--accent);
      box-shadow: 0 0 0 0 rgba(124, 92, 255, 0.5);
      animation: pulse 1.8s infinite;
    }

    @keyframes pulse {
      70% { box-shadow: 0 0 0 8px rgba(124, 92, 255, 0); }
      100% { box-shadow: 0 0 0 0 rgba(124, 92, 255, 0); }
    }

    #agent-event {
      margin-top: 2px;
      color: var(--muted);
      overflow-wrap: anywhere;
    }

    .summary { padding: 22px; }

    .metrics {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
      margin-bottom: 18px;
    }

    .metric {
      padding: 13px;
      border: 1px solid var(--border);
      border-radius: 11px;
      background: rgba(9, 11, 16, 0.38);
    }

    .metric-label {
      color: var(--muted);
      font-size: 11px;
      text-transform: uppercase;
    }

    .metric-value {
      display: block;
      margin-top: 4px;
      font-size: 15px;
      font-weight: 750;
      text-transform: capitalize;
    }

    .detail {
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }

    .detail-label {
      margin-bottom: 5px;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .detail p {
      margin: 0;
      overflow-wrap: anywhere;
    }

    .empty {
      display: grid;
      min-height: 220px;
      place-items: center;
      color: var(--muted);
      text-align: center;
    }

    .models-panel { padding: 24px; }

    .model-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }

    .model-card {
      padding: 18px;
      border: 1px solid var(--border);
      border-radius: 12px;
      background: rgba(9, 11, 16, 0.38);
    }

    .model-card h3 {
      margin: 0 0 5px;
      font-size: 15px;
      text-transform: capitalize;
    }

    .model-card p, .model-note, #model-status {
      color: var(--muted);
    }

    .field {
      display: grid;
      gap: 6px;
      margin-top: 15px;
    }

    .field label {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    select {
      width: 100%;
      min-height: 40px;
      padding: 0 10px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      color: var(--text);
      font: inherit;
    }

    .model-footer {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-top: 18px;
    }

    #model-status.error { color: var(--red); }
    #model-status.success { color: var(--green); }

    @media (max-width: 760px) {
      main { width: min(100% - 20px, 1120px); padding-top: 24px; }
      header { flex-direction: column; }
      .grid { grid-template-columns: 1fr; }
      .model-grid { grid-template-columns: 1fr; }
      .progress-panel { overflow-x: auto; }
      .steps { min-width: 620px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <div class="eyebrow">Agent operations</div>
        <h1>Incident Triage</h1>
        <p id="incident-title">Waiting for an incident.</p>
      </div>
      <div class="header-actions">
        <button id="triage-nav" class="nav-button active" type="button">Triage</button>
        <button id="models-nav" class="nav-button" type="button">Models</button>
        <div id="connection" class="connection">
          <span class="connection-dot"></span>
          <span id="connection-label">Connecting</span>
        </div>
        <button id="reset-dashboard" class="reset-button" type="button">
          Resume polling
        </button>
      </div>
    </header>

    <div id="triage-screen" class="screen">
      <section class="panel progress-panel">
        <div class="panel-heading">
          <h2>Triage progress</h2>
          <span id="status" class="status">waiting</span>
        </div>
        <div id="steps" class="steps"></div>
      </section>

      <div class="grid">
        <section class="panel activity">
          <div class="panel-heading">
            <h2>Agent activity</h2>
          </div>
          <div class="agent-now">
            <span class="pulse"></span>
            <div>
              <strong id="agent-heading">Waiting for agent</strong>
              <div id="agent-event">No activity received yet.</div>
            </div>
          </div>
        </section>

        <aside class="panel summary">
          <div class="panel-heading">
            <h2>Incident summary</h2>
          </div>
          <div class="metrics">
            <div class="metric">
              <span class="metric-label">Severity</span>
              <span id="severity" class="metric-value">—</span>
            </div>
            <div class="metric">
              <span class="metric-label">Autonomy</span>
              <span id="autonomy" class="metric-value">—</span>
            </div>
            <div class="metric">
              <span class="metric-label">Tokens</span>
              <span id="tokens" class="metric-value">0</span>
            </div>
            <div class="metric">
              <span class="metric-label">Requests</span>
              <span id="requests" class="metric-value">0</span>
            </div>
          </div>
          <div class="detail">
            <div class="detail-label">Current finding</div>
            <p id="finding">Assessment has not started.</p>
          </div>
        </aside>
      </div>
    </div>

    <div id="models-screen" class="screen" hidden>
      <section class="panel models-panel">
        <div class="panel-heading">
          <div>
            <h2>Stage models</h2>
            <p class="model-note">Selections are validated now and again immediately before each stage runs.</p>
          </div>
        </div>
        <div id="model-grid" class="model-grid"></div>
        <div class="model-footer">
          <span id="model-status">Loading provider models...</span>
          <button id="save-models" class="save-button" type="button">Save models</button>
        </div>
      </section>
    </div>
  </main>

  <script>
    const stepDefinitions = [
      ["received", "Received"],
      ["assessing", "Assess"],
      ["investigating", "Investigate"],
      ["acting", "Act"],
      ["awaiting_verification", "Verify"],
      ["complete", "Complete"],
    ];
    const terminalStates = new Set([
      "verified_fixed",
      "escalated",
      "needs_human",
      "failed",
      "budget_exceeded",
    ]);
    const stateIndexes = {
      received: 0,
      assessing: 1,
      investigating: 2,
      acting: 3,
      awaiting_verification: 4,
      verified_fixed: 5,
      escalated: 5,
      needs_human: 5,
      failed: 5,
      budget_exceeded: 5,
    };
    const elements = Object.fromEntries(
      [
        "incident-title", "connection", "connection-label", "status",
        "steps", "agent-heading", "agent-event", "severity",
        "autonomy", "tokens", "requests", "finding", "reset-dashboard",
        "triage-nav", "models-nav", "triage-screen", "models-screen",
        "model-grid", "model-status", "save-models",
      ].map((id) => [id, document.getElementById(id)]),
    );

    let currentRecord = null;
    let modelCatalog = null;

    function humanize(value) {
      return String(value ?? "—").replaceAll("_", " ");
    }

    function setConnection(state, label) {
      elements.connection.className = "connection " + state;
      elements["connection-label"].textContent = label;
    }

    function renderSteps(state) {
      const currentIndex = stateIndexes[state] ?? 0;
      elements.steps.replaceChildren(
        ...stepDefinitions.map(([key, label], index) => {
          const step = document.createElement("div");
          const complete = index < currentIndex || (index === 5 && terminalStates.has(state));
          step.className = "step" +
            (complete ? " complete" : "") +
            (index === currentIndex && !complete ? " current" : "");

          const dot = document.createElement("div");
          dot.className = "step-dot";
          dot.textContent = complete ? "✓" : String(index + 1);

          const text = document.createElement("div");
          text.className = "step-label";
          text.textContent = label;
          step.append(dot, text);
          return step;
        }),
      );
    }

    function findingFor(record) {
      if (record.verification) return record.verification.detail;
      if (record.claim) return record.claim.summary;
      if (record.hypothesis) return record.hypothesis.rootCause;
      if (record.assessment) return record.assessment.rationale;
      return "Assessment has not started.";
    }

    function eventDescription(event) {
      if (!event) return "No activity received yet.";
      if (event.type === "tool_call") {
        return event.name + " · " + event.status;
      }
      return event.text ?? event.status ?? event.type;
    }

    function render(record) {
      if (!record) {
        currentRecord = null;
        elements["incident-title"].textContent = "Waiting for an incident.";
        elements.status.textContent = "polling";
        elements.severity.textContent = "—";
        elements.autonomy.textContent = "—";
        elements.tokens.textContent = "0";
        elements.requests.textContent = "0";
        elements.finding.textContent = "Assessment has not started.";
        elements["agent-heading"].textContent = "Waiting for agent";
        elements["agent-event"].textContent = "No activity received yet.";
        elements["reset-dashboard"].classList.remove("visible");
        renderSteps("received");
        return;
      }
      currentRecord = record;
      elements["incident-title"].textContent = "Incident " + record.input.id;
      elements.status.textContent = humanize(record.state);
      elements.severity.textContent = humanize(record.assessment?.severity);
      elements.autonomy.textContent = humanize(record.assessment?.autonomy);
      elements.tokens.textContent = Number(record.totalTokens ?? 0).toLocaleString();
      elements.requests.textContent = String(record.requestIds?.length ?? 0);
      elements.finding.textContent = findingFor(record);
      elements["agent-heading"].textContent = terminalStates.has(record.state)
        ? "Triage complete"
        : "Agent is " + humanize(record.state);
      elements["agent-event"].textContent = terminalStates.has(record.state)
        ? "No active agent operation."
        : "Waiting for live activity.";
      elements["reset-dashboard"].classList.toggle(
        "visible",
        terminalStates.has(record.state),
      );
      renderSteps(record.state);
    }

    elements["reset-dashboard"].addEventListener("click", async () => {
      elements["reset-dashboard"].disabled = true;
      try {
        const response = await fetch("/api/reset", { method: "POST" });
        if (!response.ok) throw new Error("Unable to reset dashboard");
        render(null);
      } finally {
        elements["reset-dashboard"].disabled = false;
      }
    });

    function showScreen(name) {
      const models = name === "models";
      elements["triage-screen"].hidden = models;
      elements["models-screen"].hidden = !models;
      elements["triage-nav"].classList.toggle("active", !models);
      elements["models-nav"].classList.toggle("active", models);
      if (models && !modelCatalog) loadModels();
    }

    elements["triage-nav"].addEventListener("click", () => showScreen("triage"));
    elements["models-nav"].addEventListener("click", () => showScreen("models"));

    function modelsFor(provider) {
      return modelCatalog.providers.find((item) => item.id === provider)?.models ?? [];
    }

    function populateModels(select, provider, selected) {
      const models = modelsFor(provider);
      select.replaceChildren(...models.map((model) => {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.name;
        option.selected = model.id === selected;
        return option;
      }));
    }

    function renderModelSettings() {
      const descriptions = {
        assessment: "Classifies severity and determines the autonomy ceiling.",
        investigation: "Gathers evidence and develops the root-cause hypothesis.",
        action: "Writes the reproduction test and implements the fix.",
      };
      const providers = modelCatalog.providers.filter(
        (provider) => provider.configured && provider.models.length > 0,
      );
      elements["model-grid"].replaceChildren(
        ...Object.entries(modelCatalog.settings).map(([stage, selection]) => {
          const card = document.createElement("div");
          card.className = "model-card";
          card.dataset.stage = stage;
          card.innerHTML =
            "<h3>" + stage + "</h3><p>" + descriptions[stage] + "</p>";

          const providerField = document.createElement("div");
          providerField.className = "field";
          providerField.innerHTML = "<label>Provider</label>";
          const providerSelect = document.createElement("select");
          providerSelect.className = "provider-select";
          providerSelect.replaceChildren(...providers.map((provider) => {
            const option = document.createElement("option");
            option.value = provider.id;
            option.textContent = provider.name;
            option.selected = provider.id === selection.provider;
            return option;
          }));
          providerField.append(providerSelect);

          const modelField = document.createElement("div");
          modelField.className = "field";
          modelField.innerHTML = "<label>Model</label>";
          const modelSelect = document.createElement("select");
          modelSelect.className = "model-select";
          populateModels(modelSelect, providerSelect.value, selection.model);
          providerSelect.addEventListener("change", () => {
            populateModels(modelSelect, providerSelect.value);
          });
          modelField.append(modelSelect);
          card.append(providerField, modelField);
          return card;
        }),
      );
      const unavailable = modelCatalog.providers
        .filter((provider) => provider.error)
        .map((provider) => provider.name + ": " + provider.error);
      elements["model-status"].textContent = unavailable.length
        ? "Unavailable providers: " + unavailable.join(" | ")
        : "All configured providers are available.";
      elements["model-status"].className = unavailable.length ? "error" : "";
    }

    async function loadModels() {
      elements["model-status"].textContent = "Loading provider models...";
      elements["model-status"].className = "";
      try {
        const response = await fetch("/api/models");
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Unable to load models");
        modelCatalog = body;
        renderModelSettings();
      } catch (error) {
        elements["model-status"].textContent = error.message;
        elements["model-status"].className = "error";
      }
    }

    elements["save-models"].addEventListener("click", async () => {
      elements["save-models"].disabled = true;
      elements["model-status"].textContent = "Validating and saving...";
      elements["model-status"].className = "";
      try {
        const settings = Object.fromEntries(
          [...elements["model-grid"].querySelectorAll(".model-card")].map((card) => [
            card.dataset.stage,
            {
              provider: card.querySelector(".provider-select").value,
              model: card.querySelector(".model-select").value,
            },
          ]),
        );
        const response = await fetch("/api/models", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(settings),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Unable to save models");
        modelCatalog.settings = body.settings;
        elements["model-status"].textContent = "Model settings saved.";
        elements["model-status"].className = "success";
      } catch (error) {
        elements["model-status"].textContent = error.message;
        elements["model-status"].className = "error";
      } finally {
        elements["save-models"].disabled = false;
      }
    });

    fetch("/api/state")
      .then((response) => response.json())
      .then(({ record }) => render(record))
      .catch(() => {});

    const stream = new EventSource("/events");
    stream.onopen = () => setConnection("live", "Live");
    stream.onerror = () => setConnection("offline", "Reconnecting");
    stream.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.kind === "snapshot") {
        render(message.record);
        return;
      }
      if (message.kind === "agent_event") {
        const detail = eventDescription(message.event);
        elements["agent-heading"].textContent = "Agent is working";
        elements["agent-event"].textContent = detail;
      }
    };

    renderSteps("received");
  </script>
</body>
</html>`;
