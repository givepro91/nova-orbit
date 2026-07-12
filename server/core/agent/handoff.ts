import {
  AGENT_HANDOFF_CONTRACT_VERSION,
  AGENT_HANDOFF_STAGES,
  type AgentHandoff,
  type AgentHandoffStage,
} from "../../../shared/types.js";

export const AGENT_HANDOFF_ARRAY_FIELDS = [
  "changed_files",
  "decisions",
  "unresolved_risks",
  "reproduction_commands",
] as const;

export type AgentHandoffArrayField = (typeof AGENT_HANDOFF_ARRAY_FIELDS)[number];
export type AgentHandoffDiagnosticCode =
  | "missing_field"
  | "invalid_type"
  | "invalid_value"
  | "unsupported_version";

export interface AgentHandoffDiagnostic {
  field: string;
  code: AgentHandoffDiagnosticCode;
  message: string;
}

export type AgentHandoffValidationResult =
  | { success: true; data: AgentHandoff; diagnostics: [] }
  | { success: false; data: null; diagnostics: AgentHandoffDiagnostic[] };

export interface CreateAgentHandoffInput {
  stage: AgentHandoffStage;
  changed_files?: string[];
  decisions?: string[];
  unresolved_risks?: string[];
  reproduction_commands?: string[];
}

/** Creates a complete producer-side handoff, normalizing absent entries to empty arrays. */
export function createAgentHandoff(input: CreateAgentHandoffInput): AgentHandoff {
  return {
    version: AGENT_HANDOFF_CONTRACT_VERSION,
    stage: input.stage,
    changed_files: [...(input.changed_files ?? [])],
    decisions: [...(input.decisions ?? [])],
    unresolved_risks: [...(input.unresolved_risks ?? [])],
    reproduction_commands: [...(input.reproduction_commands ?? [])],
  };
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function missingField(field: string): AgentHandoffDiagnostic {
  return {
    field,
    code: "missing_field",
    message: `Required handoff field '${field}' is missing.`,
  };
}

/** Strict consumer-side validation. Missing required arrays are not normalized away. */
export function validateAgentHandoff(value: unknown): AgentHandoffValidationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      success: false,
      data: null,
      diagnostics: [{
        field: "$",
        code: "invalid_type",
        message: `Handoff must be an object; received ${describeType(value)}.`,
      }],
    };
  }

  const record = value as Record<string, unknown>;
  const diagnostics: AgentHandoffDiagnostic[] = [];

  if (!("version" in record)) {
    diagnostics.push(missingField("version"));
  } else if (typeof record.version !== "number") {
    diagnostics.push({
      field: "version",
      code: "invalid_type",
      message: `Handoff version must be a number; received ${describeType(record.version)}.`,
    });
  } else if (record.version !== AGENT_HANDOFF_CONTRACT_VERSION) {
    diagnostics.push({
      field: "version",
      code: "unsupported_version",
      message: `Unsupported handoff version '${record.version}'; expected '${AGENT_HANDOFF_CONTRACT_VERSION}'.`,
    });
  }

  if (!("stage" in record)) {
    diagnostics.push(missingField("stage"));
  } else if (typeof record.stage !== "string") {
    diagnostics.push({
      field: "stage",
      code: "invalid_type",
      message: `Handoff stage must be a string; received ${describeType(record.stage)}.`,
    });
  } else if (!AGENT_HANDOFF_STAGES.includes(record.stage as AgentHandoffStage)) {
    diagnostics.push({
      field: "stage",
      code: "invalid_value",
      message: `Unknown handoff stage '${record.stage}'.`,
    });
  }

  for (const field of AGENT_HANDOFF_ARRAY_FIELDS) {
    if (!(field in record)) {
      diagnostics.push(missingField(field));
      continue;
    }
    const entries = record[field];
    if (!Array.isArray(entries)) {
      diagnostics.push({
        field,
        code: "invalid_type",
        message: `Handoff field '${field}' must be an array; received ${describeType(entries)}.`,
      });
      continue;
    }
    entries.forEach((entry, index) => {
      const entryField = `${field}[${index}]`;
      if (typeof entry !== "string") {
        diagnostics.push({
          field: entryField,
          code: "invalid_type",
          message: `Handoff field '${entryField}' must be a string; received ${describeType(entry)}.`,
        });
      } else if (entry.trim().length === 0) {
        diagnostics.push({
          field: entryField,
          code: "invalid_value",
          message: `Handoff field '${entryField}' must not be empty.`,
        });
      }
    });
  }

  if (diagnostics.length > 0) {
    return { success: false, data: null, diagnostics };
  }
  return { success: true, data: record as unknown as AgentHandoff, diagnostics: [] };
}

/** Runtime schema surface shared by parsers, persistence, and pre-spawn guards. */
export const agentHandoffSchema = {
  version: AGENT_HANDOFF_CONTRACT_VERSION,
  stages: AGENT_HANDOFF_STAGES,
  requiredArrayFields: AGENT_HANDOFF_ARRAY_FIELDS,
  safeParse: validateAgentHandoff,
} as const;
