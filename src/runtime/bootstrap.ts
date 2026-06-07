import { createAgentToolRegistry } from "../core/agent-tools/registry";
import { createCommandBus } from "../core/commands/command-bus";
import { createEventLedger } from "../core/events/event-ledger";
import { createFieldTypeRegistry } from "../core/field-types/registry";
import { createPermissionEngine } from "../core/permissions/engine";
import { createViewPlanner } from "../core/views/planner";
import { createWorkflowOperatorRegistry } from "../core/workflows/operator-registry";
import type { EffectivePermissionSnapshot } from "../core/permissions/types";
import type { CloudTableEnv } from "./env";
import { createWorkspaceInspector } from "./workspace-inspector";

export type CloudTableRuntime = {
  commandBus: ReturnType<typeof createCommandBus>;
  eventLedger: ReturnType<typeof createEventLedger>;
  fieldTypeRegistry: ReturnType<typeof createFieldTypeRegistry>;
  permissionEngine: ReturnType<typeof createPermissionEngine>;
  workflowOperatorRegistry: ReturnType<typeof createWorkflowOperatorRegistry>;
  viewPlanner: ReturnType<typeof createViewPlanner>;
  agentToolRegistry: ReturnType<typeof createAgentToolRegistry>;
};

export function createRuntime(env: CloudTableEnv): CloudTableRuntime {
  const fieldTypeRegistry = createFieldTypeRegistry();
  const workflowOperatorRegistry = createWorkflowOperatorRegistry();
  const permissionEngine = createPermissionEngine(fieldTypeRegistry);
  const eventLedger = createEventLedger(env.DB, fieldTypeRegistry);
  const commandBus = createCommandBus({
    eventLedger,
    fieldTypeRegistry,
    permissionEngine,
    workflowOperatorRegistry
  });
  const viewPlanner = createViewPlanner(fieldTypeRegistry, permissionEngine);
  const workspaceInspector = createWorkspaceInspector(
    env.DB,
    fieldTypeRegistry,
    workflowOperatorRegistry
  );
  const agentToolRegistry = createAgentToolRegistry({
    commandBus,
    permissionEngine,
    viewPlanner,
    workflowOperatorRegistry,
    workspaceInspector
  });

  return {
    agentToolRegistry,
    commandBus,
    eventLedger,
    fieldTypeRegistry,
    permissionEngine,
    viewPlanner,
    workflowOperatorRegistry
  };
}

export function createRuntimeWithSnapshot(
  env: CloudTableEnv,
  snapshot?: EffectivePermissionSnapshot
): CloudTableRuntime {
  const fieldTypeRegistry = createFieldTypeRegistry();
  const workflowOperatorRegistry = createWorkflowOperatorRegistry();
  const permissionEngine = createPermissionEngine(fieldTypeRegistry, {
    snapshot
  });
  const eventLedger = createEventLedger(env.DB, fieldTypeRegistry);
  const commandBus = createCommandBus({
    eventLedger,
    fieldTypeRegistry,
    permissionEngine,
    workflowOperatorRegistry
  });
  const viewPlanner = createViewPlanner(fieldTypeRegistry, permissionEngine);
  const workspaceInspector = createWorkspaceInspector(
    env.DB,
    fieldTypeRegistry,
    workflowOperatorRegistry
  );
  const agentToolRegistry = createAgentToolRegistry({
    commandBus,
    permissionEngine,
    viewPlanner,
    workflowOperatorRegistry,
    workspaceInspector
  });

  return {
    agentToolRegistry,
    commandBus,
    eventLedger,
    fieldTypeRegistry,
    permissionEngine,
    viewPlanner,
    workflowOperatorRegistry
  };
}
