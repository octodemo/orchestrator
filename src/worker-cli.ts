#!/usr/bin/env node
import {
  makeAgentRunner,
  makeModelConfiguration,
} from "./agent/index.js";
import {
  dashboardConfig,
  optionalNumber,
  parseArgs,
  publishingConfig,
  queueWorkerConfig,
  workspaceConfig,
} from "./config/cli-config.js";
import { TriageDashboardServer } from "./dashboard/server.js";
import { incidentScripts } from "./fixtures/scripts.js";
import { HttpIncidentQueueClient } from "./queue/client.js";
import { IncidentQueueWorker } from "./queue/worker.js";
import { GitHubIncidentPublisher } from "./publisher/incident-publisher.js";
import { defaultStore } from "./store/json-store.js";
import {
  FixedIncidentWorkspaceManager,
  GitIncidentWorkspaceManager,
} from "./workspace/manager.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const models = makeModelConfiguration(process.env, process.cwd());
  const runner = makeAgentRunner({
    models,
    stubScripts: incidentScripts,
  });
  const queueOptions = queueWorkerConfig(args, process.env);
  const publication = publishingConfig(args, process.env);
  const workspaceOptions = workspaceConfig(
    args,
    process.env,
    process.cwd(),
    `${publication.remote}/${publication.baseBranch}`,
  );
  const workspaceManager =
    workspaceOptions.mode === "fixed"
      ? new FixedIncidentWorkspaceManager(
          workspaceOptions.cwd,
          workspaceOptions.preFixRef,
        )
      : new GitIncidentWorkspaceManager({
          repoRoot: workspaceOptions.repoRoot,
          workspaceRoot: workspaceOptions.workspaceRoot,
          targetRef: workspaceOptions.targetRef,
          remote: publication.remote,
        });
  const dashboardOptions = dashboardConfig(args, process.env);
  const dashboard = dashboardOptions.enabled
    ? new TriageDashboardServer({
        port: dashboardOptions.port,
        models,
      })
    : undefined;
  const abortController = new AbortController();
  const stop = (signal: NodeJS.Signals) => {
    process.stderr.write(
      `Received ${signal}; stopping after the active incident.\n`,
    );
    abortController.abort();
  };
  const onSigint = () => stop("SIGINT");
  const onSigterm = () => stop("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    if (dashboard) {
      const url = await dashboard.start();
      process.stderr.write(`Triage dashboard: ${url}\n`);
    }

    const worker = new IncidentQueueWorker({
      client: new HttpIncidentQueueClient({
        baseUrl: queueOptions.baseUrl,
      }),
      workerId: queueOptions.workerId,
      workspaceManager,
      pollIntervalMs: queueOptions.pollIntervalMs,
      leaseSeconds: queueOptions.leaseSeconds,
      heartbeatIntervalMs: queueOptions.heartbeatIntervalMs,
      runner,
      store: defaultStore(process.cwd()),
      orchestratorConfig: {
        maxTokensPerIncident:
          optionalNumber(args, "max-tokens") ?? 2_000_000,
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
      },
      onEvent: (incidentId, event) => {
        dashboard?.publishAgentEvent(incidentId, event);
        process.stderr.write(`${JSON.stringify({ incidentId, event })}\n`);
      },
      onStateChange: (record) => {
        dashboard?.publishState(record);
        process.stderr.write(
          `${JSON.stringify({
            incidentId: record.input.id,
            state: record.state,
          })}\n`,
        );
      },
      onError: (error) => {
        process.stderr.write(`Incident queue error: ${error.message}\n`);
      },
      onWorkspaceRelease: (workspace, result) => {
        process.stderr.write(
          result.removed
            ? `Removed incident workspace ${workspace.cwd}.\n`
            : `${result.reason ?? `Preserved incident workspace ${workspace.cwd}.`}\n`,
        );
      },
    });

    process.stderr.write(
      `Polling ${queueOptions.baseUrl} as ${queueOptions.workerId}.\n`,
    );
    await worker.run(abortController.signal);
  } finally {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await dashboard?.close();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
