import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const wranglerConfigPath = path.join(repoRoot, "wrangler.jsonc");

const EXPECTED_QUEUE_BINDINGS = [
  { binding: "EVENT_FANOUT_QUEUE", queue: "cloudtable-event-fanout" },
  { binding: "WORKFLOW_DISPATCH_QUEUE", queue: "cloudtable-workflow-dispatch" },
  { binding: "WORKFLOW_STEP_QUEUE", queue: "cloudtable-workflow-step" },
  { binding: "PROJECTION_MAINTENANCE_QUEUE", queue: "cloudtable-projection-maintenance" },
  { binding: "DEAD_LETTER_REPROCESSOR_QUEUE", queue: "cloudtable-dead-letter-reprocessor" }
];

const EXPECTED_DURABLE_OBJECTS = [
  { name: "WORKSPACE_CONTROL_DO", class_name: "WorkspaceControlDurableObject" },
  { name: "TABLE_COORDINATOR_DO", class_name: "TableCoordinatorDurableObject" }
];

const findings = [];

function addFinding(level, summary, detail) {
  findings.push({ detail, level, summary });
}

function stripJsonComments(input) {
  let output = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const current = input[index];
    const next = input[index + 1];

    if (inString) {
      output += current;
      if (escaped) {
        escaped = false;
      } else if (current === "\\") {
        escaped = true;
      } else if (current === "\"") {
        inString = false;
      }
      continue;
    }

    if (current === "\"") {
      inString = true;
      output += current;
      continue;
    }

    if (current === "/" && next === "/") {
      while (index < input.length && input[index] !== "\n") {
        index += 1;
      }
      output += "\n";
      continue;
    }

    if (current === "/" && next === "*") {
      index += 2;
      while (index < input.length && !(input[index] === "*" && input[index + 1] === "/")) {
        index += 1;
      }
      index += 1;
      continue;
    }

    output += current;
  }

  return output;
}

function readWranglerConfig() {
  const raw = readFileSync(wranglerConfigPath, "utf8");
  return JSON.parse(stripJsonComments(raw));
}

