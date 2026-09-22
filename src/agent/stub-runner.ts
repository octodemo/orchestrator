import {
  AgentRunner,
  AgentSession,
  JsonValue,
  OpenSessionOptions,
  RunEvent,
  RunRequest,
  RunResult,
  RunUsage,
} from "./runner.js";

export interface StubToolCall {
  name: string;
  args?: Record<string, JsonValue>;
}

export interface StubScript {
  match: string | RegExp;
  mode?: RunRequest["mode"];
  stage?: RunRequest["stage"];
  callTools?: StubToolCall[];
  execute?: (options: OpenSessionOptions) => Promise<void> | void;
  result: Omit<RunResult, "status"> & { status?: RunResult["status"] };
}

export type StubScriptFactory = (options: OpenSessionOptions) => StubScript[];

let nextSessionId = 1;

class StubSession implements AgentSession {
  readonly id = `stub-${nextSessionId++}`;
  private readonly scripts: StubScript[];
  private usage: RunUsage = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };

  constructor(
    scripts: StubScript[],
    private readonly options: OpenSessionOptions,
  ) {
    this.scripts = [...scripts];
  }

  async run(
    request: RunRequest,
    onEvent?: (event: RunEvent) => void,
  ): Promise<RunResult> {
    const index = this.scripts.findIndex(
      (script) =>
        matches(script.match, request.prompt) &&
        (script.mode === undefined || script.mode === request.mode) &&
        (script.stage === undefined || script.stage === request.stage),
    );
    if (index === -1) {
      throw new Error(
        `No stub script matched ${request.mode ?? "agent"} prompt: ${request.prompt.slice(0, 120)}`,
      );
    }

    const [script] = this.scripts.splice(index, 1);
    if (!script) throw new Error("Matched stub script could not be loaded");

    onEvent?.({ type: "status", status: "running" });
    for (const call of script.callTools ?? []) {
      const tool = this.options.tools?.[call.name];
      if (!tool) throw new Error(`Stub requested unknown tool: ${call.name}`);
      onEvent?.({ type: "tool_call", name: call.name, status: "running" });
      await tool.execute(call.args ?? {});
      onEvent?.({ type: "tool_call", name: call.name, status: "completed" });
    }
    await script.execute?.(this.options);
    if (script.result.text) {
      onEvent?.({ type: "assistant", text: script.result.text });
    }
    onEvent?.({ type: "status", status: script.result.status ?? "finished" });

    const result: RunResult = {
      ...script.result,
      status: script.result.status ?? "finished",
    };
    if (result.usage) {
      this.usage = {
        inputTokens: this.usage.inputTokens + result.usage.inputTokens,
        outputTokens: this.usage.outputTokens + result.usage.outputTokens,
        totalTokens: this.usage.totalTokens + result.usage.totalTokens,
      };
    }
    return result;
  }

  async getUsage(): Promise<RunUsage> {
    return { ...this.usage };
  }

  async dispose(): Promise<void> {}
}

export class StubAgentRunner implements AgentRunner {
  readonly kind = "stub" as const;

  constructor(private readonly scripts: StubScriptFactory) {}

  async open(options: OpenSessionOptions): Promise<AgentSession> {
    return new StubSession(this.scripts(options), options);
  }
}

function matches(matcher: string | RegExp, prompt: string): boolean {
  return typeof matcher === "string"
    ? prompt.includes(matcher)
    : matcher.test(prompt);
}
