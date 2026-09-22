import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  CopilotClient,
  type CopilotClientOptions,
  type ProviderConfig,
} from "@github/copilot-sdk";

export const agentStages = [
  "assessment",
  "investigation",
  "action",
] as const;

export type AgentStage = (typeof agentStages)[number];
export type ModelProvider = "copilot" | "azure-foundry";

export interface StageModelSelection {
  provider: ModelProvider;
  model: string;
}

export type StageModelSettings = Record<AgentStage, StageModelSelection>;

export interface AvailableModel {
  id: string;
  name: string;
}

export interface ProviderModels {
  id: ModelProvider;
  name: string;
  configured: boolean;
  models: AvailableModel[];
  error?: string;
}

export interface ResolvedStageModel extends StageModelSelection {
  providerConfig?: ProviderConfig;
}

export interface ModelConfigurationOptions {
  env: NodeJS.ProcessEnv;
  path: string;
  fetch?: typeof fetch;
}

interface ProviderEnvironment {
  providerConfig: ProviderConfig;
  configuredModels?: AvailableModel[];
}

export class ModelConfiguration {
  private readonly fetch: typeof fetch;
  private settings: StageModelSettings | undefined;

  constructor(private readonly options: ModelConfigurationOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  async getSettings(): Promise<StageModelSettings> {
    if (this.settings) return cloneSettings(this.settings);
    try {
      const parsed: unknown = JSON.parse(
        await readFile(this.options.path, "utf8"),
      );
      this.settings = parseSettings(parsed);
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      this.settings = defaultSettings(this.options.env);
    }
    return cloneSettings(this.settings);
  }

  async updateSettings(
    settings: StageModelSettings,
  ): Promise<StageModelSettings> {
    const parsed = parseSettings(settings);
    await Promise.all(
      agentStages.map((stage) => this.assertSupported(parsed[stage])),
    );
    await mkdir(dirname(this.options.path), { recursive: true });
    const temporary = `${this.options.path}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify(parsed, null, 2)}\n`,
      "utf8",
    );
    await rename(temporary, this.options.path);
    this.settings = parsed;
    return cloneSettings(parsed);
  }

  async listProviders(): Promise<ProviderModels[]> {
    return Promise.all(
      (["copilot", "azure-foundry"] as const).map(async (provider) => {
        try {
          return {
            id: provider,
            name: providerName(provider),
            configured: this.isConfigured(provider),
            models: await this.listModels(provider),
          };
        } catch (error) {
          return {
            id: provider,
            name: providerName(provider),
            configured: this.isConfigured(provider),
            models: [],
            error: formatError(error),
          };
        }
      }),
    );
  }

  async resolve(stage: AgentStage): Promise<ResolvedStageModel> {
    const selection = (await this.getSettings())[stage];
    await this.assertSupported(selection);
    if (selection.provider === "copilot") return selection;
    return {
      ...selection,
      providerConfig: this.providerEnvironment(selection.provider)
        .providerConfig,
    };
  }

  async listModels(provider: ModelProvider): Promise<AvailableModel[]> {
    if (provider === "copilot") {
      const configured = configuredModels(
        this.options.env.COPILOT_MODELS,
      );
      if (configured) return configured;
      const client = new CopilotClient(this.copilotClientOptions());
      await client.start();
      try {
        return (await client.listModels()).map((model) => ({
          id: model.id,
          name: model.name,
        }));
      } finally {
        const errors = await client.stop();
        if (errors.length > 0) {
          throw new AggregateError(
            errors,
            "Failed to stop Copilot model discovery client",
          );
        }
      }
    }

    const environment = this.providerEnvironment(provider);
    if (environment.configuredModels) {
      return environment.configuredModels;
    }
    return this.fetchProviderModels(environment.providerConfig);
  }

  copilotClientOptions(): CopilotClientOptions {
    const env = this.options.env;
    return {
      logLevel: parseLogLevel(env.COPILOT_LOG_LEVEL) ?? "warning",
      ...(env.COPILOT_GITHUB_TOKEN
        ? { gitHubToken: env.COPILOT_GITHUB_TOKEN }
        : {}),
    };
  }

  private async assertSupported(
    selection: StageModelSelection,
  ): Promise<void> {
    const models = await this.listModels(selection.provider);
    if (!models.some((model) => model.id === selection.model)) {
      throw new Error(
        `Model ${selection.model} is not available from ${providerName(selection.provider)}`,
      );
    }
  }

  private isConfigured(provider: ModelProvider): boolean {
    if (provider === "copilot") return true;
    try {
      this.providerEnvironment(provider);
      return true;
    } catch {
      return false;
    }
  }

