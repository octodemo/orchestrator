import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ModelConfiguration } from "../src/agent/model-config.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function configuration(env: NodeJS.ProcessEnv) {
  const directory = await mkdtemp(join(tmpdir(), "models-"));
  directories.push(directory);
  return {
    directory,
    models: new ModelConfiguration({
      env,
      path: join(directory, "model-settings.json"),
    }),
  };
}

describe("ModelConfiguration", () => {
  it("persists validated per-stage selections", async () => {
    const { directory, models } = await configuration({
      COPILOT_MODELS: "gpt-5,gpt-5.4",
      COPILOT_MODEL: "gpt-5",
    });

    const saved = await models.updateSettings({
      assessment: { provider: "copilot", model: "gpt-5.4" },
      investigation: { provider: "copilot", model: "gpt-5" },
      action: { provider: "copilot", model: "gpt-5.4" },
    });

    expect(saved.action.model).toBe("gpt-5.4");
    await expect(
      readFile(join(directory, "model-settings.json"), "utf8"),
    ).resolves.toContain('"provider": "copilot"');
  });

  it("rejects a model that the selected provider does not support", async () => {
    const { models } = await configuration({
      COPILOT_MODELS: "gpt-5",
      AZURE_FOUNDRY_BASE_URL:
        "https://example.services.ai.azure.com/openai/v1/chat/completions",
      AZURE_FOUNDRY_API_KEY: "secret",
      AZURE_FOUNDRY_MODELS: "gpt-5.2",
    });

    await expect(
      models.updateSettings({
        assessment: { provider: "copilot", model: "gpt-5" },
        investigation: {
          provider: "azure-foundry",
          model: "claude-sonnet",
        },
        action: { provider: "azure-foundry", model: "gpt-5.2" },
      }),
    ).rejects.toThrow(
      "Model claude-sonnet is not available from Azure Foundry (BYOK)",
    );
  });

  it("exposes only Copilot and Azure Foundry as model sources", async () => {
    const { models } = await configuration({
      COPILOT_MODELS: "gpt-5.4,claude-sonnet-5",
      AZURE_FOUNDRY_BASE_URL:
        "https://octodemo-models.services.ai.azure.com/openai/v1/chat/completions",
      AZURE_FOUNDRY_API_KEY: "secret",
      AZURE_FOUNDRY_MODELS: "gpt-5.2-codex",
    });

    await expect(
      models.listProviders().then((providers) =>
        providers.map((provider) => provider.id),
      ),
    ).resolves.toEqual(["copilot", "azure-foundry"]);
  });

  it("resolves Azure Foundry OpenAI-compatible BYOK configuration", async () => {
    const { models } = await configuration({
      COPILOT_MODEL_PROVIDER: "azure-foundry",
      COPILOT_MODEL: "gpt-5.2-codex",
      AZURE_FOUNDRY_BASE_URL:
        "https://octodemo-models.services.ai.azure.com/openai/v1/chat/completions",
      AZURE_FOUNDRY_API_KEY: "secret",
      AZURE_FOUNDRY_MODELS: "gpt-5.2-codex",
    });

    await expect(models.resolve("action")).resolves.toMatchObject({
      provider: "azure-foundry",
      model: "gpt-5.2-codex",
      providerConfig: {
        type: "openai",
        baseUrl:
          "https://octodemo-models.services.ai.azure.com/openai/v1/",
        wireApi: "completions",
      },
    });
  });
});
