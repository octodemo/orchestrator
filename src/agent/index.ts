import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { resolve } from "node:path";
import { CopilotAgentRunner } from "./copilot-runner.js";
import { AgentRunner } from "./runner.js";
import { StubAgentRunner, StubScriptFactory } from "./stub-runner.js";

export interface MakeAgentRunnerOptions {
  env?: NodeJS.ProcessEnv;
  envFile?: string | false;
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

  const logLevel = copilotLogLevel(env.COPILOT_LOG_LEVEL);
  return new CopilotAgentRunner({
    model: env.COPILOT_MODEL ?? "gpt-5",
    ...(env.COPILOT_GITHUB_TOKEN
      ? { gitHubToken: env.COPILOT_GITHUB_TOKEN }
      : {}),
    ...(logLevel ? { logLevel } : {}),
  });
}

function loadOptionalEnvironmentFile(envFile: string | false | undefined): void {
  if (envFile === false) return;
  const path = resolve(envFile ?? ".env");
  if (existsSync(path)) loadEnvFile(path);
}

function copilotLogLevel(
  value: string | undefined,
): "none" | "error" | "warning" | "info" | "debug" | "all" | undefined {
  if (value === undefined) return undefined;
  if (
    value === "none" ||
    value === "error" ||
    value === "warning" ||
    value === "info" ||
    value === "debug" ||
    value === "all"
  ) {
    return value;
  }
  throw new Error(
    "COPILOT_LOG_LEVEL must be one of none, error, warning, info, debug, or all",
  );
}

export * from "./runner.js";
export * from "./stub-runner.js";
export * from "./copilot-runner.js";
