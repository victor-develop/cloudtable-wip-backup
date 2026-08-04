import { describe, expect, it } from "vitest";

import type { WorkflowDefinition } from "../../../../src/core/workflows/types";
import {
  deriveWorkflowDependencyEntries,
  readReactiveDependenciesForSourceEvent,
  workflowDependencyIndexStatements
} from "../../../../src/runtime/workflow-dependency-index";
import { seedWorkspace, SqliteD1Database } from "../../harness/runtime/sqlite-d1";

function createReactiveDefinition(): WorkflowDefinition {
  return {
    actions: [
      {
        input: {
          resolverAlias: "account_by_region",
          sourceFieldId: "fld_ticket_status",
          targetFieldId: "fld_account_synced_status"
        },
        operatorId: "sync_related_field"
      }
    ],
    conditions: [],
    metadata: {
      aggregateDefinitions: [
        {
          alias: "region_max_amount",
          dependencyFieldIds: ["fld_ticket_status"],
          groupingSource: {
            kind: "related_record",
            resolverAlias: "account_by_region"
          },
          operand: {
            fieldId: "fld_ticket_amount",
            kind: "source_field",
            valueType: "number"
          },
          operationId: "max_number",
          sourceRelationPath: "relatedTables.account_by_region",
          targetFieldId: "fld_account_max_amount"
        }
      ],
      lookupDefinitions: [
        {
          alias: "ticket_account_name",
          lookupSource: {
            kind: "related_record",
            resolverAlias: "account_relation"
          },
          sourceRelationPath: "relatedTables.account_relation",
          targetFieldId: "fld_ticket_account_name",
          valueFieldId: "fld_account_name"
        }
      ],
      relatedTableResolvers: [
        {
          alias: "account_by_region",
          sourceFieldId: "fld_ticket_region",
          strategy: "value_match",
          targetFieldId: "fld_account_region",
          targetTableId: "tbl_accounts"
        },
        {
          alias: "account_relation",
          sourceFieldId: "fld_ticket_account",
          strategy: "single_relation",
          targetTableId: "tbl_accounts"
        }
      ],
      status: "published",
      tableId: "tbl_tickets"
    },
    trigger: {
      match: {
        eventTypes: ["cell.set"],
        fieldIds: ["fld_ticket_amount", "fld_ticket_status"],
        tableId: "tbl_tickets"
      },
      operatorId: "field_changed"
    },
    workflowId: "wf_region_rollup_lookup_sync"
  };
}

describe("workflow dependency index", () => {
  it("derives multi-field trigger and reactive dependency entries from published workflow metadata", () => {
    const entries = deriveWorkflowDependencyEntries(createReactiveDefinition());

    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alias: "field_changed",
          dependencyFieldIds: ["fld_ticket_amount", "fld_ticket_status"],
          kind: "trigger",
          triggerTableId: "tbl_tickets"
        }),
        expect.objectContaining({
          alias: "region_max_amount",
          dependencyFieldIds: ["fld_ticket_region", "fld_ticket_amount", "fld_ticket_status"],
          kind: "aggregate",
          sourceTableId: "tbl_tickets",
          targetTableId: "tbl_accounts"
        }),
        expect.objectContaining({
          alias: "ticket_account_name",
          dependencyFieldIds: ["fld_ticket_account"],
          kind: "lookup",
          sourceTableId: "tbl_tickets",
          targetTableId: "tbl_accounts"
        }),
        expect.objectContaining({
          alias: "account_by_region:fld_ticket_status:fld_account_synced_status",
          dependencyFieldIds: ["fld_ticket_region", "fld_ticket_status"],
          kind: "sync",
          sourceTableId: "tbl_tickets",
          targetTableId: "tbl_accounts"
        })
      ])
    );
  });

  it("routes persisted aggregate, lookup, and sync dependencies from source and target table changes", async () => {
    const db = new SqliteD1Database();
    const definition = createReactiveDefinition();

    seedWorkspace(db);
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
        definition.workflowId,
        "ws_1",
        "region-rollup-lookup-sync",
        "Region rollup lookup sync",
        1,
        "2026-07-21T00:00:00.000Z",
        "2026-07-21T00:00:00.000Z",
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
        "wf_region_rollup_lookup_sync:v1",
        "ws_1",
        definition.workflowId,
        1,
        JSON.stringify(definition),
        "2026-07-21T00:00:00.000Z",
        null
      );

    await db.batch(
      workflowDependencyIndexStatements(db as unknown as D1Database, {
        definition,
        now: "2026-07-21T00:00:00.000Z",
        workflowId: "wf_region_rollup_lookup_sync",
        workflowVersionId: "wf_region_rollup_lookup_sync:v1",
        workspaceId: "ws_1"
      }) as never
    );

    await expect(
      readReactiveDependenciesForSourceEvent(db as unknown as D1Database, {
        changedFieldIds: ["fld_ticket_amount"],
        sourceTableId: "tbl_tickets",
        workspaceId: "ws_1"
      })
    ).resolves.toEqual([
      expect.objectContaining({
        aggregate: expect.objectContaining({
          alias: "region_max_amount"
        })
      })
    ]);

    await expect(
      readReactiveDependenciesForSourceEvent(db as unknown as D1Database, {
        changedFieldIds: ["fld_ticket_account"],
        sourceTableId: "tbl_tickets",
        workspaceId: "ws_1"
      })
    ).resolves.toEqual([
      expect.objectContaining({
        lookup: expect.objectContaining({
          alias: "ticket_account_name"
        })
      })
    ]);

    await expect(
      readReactiveDependenciesForSourceEvent(db as unknown as D1Database, {
        changedFieldIds: ["fld_ticket_status"],
        sourceTableId: "tbl_tickets",
        workspaceId: "ws_1"
      })
    ).resolves.toEqual([
      expect.objectContaining({
        aggregate: expect.objectContaining({
          alias: "region_max_amount"
        })
      }),
      expect.objectContaining({
        sync: expect.objectContaining({
          alias: "account_by_region:fld_ticket_status:fld_account_synced_status"
        })
      })
    ]);

    await expect(
      readReactiveDependenciesForSourceEvent(db as unknown as D1Database, {
        changedFieldIds: ["fld_account_region"],
        sourceTableId: "tbl_accounts",
        workspaceId: "ws_1"
      })
    ).resolves.toEqual([
      expect.objectContaining({
        aggregate: expect.objectContaining({
          alias: "region_max_amount"
        })
      }),
      expect.objectContaining({
        sync: expect.objectContaining({
          alias: "account_by_region:fld_ticket_status:fld_account_synced_status"
        })
      })
    ]);

    await expect(
      readReactiveDependenciesForSourceEvent(db as unknown as D1Database, {
        changedFieldIds: ["fld_account_name"],
        sourceTableId: "tbl_accounts",
        workspaceId: "ws_1"
      })
    ).resolves.toEqual([
      expect.objectContaining({
        lookup: expect.objectContaining({
          alias: "ticket_account_name"
        })
      })
    ]);
  });
});
