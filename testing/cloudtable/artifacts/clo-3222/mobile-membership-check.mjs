import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.CLOUDTABLE_STUDIO_URL ?? "http://127.0.0.1:8788/studio";
const outputDir = path.resolve("testing/cloudtable/artifacts/clo-3222");
await mkdir(outputDir, { recursive: true });

const session = {
  activeOrganization: { id: "org_1", name: "Acme Data", slug: "acme-data" },
  activeWorkspaceId: "ws_1",
  memberships: [
    {
      organization: { name: "Acme Data", slug: "acme-data" },
      userEmail: "owner@example.com",
      workspace: { name: "Revenue Ops", slug: "revenue-ops" },
      workspaceId: "ws_1",
      workspaceRoleKey: "workspace.admin"
    }
  ],
  workspaceMembership: {
    principalId: "usr_admin",
    userEmail: "owner@example.com",
    workspaceId: "ws_1",
    workspaceRoleKey: "workspace.admin"
  }
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
          views: [{ viewId: "view_pipeline", name: "Pipeline" }]
        }
      ]
    }
  ],
  tables: []
};

const schema = {
  actions: [],
  fields: [{ fieldId: "fld_name", fieldKey: "name", fieldType: "text", label: "Name" }],
  table: { name: "Accounts", tableId: "tbl_accounts" },
  views: [{ viewId: "view_pipeline", name: "Pipeline" }]
};

const browser = await chromium.launch();

try {
  const results = [];
  for (const viewport of [
    { height: 844, name: "mobile", width: 390 },
    { height: 1000, name: "desktop", width: 1440 }
  ]) {
    const page = await browser.newPage({ viewport });
    await page.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    const method = request.method();

    if (method === "GET" && pathname === "/v1/auth/session") return route.fulfill({ json: session });
    if (method === "GET" && pathname === "/v1/tenants") return route.fulfill({ json: { tenants: session.memberships } });
    if (method === "GET" && pathname.endsWith("/catalog")) return route.fulfill({ json: catalog });
    if (method === "GET" && pathname.endsWith("/field-types")) return route.fulfill({ json: { fieldTypes: [] } });
    if (method === "GET" && pathname.endsWith("/agent-tools")) return route.fulfill({ json: { agentTools: [] } });
    if (method === "GET" && pathname === "/v1/tables/tbl_accounts/schema") return route.fulfill({ json: schema });
    if (method === "GET" && pathname.endsWith("/definition")) {
      return route.fulfill({
        json: {
          definition: { name: "Pipeline", visibleFieldIds: ["fld_name"] },
          view: { name: "Pipeline", viewId: "view_pipeline" }
        }
      });
    }
    if (method === "GET" && pathname.includes("/views/")) {
      return route.fulfill({
        json: {
          fields: schema.fields,
          rows: [{ fields: { name: "Globex" }, recordId: "rec_1", surface: { states: { fld_name: { readState: "visible", write: true } } } }]
        }
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

    return route.fulfill({ status: 404, json: { message: `No mock for ${method} ${pathname}` } });
    });

    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Pipeline" }).waitFor();
    await page.getByRole("button", { name: "Load members" }).click();
    await page.getByText("analyst@example.com").waitFor();

    const screenshot = path.join(outputDir, `${viewport.name}-membership-fixed.png`);
    await page.screenshot({ fullPage: true, path: screenshot });

    const rows = await page.locator(".member-row").evaluateAll((elements) => elements.map((element) => {
    const email = element.querySelector("b").getBoundingClientRect();
    const role = element.querySelector("span").getBoundingClientRect();
    return {
      email: { bottom: email.bottom, left: email.left, right: email.right, top: email.top },
      role: { bottom: role.bottom, left: role.left, right: role.right, top: role.top },
      overlaps: !(email.right <= role.left || role.right <= email.left || email.bottom <= role.top || role.bottom <= email.top)
    };
    }));

    if (rows.some((row) => row.overlaps)) {
      throw new Error(`Membership email and role boxes overlap at ${viewport.width}x${viewport.height}`);
    }

    results.push({ rows, screenshot, viewport });
    await page.close();
  }

  const evidencePath = path.join(outputDir, "mobile-membership-evidence.json");
  await writeFile(evidencePath, JSON.stringify({ baseUrl, results }, null, 2) + "\n");
  console.log(JSON.stringify({ evidencePath, results }, null, 2));
} finally {
  await browser.close();
}
