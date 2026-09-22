import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelConfiguration } from "../src/agent/model-config.js";
import { TriageDashboardServer } from "../src/dashboard/server.js";
import { IncidentRecord } from "../src/pipeline/types.js";

const servers: TriageDashboardServer[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...servers.splice(0).map((server) => server.close()),
    ...directories
      .splice(0)
      .map((path) => rm(path, { recursive: true })),
  ]);
});

function record(state: IncidentRecord["state"]): IncidentRecord {
  return {
    input: {
      id: "incident-demo",
      trigger: "manual",
      report: "demo incident",
      cwd: process.cwd(),
    },
    state,
    totalTokens: 42,
    requestIds: ["request-1"],
    events: [],
  };
}

describe("TriageDashboardServer", () => {
  it("serves the dark dashboard and current incident state", async () => {
    const server = new TriageDashboardServer({ port: 0 });
    servers.push(server);
    const url = await server.start();
    server.publishState(record("investigating"));

    const [page, state] = await Promise.all([
      fetch(url).then((response) => response.text()),
      fetch(`${url}/api/state`).then((response) => response.json()),
    ]);

    expect(page).toContain("<title>Incident triage</title>");
    expect(page).toContain("<h1>Incident Triage</h1>");
    expect(page).toContain(
      '"Incident " + record.input.id',
    );
    expect(page).toContain("Resume polling");
    expect(page).toContain("color-scheme: dark");
    expect(page).toContain('id="agent-event"');
    expect(page).toContain('id="models-screen"');
    expect(page).toContain("Stage models");
    expect(page).not.toContain('id="events"');
    expect(page).not.toContain("renderEvents");
    expect(page).not.toContain("record?.events");
    expect(state.record).toMatchObject({
      state: "investigating",
      input: { id: "incident-demo" },
    });
  });

  it("serves and updates validated stage model settings", async () => {
      const directory = await mkdtemp(join(tmpdir(), "dashboard-models-"));
      directories.push(directory);
      const models = new ModelConfiguration({
        env: {
          COPILOT_MODELS: "gpt-5,gpt-5.4",
          COPILOT_MODEL: "gpt-5",
          AZURE_FOUNDRY_BASE_URL:
            "https://octodemo-models.services.ai.azure.com/openai/v1/chat/completions",
          AZURE_FOUNDRY_API_KEY: "secret",
          AZURE_FOUNDRY_MODELS: "gpt-5.2-codex",
        },
        path: join(directory, "models.json"),
      });
      const server = new TriageDashboardServer({ port: 0, models });
      servers.push(server);
      const url = await server.start();

      const catalog = await fetch(`${url}/api/models`).then((response) =>
        response.json(),
      );
      expect(catalog.settings.assessment).toEqual({
        provider: "copilot",
        model: "gpt-5",
      });
      expect(catalog.providers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "azure-foundry",
            configured: true,
            models: [
              {
                id: "gpt-5.2-codex",
                name: "gpt-5.2-codex",
              },
            ],
          }),
        ]),
      );

      const response = await fetch(`${url}/api/models`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          assessment: { provider: "copilot", model: "gpt-5.4" },
          investigation: {
            provider: "azure-foundry",
            model: "gpt-5.2-codex",
          },
          action: {
            provider: "azure-foundry",
            model: "gpt-5.2-codex",
          },
        }),
      });

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        settings: {
          assessment: { provider: "copilot", model: "gpt-5.4" },
          action: {
            provider: "azure-foundry",
            model: "gpt-5.2-codex",
          },
        },
    });
  });

  it("streams state snapshots to connected browsers", async () => {
    const server = new TriageDashboardServer({ port: 0 });
    servers.push(server);
    const url = await server.start();
    const response = await fetch(`${url}/events`);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    try {
      server.publishState(record("acting"));
      let text = "";
      while (!text.includes('"kind":"snapshot"')) {
        const chunk = await reader!.read();
        if (chunk.done) break;
        text += new TextDecoder().decode(chunk.value);
      }

      expect(text).toContain('"kind":"snapshot"');
      expect(text).toContain('"state":"acting"');
    } finally {
      await reader!.cancel();
    }
  });

  it("clears a terminal incident without stopping polling", async () => {
    const server = new TriageDashboardServer({ port: 0 });
    servers.push(server);
    const url = await server.start();
    server.publishState(record("verified_fixed"));

    await fetch(`${url}/api/reset`, { method: "POST" }).then((response) => {
      expect(response.status).toBe(204);
    });

    await expect(
      fetch(`${url}/api/state`).then((response) => response.json()),
    ).resolves.toEqual({ record: null });
  });
});
