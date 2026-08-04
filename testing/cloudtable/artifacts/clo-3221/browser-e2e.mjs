import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.CLOUDTABLE_STUDIO_URL ?? "http://127.0.0.1:8788/studio";
const outputDir = path.resolve("testing/cloudtable/artifacts/clo-3221");
await mkdir(outputDir, { recursive: true });

const evidence = {
  baseUrl,
  generatedAt: new Date().toISOString(),
  routes: [],
  viewports: [],
  observations: []
};

const session = (workspaceId = "ws_1") => ({
  activeOrganization: {
    id: workspaceId === "ws_1" ? "org_1" : "org_2",
    name: workspaceId === "ws_1" ? "Acme Data" : "Beta Labs",
    slug: workspaceId === "ws_1" ? "acme-data" : "beta-labs"
  },
  activeWorkspaceId: workspaceId,
  activeWorkspaceMembership: {
    principalId: "usr_admin",
    userEmail: "owner@example.com",
    userId: "user_admin",
    workspaceId,
    workspaceRoleKey: "workspace.admin"
  },
  memberships: [
    {
      organizationId: "org_1",
      organization: { name: "Acme Data", slug: "acme-data" },
      principalId: "usr_admin",
      userEmail: "owner@example.com",
      userId: "user_admin",
      workspace: { name: "Revenue Ops", slug: "revenue-ops" },
      workspaceId: "ws_1",
      workspaceRoleKey: "workspace.admin"
    },
    {
      organizationId: "org_2",
      organization: { name: "Beta Labs", slug: "beta-labs" },
      principalId: "usr_admin_beta",
      userEmail: "owner@example.com",
      userId: "user_admin",
      workspace: { name: "Pilot CRM", slug: "pilot-crm" },
      workspaceId: "ws_2",
      workspaceRoleKey: "workspace.member"
    }
  ],
  session: {
    activeWorkspaceId: workspaceId,
    userEmail: "owner@example.com",
    userId: "user_admin"
  },
  workspaceMembership: {
    principalId: workspaceId === "ws_1" ? "usr_admin" : "usr_admin_beta",
    userEmail: "owner@example.com",
    userId: "user_admin",
    workspaceId,
    workspaceRoleKey: workspaceId === "ws_1" ? "workspace.admin" : "workspace.member"
  }
});

const tenants = {
  tenants: session("ws_1").memberships
};

const catalog = {
  apps: [
    {
      appId: "app_sales",
      name: "Sales",
      tables: [
        {
          tableId: "tbl_accounts",
          name: "Accounts",
          views: [
            { viewId: "view_pipeline", name: "Pipeline" },
            { viewId: "view_denied", name: "Denied view" }
          ]
        },
        {
          tableId: "tbl_contacts",
          name: "Contacts",
          views: [{ viewId: "view_contacts", name: "All contacts" }]
        }
      ]
    }
  ],
  tables: []
};

const fieldTypes = {
  fieldTypes: [
    { label: "Text", type: "text" },
    { label: "Status", type: "status" },
    { label: "Currency", type: "number" }
  ]
};

const agentTools = {
  agentTools: [
    { id: "record.create", label: "Create record" },
    { id: "cell.update", label: "Update cell" }
  ]
};

const schema = {
  actions: [{ commandType: "record.create", enabled: true }],
  fields: [
    { fieldId: "fld_name", fieldKey: "name", fieldType: "text", label: "Name" },
    {
      config: { options: [{ id: "active", label: "Active" }, { id: "paused", label: "Paused" }] },
      fieldId: "fld_status",
      fieldKey: "status",
      fieldType: "status",
      label: "Status"
    },
    { fieldId: "fld_secret", fieldKey: "secret", fieldType: "text", label: "Internal note" },
    { fieldId: "fld_revenue", fieldKey: "revenue", fieldType: "number", label: "Revenue" }
  ],
  permissionScope: {
    permissionsVersion: 42,
    principalId: "usr_admin",
    scopeHash: "scope:view:view_pipeline"
  },
  table: { name: "Accounts", tableId: "tbl_accounts" },
  views: [
    { viewId: "view_pipeline", name: "Pipeline" },
    { viewId: "view_denied", name: "Denied view" }
  ]
};

let accountName = "Globex";

