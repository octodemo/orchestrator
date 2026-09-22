import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { CopilotAgentRunner } from "./copilot-runner.js";
import { ModelConfiguration } from "./model-config.js";
import { AgentRunner } from "./runner.js";
import { StubAgentRunner, StubScriptFactory } from "./stub-runner.js";

export interface MakeAgentRunnerOptions {
  env?: NodeJS.ProcessEnv;
  envFile?: string | false;
  models?: ModelConfiguration;
  stubScripts: StubScriptFactory;
}

export function makeAgentRunner(options: MakeAgentRunnerOptions): AgentRunner {
  if (!options.env) {
    loadOptionalEnvironmentFile(options.envFile);
  }
  const env = options.env ?? process.env;
  const kind = env.AGENT_RUNNER ?? "stub";
  if (kind === "stub") return new StubAgentRunner(options.stubScripts);
  if (kind !== "copilot") {
    throw new Error(`Unsupported AGENT_RUNNER value: ${kind}`);
  }

  return new CopilotAgentRunner({
    models:
      options.models ??
      makeModelConfiguration(env, process.cwd()),
  });
}

export function makeModelConfiguration(
  env: NodeJS.ProcessEnv,
  cwd: string,
): ModelConfiguration {
  return new ModelConfiguration({
    env,
    path: resolve(
      cwd,
      ".incident-orchestrator",
      "model-settings.json",
    ),
  });
}

function loadOptionalEnvironmentFile(envFile: string | false | undefined): void {
  if (envFile === false) return;
  const path = resolve(envFile ?? ".env");
  if (existsSync(path)) loadEnvFile(path);
}

export * from "./runner.js";
export * from "./stub-runner.js";
export * from "./copilot-runner.js";
export * from "./model-config.js";