  private providerEnvironment(
    _provider: Exclude<ModelProvider, "copilot">,
  ): ProviderEnvironment {
    const env = this.options.env;
    const configuredUrl = requiredEnv(
      env.AZURE_FOUNDRY_BASE_URL,
      "AZURE_FOUNDRY_BASE_URL",
    );
    const apiKey = requiredEnv(
      env.AZURE_FOUNDRY_API_KEY,
      "AZURE_FOUNDRY_API_KEY",
    );
    const endpoint = normalizeFoundryEndpoint(configuredUrl);
    const models = configuredModels(env.AZURE_FOUNDRY_MODELS);
    return {
      providerConfig: {
        type: "openai",
        baseUrl: endpoint.baseUrl,
        apiKey,
        wireApi:
          parseWireApi(env.AZURE_FOUNDRY_WIRE_API) ??
          endpoint.wireApi ??
          "responses",
      },
      ...(models ? { configuredModels: models } : {}),
    };
  }

  private async fetchProviderModels(
    config: ProviderConfig,
  ): Promise<AvailableModel[]> {
    const url = modelListUrl(config.baseUrl);
    const headers: Record<string, string> = {
      accept: "application/json",
      ...(config.apiKey ? { "api-key": config.apiKey } : {}),
    };
    const response = await this.fetch(url, {
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.text();
    if (!response.ok) {
      throw new Error(
        `Azure Foundry model discovery returned ${response.status}: ${body.slice(0, 500)}`,
      );
    }
    const parsed: unknown = JSON.parse(body);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("data" in parsed) ||
      !Array.isArray(parsed.data)
    ) {
      throw new Error(
        "Azure Foundry model discovery returned an invalid response",
      );
    }
    return parsed.data
      .flatMap((entry): AvailableModel[] => {
        if (
          typeof entry !== "object" ||
          entry === null ||
          !("id" in entry) ||
          typeof entry.id !== "string"
        ) {
          return [];
        }
        const name =
          "display_name" in entry && typeof entry.display_name === "string"
            ? entry.display_name
            : entry.id;
        return [{ id: entry.id, name }];
      })
      .sort((left, right) => left.name.localeCompare(right.name));
  }
}

function defaultSettings(env: NodeJS.ProcessEnv): StageModelSettings {
  const selection = parseDefaultSelection(env);
  return {
    assessment: { ...selection },
    investigation: { ...selection },
    action: { ...selection },
  };
}

function parseDefaultSelection(
  env: NodeJS.ProcessEnv,
): StageModelSelection {
  const provider = parseProvider(env.COPILOT_MODEL_PROVIDER ?? "copilot");
  return {
    provider,
    model: env.COPILOT_MODEL ?? "gpt-5",
  };
}

function parseSettings(value: unknown): StageModelSettings {
  if (typeof value !== "object" || value === null) {
    throw new Error("Model settings must be an object");
  }
  return Object.fromEntries(
    agentStages.map((stage) => {
      const selection = (value as Record<string, unknown>)[stage];
      if (typeof selection !== "object" || selection === null) {
        throw new Error(`Missing model settings for ${stage}`);
      }
      const provider = parseProvider(
        (selection as Record<string, unknown>).provider,
      );
      const model = (selection as Record<string, unknown>).model;
      if (typeof model !== "string" || model.trim() === "") {
        throw new Error(`Model for ${stage} must be a non-empty string`);
      }
      return [stage, { provider, model }];
    }),
  ) as StageModelSettings;
}

function parseProvider(value: unknown): ModelProvider {
  if (
    value === "copilot" ||
    value === "azure-foundry"
  ) {
    return value;
  }
  throw new Error(`Unsupported model provider: ${String(value)}`);
}

function configuredModels(
  value: string | undefined,
): AvailableModel[] | undefined {
  if (!value) return undefined;
  const models = value
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean)
    .map((model) => ({ id: model, name: model }));
  if (models.length === 0) {
    throw new Error("Configured model list must contain at least one model");
  }
  return models;
}

function modelListUrl(baseUrl: string): string {
  const url = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/models`;
  return url.toString();
}

function normalizeFoundryEndpoint(value: string): {
  baseUrl: string;
  wireApi?: "completions" | "responses";
} {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) {
    url.pathname = `${path.slice(0, -"/chat/completions".length)}/`;
    return { baseUrl: url.toString(), wireApi: "completions" };
  }
  if (path.endsWith("/responses")) {
    url.pathname = `${path.slice(0, -"/responses".length)}/`;
    return { baseUrl: url.toString(), wireApi: "responses" };
  }
  url.pathname = `${path}/`;
  return { baseUrl: url.toString() };
}

function parseWireApi(
  value: string | undefined,
): "completions" | "responses" | undefined {
  if (value === undefined) return undefined;
  if (value === "completions" || value === "responses") return value;
  throw new Error("Wire API must be completions or responses");
}

function parseLogLevel(
  value: string | undefined,
): CopilotClientOptions["logLevel"] {
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

function providerName(provider: ModelProvider): string {
  switch (provider) {
    case "copilot":
      return "GitHub Copilot";
    case "azure-foundry":
      return "Azure Foundry (BYOK)";
  }
}

function requiredEnv(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function cloneSettings(
  settings: StageModelSettings,
): StageModelSettings {
  return {
    assessment: { ...settings.assessment },
    investigation: { ...settings.investigation },
    action: { ...settings.action },
  };
}

function isMissingFile(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
