import { describe, expect, it } from "vitest";
import { makeAgentRunner } from "../src/agent/index.js";

const stubScripts = () => [];

describe("makeAgentRunner", () => {
  it("creates the Copilot runner without requiring an API key", () => {
    const runner = makeAgentRunner({
      env: {
        AGENT_RUNNER: "copilot",
        COPILOT_MODEL: "gpt-5",
      },
      stubScripts,
    });

    expect(runner.kind).toBe("copilot");
  });

  it("rejects invalid Copilot log levels", () => {
    expect(() =>
      makeAgentRunner({
        env: {
          AGENT_RUNNER: "copilot",
          COPILOT_LOG_LEVEL: "verbose",
        },
        stubScripts,
      }),
    ).toThrow(
      "COPILOT_LOG_LEVEL must be one of none, error, warning, info, debug, or all",
    );
  });

  it("rejects retired Cursor runner configuration", () => {
    expect(() =>
      makeAgentRunner({
        env: { AGENT_RUNNER: "cursor" },
        stubScripts,
      }),
    ).toThrow("Unsupported AGENT_RUNNER value: cursor");
  });
});
