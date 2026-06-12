import { describe, expect, it } from "vitest";

import { createCommandBus } from "../../../../src/core/commands/command-bus";
import { scopeKeyForCommand } from "../../../../src/core/commands/transcript";
import type { CommandEnvelope } from "../../../../src/core/commands/types";
import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import type { PermissionEngine } from "../../../../src/core/permissions/types";
import { createWorkflowOperatorRegistry } from "../../../../src/core/workflows/operator-registry";
import { handleScheduled } from "../../../../src/runtime/worker";
import type { CloudTableEnv, CloudTableQueueMessage } from "../../../../src/runtime/env";
import {
  listCommandFixtureScenarioIds,
  loadCommandFixture
} from "../../harness/fixtures/command-fixture";
import { InMemoryEventLedger } from "../../harness/runtime/in-memory-event-ledger";
import {
  seedAppAndTable,
  seedWorkspace,
  SqliteD1Database
} from "../../harness/runtime/sqlite-d1";
import { toCanonicalJson } from "../../harness/serializers/canonical-json";

const logicalTime = "2026-06-06T00:00:00.000Z";
const fieldTypeRegistry = createFieldTypeRegistry();
const workflowOperatorRegistry = createWorkflowOperatorRegistry();

const invariantReplayScenarioIds = [
  "base-create-basic",
  "table-create-basic",
  "record-create-basic",
  "workflow-manual-basic",
  "workflow-notification-emit-basic"
].filter((scenarioId) => listCommandFixtureScenarioIds().includes(scenarioId));

class RecordingQueue {
  readonly sent: CloudTableQueueMessage[] = [];

  async send(message: CloudTableQueueMessage): Promise<void> {
    this.sent.push(message);
  }
}

function createPermissionEngine(): PermissionEngine {
  return {
    describeField() {
      return {
        allowsMutation: true,
        allowsWorkflowTrigger: true,
        readRedaction: "none",
        supportsValueVisibilityRules: false
      };
    },
    evaluateFieldAccess(field) {
      return {
        allowed: true,
        fieldId: field.fieldId,
        fieldType: field.fieldType,
        readState: "visible",
        reasons: [],
        writeAllowed: true
      };
    },
    explainFieldAccess(field, surfaces = ["direct-record-read"]) {
      return {
        fieldId: field.fieldId,
        fieldType: field.fieldType,
        surfaces: surfaces.map((surface) => ({
          allowed: true,
          message: "Allowed.",
          readState: "visible",
          reasonMessages: [],
          reasons: [],
          surface,
          writeAllowed: true
        }))
      };
    },
    evaluateCommand() {
      return {
        allowed: true,
        reasons: []
      };
    },
    projectFields() {
      return {
        diagnostics: [],
        fields: {},
        hiddenFieldIds: [],
        redactedFieldIds: [],
        states: {}
      };
    },
    filterAgentTools(tools) {
      return tools.map((tool) => ({
        allowed: true,
        hiddenFieldIds: [],
        reason: null,
        toolId: tool.id,
        visibleFieldIds: []
      }));
    },
    resolveAgentToolFieldVisibility() {
      return {
        hiddenFieldIds: [],
        visibleFieldIds: [],
        writableFieldIds: []
      };
    },
    listSurfaces() {
      return [];
    }
  };
}

function createInvariantCommandBus(eventLedger: InMemoryEventLedger) {
  return createCommandBus({
    eventLedger,
    fieldTypeRegistry,
    permissionEngine: createPermissionEngine(),
    workflowOperatorRegistry,
    idFactory(prefix) {
      return `${prefix}_0001`;
    },
    now() {
      return logicalTime;
    }
  });
}

function createScheduledController(scheduledTime: string): ScheduledController {
  return {
    cron: "* * * * *",
    noRetry() {},
    scheduledTime: Date.parse(scheduledTime)
  } as ScheduledController;
}

