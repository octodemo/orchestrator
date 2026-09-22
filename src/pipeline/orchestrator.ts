import { AgentRunner, AgentSession, RunEvent, RunResult } from "../agent/runner.js";
import { IncidentPublisher } from "../publisher/incident-publisher.js";
import { makeIncidentTools } from "../tools/incident-tools.js";
import {
  actPrompt,
  assessPrompt,
  gatherEvidencePrompt,
  investigatePrompt,
  repairPrompt,
} from "./prompts.js";
import {
  parseAssessment,
  parseFixClaim,
  parseHypothesis,
  SchemaError,
} from "./schemas.js";
import { assertTransition, isTerminalState } from "./states.js";
import {
  IncidentInput,
  IncidentRecord,
  IncidentState,
} from "./types.js";
import { defaultVerifyDeps, VerifyDeps, verifyFix } from "./verify.js";

export interface OrchestratorConfig {
  maxTokensPerIncident: number;
  preFixRef: string;
  verifyDeps?: (cwd: string) => VerifyDeps;
  onEvent?: (incidentId: string, event: RunEvent) => void;
  onStateChange?: (record: IncidentRecord) => void;
  publisher?: IncidentPublisher;
  now?: () => string;
}

export async function triageIncident(
  input: IncidentInput,
  runner: AgentRunner,
  config: OrchestratorConfig,
): Promise<IncidentRecord> {
  const record: IncidentRecord = {
    input,
    state: "received",
    totalTokens: 0,
    requestIds: [],
    events: [],
  };
  const now = config.now ?? (() => new Date().toISOString());
  let session: AgentSession | undefined;
  const disposeSession = async () => {
    const activeSession = session;
    session = undefined;
    await activeSession?.dispose();
  };
  const move = (to: IncidentState, detail = "") => {
    assertTransition(record.state, to);
    record.state = to;
    record.events.push({ at: now(), kind: to, detail });
    config.onStateChange?.(record);
  };
  const finish = async (): Promise<IncidentRecord> => {
    if (!config.publisher || !isTerminalState(record.state)) return record;
    await disposeSession();
    try {
      record.publication = await config.publisher.publish(record);
    } catch (error) {
      record.publication = {
        status: "failed",
        baseBranch: config.publisher.baseBranch,
        error: formatError(error),
      };
    }
    config.onStateChange?.(record);
    return record;
  };
  config.onStateChange?.(record);
  try {
    const activeSession = await runner.open({
      cwd: input.cwd,
      tools: makeIncidentTools(input.cwd),
      label: `incident:${input.id}`,
    });
    session = activeSession;

    const send = async (
      prompt: string,
      mode: "plan" | "agent",
      stage: "assessment" | "investigation" | "action",
    ): Promise<RunResult> => {
      const result = await activeSession.run({ prompt, mode, stage }, (event) => {
        record.events.push({
          at: now(),
          kind: `event:${event.type}`,
          detail: JSON.stringify(event),
        });
        config.onEvent?.(input.id, event);
      });
      if (result.usage) record.totalTokens += result.usage.totalTokens;
      if (result.requestId) record.requestIds.push(result.requestId);
      if (result.status !== "finished") {
        throw new Error(
          `Agent run ${result.status}: ${result.error ?? "unknown error"}`,
        );
      }
      return result;
    };

    const parseStage = async <T>(
      prompt: string,
      mode: "plan" | "agent",
      stage: "assessment" | "investigation" | "action",
      parse: (text: string) => T,
    ): Promise<{ value: T; result: RunResult }> => {
      const result = await send(prompt, mode, stage);
      try {
        return { value: parse(result.text), result };
      } catch (error) {
        if (!(error instanceof SchemaError)) throw error;
        const repaired = await send(
          repairPrompt(prompt, result.text, error.message),
          "plan",
          stage,
        );
        try {
          return { value: parse(repaired.text), result };
        } catch (repairError) {
          if (repairError instanceof SchemaError) {
            throw new SchemaError(
              `Schema validation failed after one repair attempt: ${repairError.message}`,
            );
          }
          throw repairError;
        }
      }
    };

    const stopForBudget = (): boolean => {
      if (record.totalTokens <= config.maxTokensPerIncident) return false;
      move(
        "budget_exceeded",
        `Token ceiling exceeded at ${record.totalTokens} tokens`,
      );
      return true;
    };

    move("assessing");
    const assessment = await parseStage(
      assessPrompt(input),
      "plan",
      "assessment",
      parseAssessment,
    );
    record.assessment = assessment.value;
    if (stopForBudget()) return finish();

    if (record.assessment.autonomy === "escalate_only") {
      const evidence = await parseStage(
        gatherEvidencePrompt(input, record.assessment),
        "plan",
        "investigation",
        parseFixClaim,
      );
      record.claim = evidence.value;
      if (stopForBudget()) return finish();
      move("escalated", record.claim.summary);
      return finish();
    }

    move("investigating");
    const hypothesis = await parseStage(
      investigatePrompt(input, record.assessment),
      "plan",
      "investigation",
      parseHypothesis,
    );
    record.hypothesis = hypothesis.value;
    if (stopForBudget()) return finish();

    move("acting");
    const claim = await parseStage(
      actPrompt(input, record.hypothesis),
      "agent",
      "action",
      parseFixClaim,
    );
    record.claim = claim.value;
    if (input.workspaceBranch) {
      record.claim.branch = input.workspaceBranch;
    } else if (!record.claim.branch && claim.result.branch) {
      record.claim.branch = claim.result.branch;
    }
    if (stopForBudget()) return finish();

    if (record.claim.status !== "fixed") {
      move("escalated", `Agent did not fix incident: ${record.claim.summary}`);
      return finish();
    }

    move("awaiting_verification");
    const deps = (config.verifyDeps ?? defaultVerifyDeps)(input.cwd);
    record.verification = await verifyFix(
      record.claim,
      config.preFixRef,
      deps,
    );
    if (record.verification.outcome === "verified") {
      move("verified_fixed", record.verification.detail);
    } else {
      move("needs_human", record.verification.detail);
    }
    return finish();
  } catch (error) {
    if (!isTerminalState(record.state)) {
      move("failed", formatError(error));
    }
    return finish();
  } finally {
    await disposeSession();
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