function runWrangler(args) {
  try {
    const stdout = execFileSync("npx", ["wrangler", ...args], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    return { ok: true, output: stdout.trim() };
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";

    return {
      ok: false,
      output: [stdout, stderr].filter(Boolean).join("\n")
    };
  }
}

function validateD1(config) {
  const databases = Array.isArray(config.d1_databases) ? config.d1_databases : [];
  const binding = databases.find((entry) => entry.binding === "DB");

  if (!binding) {
    addFinding("error", "Missing D1 binding `DB`.", "wrangler.jsonc must declare `d1_databases[].binding = DB`.");
    return;
  }

  if (!binding.database_name) {
    addFinding("error", "D1 binding `DB` has no database_name.", "Set a stable remote database name before running remote migrations.");
  } else {
    addFinding("pass", "D1 binding name is present.", `Configured database name: ${binding.database_name}.`);
  }

  if (!binding.database_id || String(binding.database_id).includes("replace-in-cloudflare")) {
    addFinding(
      "error",
      "D1 binding `DB` still uses a placeholder database_id.",
      "Run `wrangler d1 create cloudtable`, then copy the returned UUID into wrangler.jsonc."
    );
  } else {
    addFinding("pass", "D1 binding has a concrete database_id.", `Configured database_id: ${binding.database_id}.`);
  }
}

function validateDurableObjects(config) {
  const bindings = config.durable_objects?.bindings ?? [];
  const migrations = Array.isArray(config.migrations) ? config.migrations : [];
  const migratedClasses = new Set(
    migrations.flatMap((migration) => migration.new_sqlite_classes ?? [])
  );

  for (const expected of EXPECTED_DURABLE_OBJECTS) {
    const found = bindings.find(
      (binding) =>
        binding.name === expected.name && binding.class_name === expected.class_name
    );

    if (!found) {
      addFinding(
        "error",
        `Durable Object binding ${expected.name} -> ${expected.class_name} is missing.`,
        "Remote deploys require both configured bindings and matching migrated class names."
      );
      continue;
    }

    if (!migratedClasses.has(expected.class_name)) {
      addFinding(
        "error",
        `Durable Object class ${expected.class_name} is not covered by wrangler migrations.`,
        "Add the class to a migration tag before deploying remotely."
      );
      continue;
    }

    addFinding(
      "pass",
      `Durable Object binding ${expected.name} is migration-backed.`,
      `Found ${expected.class_name} in both bindings and migration tags.`
    );
  }
}

function validateQueues(config) {
  const producers = config.queues?.producers ?? [];
  const consumers = config.queues?.consumers ?? [];
  const consumerNames = new Set(consumers.map((entry) => entry.queue));

  for (const expected of EXPECTED_QUEUE_BINDINGS) {
    const producer = producers.find(
      (entry) => entry.binding === expected.binding && entry.queue === expected.queue
    );

    if (!producer) {
      addFinding(
        "error",
        `Queue producer ${expected.binding} -> ${expected.queue} is missing.`,
        "Every runtime queue binding must be declared in wrangler.jsonc."
      );
      continue;
    }

    if (!consumerNames.has(expected.queue)) {
      addFinding(
        "error",
        `Queue consumer for ${expected.queue} is missing.`,
        "Remote delivery validation expects each declared producer queue to also be consumable."
      );
      continue;
    }

    addFinding(
      "pass",
      `Queue ${expected.queue} is declared for both producer and consumer paths.`,
      `Binding: ${expected.binding}.`
    );
  }
}

function validateCron(config) {
  const crons = config.triggers?.crons ?? [];
  if (!Array.isArray(crons) || crons.length === 0) {
    addFinding("error", "No cron triggers are declared.", "CloudTable expects at least one cron schedule in wrangler.jsonc.");
    return;
  }

  addFinding("pass", "Cron triggers are declared.", `Configured schedules: ${crons.join(", ")}.`);
}

function validateR2(config) {
  const buckets = Array.isArray(config.r2_buckets) ? config.r2_buckets : [];
  const bucket = buckets.find((entry) => entry.binding === "ARTIFACTS_BUCKET");

  if (!bucket) {
    addFinding(
      "error",
      "R2 binding `ARTIFACTS_BUCKET` is missing.",
      "Remote snapshot and artifact validation requires an R2 bucket binding."
    );
    return;
  }

  if (!bucket.bucket_name) {
    addFinding("error", "R2 binding `ARTIFACTS_BUCKET` has no bucket_name.", "Set a concrete bucket name before remote deploy.");
    return;
  }

  addFinding("pass", "R2 bucket binding is declared.", `Configured bucket name: ${bucket.bucket_name}.`);
}

function validateDeployDryRun() {
  const result = runWrangler(["deploy", "--dry-run"]);
  if (!result.ok) {
    addFinding("error", "Wrangler deploy dry-run failed.", result.output || "No output captured from Wrangler.");
    return;
  }

  addFinding(
    "pass",
    "Wrangler deploy dry-run bundled successfully.",
    "The worker compiles and Wrangler resolves the declared bindings without uploading."
  );
}

function validateAuth() {
  const result = runWrangler(["whoami"]);
  if (!result.ok || result.output.includes("You are not authenticated")) {
    addFinding(
      "error",
      "Wrangler is not authenticated for remote account checks.",
      "Run `wrangler login` or provide account-scoped Cloudflare credentials before attempting remote migration/deploy."
    );
    return;
  }

  addFinding("pass", "Wrangler authentication is available.", result.output);
}

function printFindings() {
  const order = { error: 0, warning: 1, pass: 2 };
  findings.sort((left, right) => order[left.level] - order[right.level]);

  for (const finding of findings) {
    const prefix =
      finding.level === "error" ? "[error]" : finding.level === "warning" ? "[warn]" : "[pass]";
    console.log(`${prefix} ${finding.summary}`);
    if (finding.detail) {
      console.log(`        ${finding.detail}`);
    }
  }
}

function printNextSteps(hasErrors) {
  console.log("");
  console.log("Remote validation sequence:");
  console.log("  1. npx wrangler d1 create cloudtable");
  console.log("  2. Update wrangler.jsonc with the returned D1 database_id.");
  console.log("  3. npx wrangler queues create cloudtable-event-fanout");
  console.log("  4. npx wrangler queues create cloudtable-workflow-dispatch");
  console.log("  5. npx wrangler queues create cloudtable-workflow-step");
  console.log("  6. npx wrangler queues create cloudtable-projection-maintenance");
  console.log("  7. npx wrangler queues create cloudtable-dead-letter-reprocessor");
  console.log("  8. npx wrangler r2 bucket create cloudtable-artifacts");
  console.log("  9. npm run d1:migrate:remote");
  console.log("  10. npx wrangler deploy");
  console.log("  11. curl https://<deployed-worker-host>/healthz");
  console.log("");
  console.log(
    hasErrors
      ? "Preflight is blocked until the errors above are resolved."
      : "Preflight passed. The config is ready for account-backed remote validation."
  );
}

const config = readWranglerConfig();

validateD1(config);
validateDurableObjects(config);
validateQueues(config);
validateCron(config);
validateR2(config);
validateDeployDryRun();
validateAuth();

printFindings();

const hasErrors = findings.some((finding) => finding.level === "error");
printNextSteps(hasErrors);

process.exitCode = hasErrors ? 1 : 0;