function viewDefinition(viewId) {
  return {
    definition: {
      name: viewId === "view_denied" ? "Denied view" : "Pipeline",
      visibleFieldIds: ["fld_name", "fld_status", "fld_secret", "fld_revenue"]
    },
    permissionScope: {
      permissionsVersion: 42,
      principalId: "usr_admin",
      scopeHash: `scope:view:${viewId}`
    },
    view: { name: viewId === "view_denied" ? "Denied view" : "Pipeline", viewId }
  };
}

function viewRows(viewId) {
  if (viewId === "view_denied") {
    return {
      permission: { allowed: false },
      rows: [],
      surface: { denied: true }
    };
  }
  return {
    actions: [{ commandType: "record.create", enabled: true }],
    fields: schema.fields,
    permissionScope: {
      permissionsVersion: 42,
      principalId: "usr_admin",
      scopeHash: "scope:view:view_pipeline"
    },
    rows: [
      {
        fields: {
          name: accountName,
          status: "active",
          secret: "board-only",
          revenue: 125000
        },
        recordId: "rec_1",
        surface: {
          hiddenFieldIds: ["fld_secret"],
          states: {
            fld_name: { readState: "visible", write: true },
            fld_status: { readState: "visible", write: false },
            fld_secret: { readState: "hidden", write: false },
            fld_revenue: { readState: "redacted", redacted: true, write: false }
          }
        }
      }
    ],
    surface: {
      actions: [{ commandType: "record.create", enabled: true }],
      hiddenFieldIds: ["fld_secret"]
    }
  };
}

function recordDetail() {
  return {
    projection: { fields: { name: accountName, status: "active", revenue: 125000 } },
    record: { id: "rec_1", tableId: "tbl_accounts" },
    surface: {
      states: {
        fld_name: { readState: "visible", write: true },
        fld_status: { readState: "visible", write: false },
        fld_secret: { readState: "hidden", write: false },
        fld_revenue: { readState: "redacted", redacted: true, write: false }
      }
    }
  };
}

async function installAuthenticatedRoutes(page) {
  await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();
    evidence.routes.push({ method, pathname, search: url.search });

    if (method === "GET" && pathname === "/v1/auth/session") return route.fulfill({ json: session("ws_1") });
    if (method === "GET" && pathname === "/v1/tenants") return route.fulfill({ json: tenants });
    if (method === "POST" && pathname === "/v1/auth/session/selection") return route.fulfill({ json: session("ws_2") });
    if (method === "GET" && pathname.endsWith("/catalog")) return route.fulfill({ json: catalog });
    if (method === "GET" && pathname.endsWith("/field-types")) return route.fulfill({ json: fieldTypes });
    if (method === "GET" && pathname.endsWith("/agent-tools")) return route.fulfill({ json: agentTools });
    if (method === "GET" && pathname === "/v1/tables/tbl_accounts/schema") return route.fulfill({ json: schema });
    if (method === "GET" && pathname.includes("/views/") && pathname.endsWith("/definition")) {
      return route.fulfill({ json: viewDefinition(pathname.split("/").at(-2)) });
    }
    if (method === "GET" && pathname.includes("/views/")) {
      return route.fulfill({ json: viewRows(pathname.split("/").at(-1)) });
    }
    if (method === "GET" && pathname.endsWith("/records/rec_1")) return route.fulfill({ json: recordDetail() });
    if (method === "GET" && pathname.endsWith("/records/rec_1/activity")) {
      return route.fulfill({
        json: { entries: [{ createdAt: "2026-08-04T14:00:00.000Z", eventType: "cell.updated" }] }
      });
    }
    if (method === "GET" && pathname.endsWith("/memberships")) {
      return route.fulfill({
        json: {
          memberships: [
            { userEmail: "owner@example.com", workspaceRoleKey: "workspace.admin" },
            { userEmail: "analyst@example.com", workspaceRoleKey: "workspace.member" }
          ]
        }
      });
    }
    if (method === "POST" && pathname.endsWith("/invitations")) return route.fulfill({ json: { invitationId: "inv_1" } });
    if (method === "POST" && pathname.endsWith("/records")) return route.fulfill({ json: { accepted: true } });
    if (method === "PUT" && pathname.includes("/cells/fld_name")) {
      const body = JSON.parse(request.postData() ?? "{}");
      accountName = body.payload?.value ?? accountName;
      return route.fulfill({ json: { accepted: true } });
    }

    return route.fulfill({ status: 404, json: { message: `No mock for ${method} ${pathname}` } });
  });
}

