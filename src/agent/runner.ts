export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { [key: string]: JsonValue }
  | JsonValue[];

export interface AgentTool {
  description: string;
  inputSchema: Record<string, JsonValue>;
  readOnly?: boolean;
  execute(args: Record<string, JsonValue>): Promise<JsonValue> | JsonValue;
}

export type AgentMode = "plan" | "agent";

export interface RunRequest {
  prompt: string;
  mode?: AgentMode;
}

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface RunResult {
  text: string;
  status: "finished" | "error" | "cancelled";
  branch?: string;
  usage?: RunUsage;
  requestId?: string;
  error?: string;
}

export type RunEvent =
  | { type: "assistant"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool_call"; name: string; status: string }
  | { type: "status"; status: string };

export interface AgentSession {
  readonly id: string;
  run(req: RunRequest, onEvent?: (event: RunEvent) => void): Promise<RunResult>;
  getUsage(): Promise<RunUsage>;
  dispose(): Promise<void>;
}

export interface OpenSessionOptions {
  cwd: string;
  tools?: Record<string, AgentTool>;
  allowTools?: string[];
  denyTools?: string[];
  label?: string;
}

export interface AgentRunner {
  readonly kind: "stub" | "copilot";
  open(options: OpenSessionOptions): Promise<AgentSession>;
}
