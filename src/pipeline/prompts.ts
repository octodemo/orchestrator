import {
  Assessment,
  FixClaim,
  Hypothesis,
  IncidentInput,
} from "./types.js";

const jsonOnly = `
Return one fenced JSON object and no prose outside the fence.
Do not include markdown other than the JSON fence.`;

export function assessPrompt(input: IncidentInput): string {
  return `Assess this incident without changing files.

Incident id: ${input.id}
Trigger: ${input.trigger}
Report or fixture path:
${input.report}

Decide the autonomy ceiling. Use "escalate_only" for security-sensitive,
production-destructive, ambiguous, or otherwise unsafe changes. Use "auto_fix"
only for a bounded, reversible source-code fix.

Return:
{
  "type": string,
  "severity": "low" | "medium" | "high" | "critical",
  "autonomy": "auto_fix" | "escalate_only",
  "rationale": string
}
${jsonOnly}`;
}

export function investigatePrompt(
  input: IncidentInput,
  assessment: Assessment,
): string {
  return `Investigate this incident in plan mode and produce a root-cause hypothesis.
Use the supplied read-only tools to inspect the report, recent commits, code,
tests, and live pool status when relevant. Do not modify files.

Incident id: ${input.id}
Trigger: ${input.trigger}
Assessment type: ${assessment.type}
Severity: ${assessment.severity}
Assessment rationale: ${assessment.rationale}
Report or fixture path:
${input.report}

Return:
{
  "rootCause": string,
  "offendingCommit"?: string,
  "suspectFiles": string[],
  "proposedFix": string
}
${jsonOnly}`;
}

export function actPrompt(
  input: IncidentInput,
  hypothesis: Hypothesis,
): string {
  return `Implement a durable fix for incident ${input.id}.

Root cause: ${hypothesis.rootCause}
Suspect files: ${hypothesis.suspectFiles.join(", ")}
Proposed fix: ${hypothesis.proposedFix}

First add a focused reproduction test, then make the smallest source change that
fixes it. Do not modify existing tests, the test harness, CI configuration, or
production infrastructure. Do not merge, force-push, roll back, restart, scale,
or deploy anything. Put operational advice in recommendedMitigation instead.

Return:
{
  "status": "fixed" | "not_fixed" | "declined",
  "branch"?: string,
  "testPath"?: string,
  "summary": string,
  "recommendedMitigation"?: string
}
${jsonOnly}`;
}

export function gatherEvidencePrompt(
  input: IncidentInput,
  assessment: Assessment,
): string {
  return `Gather a read-only evidence packet for incident ${input.id}.
Do not modify files or execute remediation. Summarize the affected area and
recommend the next human action.

Assessment type: ${assessment.type}
Severity: ${assessment.severity}
Assessment rationale: ${assessment.rationale}
Report or fixture path:
${input.report}

Return:
{
  "status": "declined",
  "summary": string,
  "recommendedMitigation": string
}
${jsonOnly}`;
}

export function repairPrompt(
  originalPrompt: string,
  invalidOutput: string,
  error: string,
): string {
  return `${originalPrompt}

Your previous response failed schema validation:
${error}

Previous response:
${invalidOutput}

Return corrected JSON only, using the exact requested schema.`;
}

export function claimSummary(claim: FixClaim): string {
  return `${claim.status}: ${claim.summary}`;
}
