import { describe, expect, it } from "vitest";
import { AgentRunner, OpenSessionOptions } from "../src/agent/runner.js";
import { StubAgentRunner, StubScript } from "../src/agent/stub-runner.js";
import { triageIncident } from "../src/pipeline/orchestrator.js";
import { IncidentPublisher } from "../src/publisher/incident-publisher.js";
import { VerifyDeps } from "../src/pipeline/verify.js";

const input = {
  id: "incident-season",
  trigger: "manual" as const,
  report: "season boundary is wrong",
  cwd: process.cwd(),
};

function json(value: object): string {
  return JSON.stringify(value);
}

function successfulScripts(): StubScript[] {
  return [
    {
      match: "Decide the autonomy ceiling",
      mode: "plan",
      stage: "assessment",
      result: {
        text: json({
          type: "logic",
          severity: "high",
          autonomy: "auto_fix",
          rationale: "bounded",
        }),
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        requestId: "assess",
      },
    },
    {
      match: "root-cause hypothesis",
      mode: "plan",
      stage: "investigation",
      result: {
        text: json({
          rootCause: "exclusive boundary",
          suspectFiles: ["src/season.ts"],
          proposedFix: "use inclusive boundary",
        }),
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        requestId: "investigate",
      },
    },
    {
      match: "durable fix",
      mode: "agent",
      stage: "action",
      result: {
        text: json({
          status: "fixed",
          testPath: "test/season.test.ts",
          summary: "fixed",
        }),
        branch: "fix/season",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        requestId: "act",
      },
    },
  ];
}

const verified: VerifyDeps = {
  async runTestsAtRef(ref, testPath) {
    if (ref === "before") {
      return { passed: false, detail: "failed as expected" };
    }
    return {
      passed: true,
      detail: testPath ? "repro passed" : "suite passed",
    };
  },
  async validateChangedFiles() {
    return {
      passed: true,
      detail: "clean",
      changedFiles: ["src/season.ts", "test/season.test.ts"],
    };
  },
};

describe("triageIncident", () => {
  it("runs the complete verified-fix path", async () => {
    const states: string[] = [];
    const record = await triageIncident(
      input,
      new StubAgentRunner(() => successfulScripts()),
      {
        maxTokensPerIncident: 100,
        preFixRef: "before",
        verifyDeps: () => verified,
        onStateChange: (next) => states.push(next.state),
        now: () => "2026-01-01T00:00:00.000Z",
      },
    );

    expect(record.state).toBe("verified_fixed");
    expect(record.totalTokens).toBe(45);
    expect(record.requestIds).toEqual(["assess", "investigate", "act"]);
    expect(states).toEqual([
      "received",
      "assessing",
      "investigating",
      "acting",
      "awaiting_verification",
      "verified_fixed",
    ]);
  });

  it("repairs one invalid structured response", async () => {
    const scripts = successfulScripts();
    scripts[0] = {
      match: "Decide the autonomy ceiling",
      mode: "plan",
      result: { text: "not json" },
    };
    scripts.splice(1, 0, {
      match: "Return corrected JSON only",
      mode: "plan",
      stage: "assessment",
      result: {
        text: json({
          type: "logic",
          severity: "high",
          autonomy: "auto_fix",
          rationale: "bounded",
        }),
      },
    });

    const record = await triageIncident(
      input,
      new StubAgentRunner(() => scripts),
      {
        maxTokensPerIncident: 100,
        preFixRef: "before",
        verifyDeps: () => verified,
      },
    );
    expect(record.state).toBe("verified_fixed");
    expect(record.claim?.branch).toBe("fix/season");
  });

  it("uses the trusted managed workspace branch over agent output", async () => {
    const record = await triageIncident(
      {
        ...input,
        workspaceBranch: "incident-fix/managed-attempt-2",
      },
      new StubAgentRunner(() => successfulScripts()),
      {
        maxTokensPerIncident: 100,
        preFixRef: "before",
        verifyDeps: () => verified,
      },
    );

    expect(record.claim?.branch).toBe("incident-fix/managed-attempt-2");
  });

  it("never enters agent mode for escalation-only incidents", async () => {
    const scripts: StubScript[] = [
      {
        match: "Decide the autonomy ceiling",
        mode: "plan",
        result: {
          text: json({
            type: "sast",
            severity: "critical",
            autonomy: "escalate_only",
            rationale: "security boundary",
          }),
        },
      },
      {
        match: "evidence packet",
        mode: "plan",
        result: {
          text: json({
            status: "declined",
            summary: "human review required",
            recommendedMitigation: "assign security",
          }),
        },
      },
    ];
    const record = await triageIncident(
      { ...input, id: "incident-sast" },
      new StubAgentRunner(() => scripts),
      {
        maxTokensPerIncident: 100,
        preFixRef: "before",
        verifyDeps: () => verified,
      },
    );
    expect(record.state).toBe("escalated");
    expect(record.hypothesis).toBeUndefined();
  });

  it("records runner-open failures as failed incidents", async () => {
    const runner: AgentRunner = {
      kind: "stub",
      async open(_options: OpenSessionOptions) {
        throw new Error("runner unavailable");
      },
    };
    const record = await triageIncident(input, runner, {
      maxTokensPerIncident: 100,
      preFixRef: "before",
    });
    expect(record.state).toBe("failed");
    expect(record.events.at(-1)?.detail).toBe("runner unavailable");
  });

  it("records publisher failures without weakening the verified outcome", async () => {
    const publisher: IncidentPublisher = {
      baseBranch: "main",
      async publish() {
        throw new Error("gh authentication failed");
      },
    };
    const record = await triageIncident(
      input,
      new StubAgentRunner(() => successfulScripts()),
      {
        maxTokensPerIncident: 100,
        preFixRef: "before",
        verifyDeps: () => verified,
        publisher,
      },
    );

    expect(record.state).toBe("verified_fixed");
    expect(record.publication).toEqual({
      status: "failed",
      baseBranch: "main",
      error: "gh authentication failed",
    });
  });
});
