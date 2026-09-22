import {
  approveAll,
  CopilotClient,
  type CopilotSession,
  defineTool,
  type SessionEvent,
} from "@github/copilot-sdk";
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

const RUN_TIMEOUT_MS = 30 * 60_000;

export interface CopilotRunnerConfig {
  model: string;
  gitHubToken?: string;
  logLevel?: "none" | "error" | "warning" | "info" | "debug" | "all";
}

class CopilotAgentSession implements AgentSession {
  readonly id: string;
  private usage: RunUsage = emptyUsage();

  constructor(
    private readonly client: CopilotClient,
    private readonly session: CopilotSession,
  ) {
    this.id = session.sessionId;
  }

  async run(
    request: RunRequest,
    onEvent?: (event: RunEvent) => void,
  ): Promise<RunResult> {
    await this.session.rpc.mode.set({
      mode: request.mode === "agent" ? "autopilot" : "plan",
    });

    let runUsage = emptyUsage();
    let error: string | undefined;
    let cancelled = false;
    const toolNames = new Map<string, string>();
    const unsubscribe = this.session.on((event) => {
      const normalized = normalizeEvent(event, toolNames);
      if (normalized) onEvent?.(normalized);

      if (event.type === "assistant.usage") {
        const inputTokens = event.data.inputTokens ?? 0;
        const outputTokens = event.data.outputTokens ?? 0;
        runUsage = {
          inputTokens: runUsage.inputTokens + inputTokens,
          outputTokens: runUsage.outputTokens + outputTokens,
          totalTokens: runUsage.totalTokens + inputTokens + outputTokens,
        };
      } else if (event.type === "session.error") {
        error = event.data.message;
      } else if (event.type === "session.idle" && event.data.aborted) {
        cancelled = true;
      }
    });

    try {
      const response = await this.session.sendAndWait(
        { prompt: request.prompt },
        RUN_TIMEOUT_MS,
      );
      this.usage = addUsage(this.usage, runUsage);

      if (cancelled) {
        return {
          text: response?.data.content ?? "",
          status: "cancelled",
          usage: runUsage,
          ...(response ? { requestId: requestId(response.data) } : {}),
        };
      }
      if (error) {
        return {
          text: response?.data.content ?? "",
          status: "error",
          usage: runUsage,
          error,
          ...(response ? { requestId: requestId(response.data) } : {}),
        };
      }
      if (!response) {
        return {
          text: "",
          status: "error",
          usage: runUsage,
          error: "Copilot completed without an assistant response",
        };
      }
      return {
        text: response.data.content,
        status: "finished",
        usage: runUsage,
        requestId: requestId(response.data),
      };
    } finally {
      unsubscribe();
    }
  }

  async getUsage(): Promise<RunUsage> {
    return { ...this.usage };
  }

  async dispose(): Promise<void> {
    try {
      await this.session.disconnect();
    } finally {
      const errors = await this.client.stop();
      if (errors.length > 0) {
        throw new AggregateError(errors, "Failed to stop Copilot client");
      }
    }
  }
}

export class CopilotAgentRunner implements AgentRunner {
  readonly kind = "copilot" as const;

  constructor(private readonly config: CopilotRunnerConfig) {}

  async open(options: OpenSessionOptions): Promise<AgentSession> {
    const client = new CopilotClient({
      workingDirectory: options.cwd,
      logLevel: this.config.logLevel ?? "warning",
      ...(this.config.gitHubToken
        ? { gitHubToken: this.config.gitHubToken }
        : {}),
    });
    await client.start();

    try {
      const tools = options.tools
        ? Object.entries(options.tools).map(([name, tool]) =>
            defineTool<Record<string, JsonValue>>(name, {
              description: tool.description,
              parameters: tool.inputSchema,
              handler: (args) => tool.execute(args),
              skipPermission: tool.readOnly ?? false,
              defer: "never",
            }),
          )
        : undefined;
      const session = await client.createSession({
        clientName: "incident-orchestrator",
        model: this.config.model,
        workingDirectory: options.cwd,
        streaming: true,
        onPermissionRequest: approveAll,
        ...(tools ? { tools } : {}),
        ...(options.allowTools ? { availableTools: options.allowTools } : {}),
        ...(options.denyTools ? { excludedTools: options.denyTools } : {}),
      });
      return new CopilotAgentSession(client, session);
    } catch (error) {
      await client.stop();
      throw error;
    }
  }
}

function normalizeEvent(
  event: SessionEvent,
  toolNames: Map<string, string>,
): RunEvent | undefined {
  switch (event.type) {
    case "assistant.message_delta":
      if (event.agentId) return undefined;
      return { type: "assistant", text: event.data.deltaContent };
    case "assistant.reasoning_delta":
      if (event.agentId) return undefined;
      return { type: "thinking", text: event.data.deltaContent };
    case "tool.execution_start":
      toolNames.set(event.data.toolCallId, event.data.toolName);
      return {
        type: "tool_call",
        name: event.data.toolName,
        status: "running",
      };
    case "tool.execution_complete": {
      const name =
        toolNames.get(event.data.toolCallId) ??
        event.data.toolDescription?.name ??
        event.data.toolCallId;
      toolNames.delete(event.data.toolCallId);
      return {
        type: "tool_call",
        name,
        status: event.data.success ? "completed" : "failed",
      };
    }
    case "session.error":
      return { type: "status", status: "error" };
    case "session.idle":
      return {
        type: "status",
        status: event.data.aborted ? "cancelled" : "finished",
      };
    default:
      return undefined;
  }
}

function requestId(data: {
  requestId?: string;
  serviceRequestId?: string;
  messageId: string;
}): string {
  return data.requestId ?? data.serviceRequestId ?? data.messageId;
}

function emptyUsage(): RunUsage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

function addUsage(left: RunUsage, right: RunUsage): RunUsage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}