function insertScheduledWorkflowDefinition(
  db: SqliteD1Database,
  input: {
    cadenceMinutes: number;
    workflowId: string;
  }
): void {
  db.inner
    .prepare(
      `INSERT INTO workflows (
         id,
         workspace_id,
         workflow_key,
         name,
         current_version,
         created_at,
         updated_at,
         archived_at,
         last_event_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.workflowId,
      "ws_demo",
      `${input.workflowId}-key`,
      input.workflowId,
      1,
      logicalTime,
      logicalTime,
      null,
      null
    );

  db.inner
    .prepare(
      `INSERT INTO workflow_versions (
         id,
         workspace_id,
         workflow_id,
         version,
         definition_json,
         published_at,
         last_event_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      `${input.workflowId}:v1`,
      "ws_demo",
      input.workflowId,
      1,
      JSON.stringify({
        actions: [
          {
            input: {
              channel: "ops",
              message: input.workflowId
            },
            operatorId: "emit_notification_event"
          }
        ],
        conditions: [],
        metadata: {
          status: "published"
        },
        trigger: {
          match: {
            schedule: {
              cadenceMinutes: input.cadenceMinutes
            }
          },
          operatorId: "scheduled"
        },
        workflowId: input.workflowId
      }),
      logicalTime,
      null
    );
}

describe("cloudtable deterministic invariants", () => {
  it("keeps scheduler dispatch payloads byte-stable for the same tick", async () => {
    const db = new SqliteD1Database();
    seedWorkspace(db, "ws_demo");
    seedAppAndTable(db, {
      tableId: "tbl_demo",
      workspaceId: "ws_demo"
    });
    insertScheduledWorkflowDefinition(db, {
      cadenceMinutes: 5,
      workflowId: "wf_schedule_alpha"
    });
    insertScheduledWorkflowDefinition(db, {
      cadenceMinutes: 10,
      workflowId: "wf_schedule_beta"
    });

    const queue = new RecordingQueue();
    const env = {
      DB: db as unknown as D1Database,
      WORKFLOW_DISPATCH_QUEUE: queue as unknown as Queue<CloudTableQueueMessage>
    } as CloudTableEnv;

    const controller = createScheduledController("2026-06-06T00:10:00.000Z");
    await handleScheduled(controller, env, {} as ExecutionContext);

    const firstTickMessages = queue.sent.map((message) => structuredClone(message));

    await handleScheduled(controller, env, {} as ExecutionContext);

    const secondTickMessages = queue.sent.slice(firstTickMessages.length);

    expect(toCanonicalJson(secondTickMessages)).toBe(toCanonicalJson(firstTickMessages));
    expect(toCanonicalJson(firstTickMessages)).toBe(
      toCanonicalJson([
        {
          kind: "workflow-dispatch",
          payload: {
            cadenceMinutes: 5,
            scheduleWindowEnd: "2026-06-06T00:10:00.000Z",
            scheduleWindowStart: "2026-06-06T00:05:00.000Z",
            scheduledAt: "2026-06-06T00:10:00.000Z",
            triggerKind: "scheduled",
            workflowId: "wf_schedule_alpha",
            workflowVersionId: "wf_schedule_alpha:v1"
          },
          workspaceId: "ws_demo"
        },
        {
          kind: "workflow-dispatch",
          payload: {
            cadenceMinutes: 10,
            scheduleWindowEnd: "2026-06-06T00:10:00.000Z",
            scheduleWindowStart: "2026-06-06T00:00:00.000Z",
            scheduledAt: "2026-06-06T00:10:00.000Z",
            triggerKind: "scheduled",
            workflowId: "wf_schedule_beta",
            workflowVersionId: "wf_schedule_beta:v1"
          },
          workspaceId: "ws_demo"
        }
      ])
    );
  });

  it("replays accepted command fixtures without mutating receipts or canonical outputs", async () => {
    expect(invariantReplayScenarioIds.length).toBeGreaterThan(0);

    for (const scenarioId of invariantReplayScenarioIds) {
      const fixture = loadCommandFixture(scenarioId);
      const eventLedger = new InMemoryEventLedger(fixture.meta.logicalStartTime);
      const commandBus = createCommandBus({
        eventLedger,
        fieldTypeRegistry,
        permissionEngine: createPermissionEngine(),
        workflowOperatorRegistry,
        idFactory(prefix) {
          return `${prefix}_0001`;
        },
        now() {
          return fixture.meta.logicalStartTime;
        }
      });

      const firstResult = await commandBus.execute(fixture.command);
      const replayResult = await commandBus.execute(fixture.command);
      const scopeKey = scopeKeyForCommand(fixture.command);

      expect(firstResult.accepted, scenarioId).toBe(true);
      expect(replayResult.accepted, scenarioId).toBe(true);
      expect(replayResult.diagnostics, scenarioId).toEqual(["idempotent_replay"]);
      expect(toCanonicalJson(replayResult.events), scenarioId).toBe(
        toCanonicalJson(firstResult.events)
      );
      expect(toCanonicalJson(replayResult.sideEffects), scenarioId).toBe(
        toCanonicalJson(firstResult.sideEffects)
      );
      expect(toCanonicalJson(replayResult.permission), scenarioId).toBe(
        toCanonicalJson(firstResult.permission)
      );
      expect(eventLedger.snapshotReceipts(scopeKey), scenarioId).toHaveLength(1);
    }
  });

  it("isolates shared idempotency keys across table and workflow scope receipts", async () => {
    const eventLedger = new InMemoryEventLedger(logicalTime);
    const commandBus = createInvariantCommandBus(eventLedger);

    const tableCommand: CommandEnvelope = {
      actor: {
        mode: "user",
        principalId: "usr_alice"
      },
      commandId: "cmd_table_scope_001",
      commandType: "record.create",
      idempotencyKey: "idem_shared_001",
      payload: {
        recordId: "rec_scope_1"
      },
      scope: "table",
      tableId: "tbl_demo",
      workspaceId: "ws_demo"
    };
    const workflowCommand: CommandEnvelope = {
      actor: {
        mode: "user",
        principalId: "usr_alice"
      },
      commandId: "cmd_workflow_scope_001",
      commandType: "workflow.pause",
      idempotencyKey: "idem_shared_001",
      payload: {
        workflowId: "wf_scope_1"
      },
      scope: "workflow",
      workspaceId: "ws_demo"
    };

    const tableResult = await commandBus.execute(tableCommand);
    const workflowResult = await commandBus.execute(workflowCommand);

    expect(tableResult.accepted).toBe(true);
    expect(workflowResult.accepted).toBe(true);

    const tableReceipts = eventLedger.snapshotReceipts(scopeKeyForCommand(tableCommand));
    const workflowReceipts = eventLedger.snapshotReceipts(scopeKeyForCommand(workflowCommand));

    expect(tableReceipts).toHaveLength(1);
    expect(workflowReceipts).toHaveLength(1);
    expect(tableReceipts[0]?.idempotencyKey).toBe("idem_shared_001");
    expect(workflowReceipts[0]?.idempotencyKey).toBe("idem_shared_001");
    expect(tableReceipts[0]?.payloadHash).not.toBe(workflowReceipts[0]?.payloadHash);
  });
});
