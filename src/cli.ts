#!/usr/bin/env node
import { resolve } from "node:path";
import {
  makeAgentRunner,
  makeModelConfiguration,
} from "./agent/index.js";
import {
  dashboardConfig,
  optionalNumber,
  parseArgs,
  publishingConfig,
  required,
} from "./config/cli-config.js";
import { TriageDashboardServer } from "./dashboard/server.js";
import { incidentScripts } from "./fixtures/scripts.js";
import { triageIncident } from "./pipeline/orchestrator.js";
import { IncidentInput, Trigger } from "./pipeline/types.js";
import { GitHubIncidentPublisher } from "./publisher/incident-publisher.js";
import { defaultStore } from "./store/json-store.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cwd = resolve(required(args, "cwd"));
  const trigger = required(args, "trigger");
  if (trigger !== "manual" && trigger !== "automated") {
    throw new Error("--trigger must be manual or automated");
  }

  const input: IncidentInput = {
    id: required(args, "id"),
    trigger: trigger as Trigger,
    report: required(args, "report"),
    cwd,
  };
  const models = makeModelConfiguration(process.env, process.cwd());
  const runner = makeAgentRunner({
    models,
    stubScripts: incidentScripts,
  });
  const store = defaultStore(cwd);
  const publication = publishingConfig(args, process.env);
  const dashboardOptions = dashboardConfig(args, process.env);
  const dashboard = dashboardOptions.enabled
    ? new TriageDashboardServer({
        port: dashboardOptions.port,
        models,
      })
    : undefined;
  if (dashboard) {
    const url = await dashboard.start();
    process.stderr.write(`Triage dashboard: ${url}\n`);
  }
  const record = await triageIncident(input, runner, {
    maxTokensPerIncident: optionalNumber(args, "max-tokens") ?? 2_000_000,
    preFixRef: required(args, "pre-fix-ref"),
    onEvent: (incidentId, event) => {
      dashboard?.publishAgentEvent(incidentId, event);
      process.stderr.write(
        `${JSON.stringify({ incidentId, event })}\n`,
      );
    },
    onStateChange: (next) => {
      dashboard?.publishState(next);
      process.stderr.write(
        `${JSON.stringify({ incidentId: next.input.id, state: next.state })}\n`,
      );
    },
    ...(publication.enabled
      ? {
          publisher: new GitHubIncidentPublisher({
            baseBranch: publication.baseBranch,
            remote: publication.remote,
            ...(publication.repository
              ? { repository: publication.repository }
              : {}),
          }),
        }
      : {}),
  });
  await store.put(record);
  dashboard?.publishState(record);
  process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  if (dashboard) {
    process.stderr.write(
      "Dashboard remains available until this process is stopped.\n",
    );
  }
  if (
    !["verified_fixed", "escalated"].includes(record.state) ||
    record.publication?.status === "failed"
  ) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
