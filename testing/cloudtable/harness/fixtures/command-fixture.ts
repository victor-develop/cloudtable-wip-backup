import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { CommandEnvelope } from "../../../../src/core/commands/types";
import type { WorkflowAuthoringMetadata } from "../../../../src/core/workflows/types";
import { parseCanonicalJson } from "../serializers/canonical-json";

export type CommandFixtureMeta = {
  logicalStartTime: string;
  scenarioId: string;
  schemaVersion: number;
  seed: number;
};

export type PermissionExpectation = {
  allowed: boolean;
  reasons: string[];
};

export type SeedReceipt = {
  idempotencyKey: string;
  payloadHash: string;
  result: CommandTranscriptResult;
};

export type CommandFixtureSeedField = {
  config?: Record<string, unknown>;
  fieldId: string;
  fieldKey: string;
  fieldType: string;
  label: string;
};

export type CommandFixtureSeedRecord = {
  archivedAt?: string | null;
  lastEventId?: string | null;
  recordId: string;
  recordKey: string;
  recordRevision?: number;
};

export type CommandFixturePersistenceSeed = {
  appId?: string;
  fields?: CommandFixtureSeedField[];
  records?: CommandFixtureSeedRecord[];
};

export type CommandFixtureSeedState = {
  permission?: PermissionExpectation;
  persistence?: CommandFixturePersistenceSeed;
  receipts?: SeedReceipt[];
  workflowAuthoringMetadata?: WorkflowAuthoringMetadata;
};

export type CommandProjection = {
  acceptedCommandIds: string[];
  lastLogicalTime: string;
  receiptCount: number;
  receipts: Array<{
    idempotencyKey: string;
    payloadHash: string;
    status: string;
  }>;
};

export type CommandTranscriptResult = {
  accepted: boolean;
  diagnostics: string[];
  events: Array<Record<string, unknown>>;
  permission: PermissionExpectation;
  replayProjection: CommandProjection;
  sideEffects: Array<Record<string, unknown>>;
  status: "accepted" | "rejected";
};

export type CommandFixture = {
  command: CommandEnvelope;
  expected: CommandTranscriptResult;
  meta: CommandFixtureMeta;
  seedState: CommandFixtureSeedState;
};

function readRequiredJson<T>(scenarioPath: string, filename: string): T {
  return parseCanonicalJson<T>(readFileSync(join(scenarioPath, filename), "utf8"));
}

function readOptionalJson<T>(scenarioPath: string, filename: string, fallback: T): T {
  const filePath = join(scenarioPath, filename);
  return existsSync(filePath) ? parseCanonicalJson<T>(readFileSync(filePath, "utf8")) : fallback;
}

export function listCommandFixtureScenarioIds(fixturesRoot = resolve(process.cwd(), "testing/cloudtable/fixtures/commands")): string[] {
  return readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

export function loadCommandFixture(
  scenarioId: string,
  fixturesRoot = resolve(process.cwd(), "testing/cloudtable/fixtures/commands")
): CommandFixture {
  const scenarioPath = join(fixturesRoot, scenarioId);
  const meta = readRequiredJson<CommandFixtureMeta>(scenarioPath, "meta.json");
  const command = readRequiredJson<CommandEnvelope>(scenarioPath, "command.json");
  const expectedEvents = readRequiredJson<Array<Record<string, unknown>>>(scenarioPath, "expected-events.json");
  const expectedSideEffects = readRequiredJson<Array<Record<string, unknown>>>(scenarioPath, "expected-side-effects.json");
  const expectedResult = readRequiredJson<Omit<CommandTranscriptResult, "events" | "permission" | "replayProjection" | "sideEffects">>(
    scenarioPath,
    "expected-result.json"
  );
  const expectedProjection = readRequiredJson<CommandProjection>(scenarioPath, "expected-projections.json");
  const expectedPermission = readRequiredJson<PermissionExpectation>(scenarioPath, "expected-permission.json");
  const seedState = readOptionalJson<CommandFixtureSeedState>(scenarioPath, "seed-state.json", {});

  return {
    command,
    expected: {
      ...expectedResult,
      events: expectedEvents,
      permission: expectedPermission,
      replayProjection: expectedProjection,
      sideEffects: expectedSideEffects
    },
    meta,
    seedState
  };
}