async function runUnauthenticated(browser, viewport, name) {
  const page = await browser.newPage({ viewport });
  const responses = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname === "/studio" || url.pathname === "/v1/auth/session") {
      responses.push({ status: response.status(), url: response.url() });
    }
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Continue with Google" }).waitFor();
  const screenshot = path.join(outputDir, `cloudtable-studio-${name}-unauth.png`);
  await page.screenshot({ fullPage: true, path: screenshot });
  evidence.viewports.push({ height: viewport.height, name: `${name}-unauth`, screenshot, width: viewport.width });
  evidence.observations.push({
    name: `${name} unauthenticated login`,
    responses,
    text: await page.locator("#app").innerText()
  });
  await page.close();
}

async function runAuthenticated(browser, viewport, name) {
  const page = await browser.newPage({ viewport });
  await installAuthenticatedRoutes(page);
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Pipeline" }).waitFor();

  await page.getByRole("combobox").selectOption("ws_2");
  await page.locator(".brand p", { hasText: "Beta Labs / Pilot CRM" }).waitFor();
  await page.getByRole("button", { name: /Accounts/ }).click();
  await page.getByRole("button", { name: /Pipeline/ }).click();
  await page.getByText("1 hidden").waitFor();
  await page.getByText("redacted").waitFor();

  await page.getByRole("button", { name: /Globex/ }).click();
  await page.locator("input.cell-editor[data-save-record='rec_1'][data-save-field='fld_name']").waitFor();
  await page.getByText("cell.updated").waitFor();

  const cellWritesBeforeFocusShift = evidence.routes.filter(
    (route) => route.method === "PUT" && route.pathname === "/v1/tables/tbl_accounts/records/rec_1/cells/fld_name"
  ).length;
  await page.getByRole("button", { name: "New" }).click();
  await page.getByText("Record create submitted").waitFor();
  const cellWritesAfterFocusShift = evidence.routes.filter(
    (route) => route.method === "PUT" && route.pathname === "/v1/tables/tbl_accounts/records/rec_1/cells/fld_name"
  ).length;
  if (cellWritesAfterFocusShift !== cellWritesBeforeFocusShift) {
    throw new Error(
      `${name} no-op inline edit focus shift emitted ${cellWritesAfterFocusShift - cellWritesBeforeFocusShift} unexpected fld_name cell PUT request(s)`
    );
  }
  evidence.observations.push({
    cellWritesAfterFocusShift,
    cellWritesBeforeFocusShift,
    name: `${name} no-op inline edit focus shift`,
    text: "No fld_name cell PUT emitted when opening the editor and moving focus without changing the value."
  });

  await page.getByRole("button", { name: "Load members" }).click();
  await page.getByText("analyst@example.com").waitFor();

  page.on("dialog", async (dialog) => dialog.accept("new.user@example.com"));
  await page.getByRole("button", { name: "Create invitation" }).click();
  await page.getByText("Invitation issued for new.user@example.com").waitFor();

  const pipelineScreenshot = path.join(outputDir, `cloudtable-studio-${name}-auth-pipeline.png`);
  await page.screenshot({ fullPage: true, path: pipelineScreenshot });
  evidence.viewports.push({
    height: viewport.height,
    name: `${name}-auth-pipeline`,
    screenshot: pipelineScreenshot,
    width: viewport.width
  });

  await page.getByRole("button", { name: /Denied view/ }).click();
  await page.getByText("Access denied").waitFor();

  const screenshot = path.join(outputDir, `cloudtable-studio-${name}-auth-denied.png`);
  await page.screenshot({ fullPage: true, path: screenshot });
  evidence.viewports.push({ height: viewport.height, name: `${name}-auth`, screenshot, width: viewport.width });
  evidence.observations.push({
    name: `${name} authenticated shell`,
    text: await page.locator("#app").innerText()
  });
  await page.close();
}

const browser = await chromium.launch();
try {
  await runUnauthenticated(browser, { width: 1440, height: 1000 }, "desktop");
  await runUnauthenticated(browser, { width: 390, height: 844 }, "mobile");
  await runAuthenticated(browser, { width: 1440, height: 1000 }, "desktop");
  await runAuthenticated(browser, { width: 390, height: 844 }, "mobile");
} finally {
  await browser.close();
}

const evidencePath = path.join(outputDir, "browser-e2e-evidence.json");
await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
console.log(JSON.stringify({ evidencePath, screenshots: evidence.viewports.map((item) => item.screenshot) }, null, 2));
