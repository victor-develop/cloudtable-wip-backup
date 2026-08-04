export function renderStudioShell(): Response {
  return new Response(STUDIO_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

const STUDIO_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>CloudTable Studio</title>
    <style>
      :root {
        color-scheme: light;
        --bg: #f7f8fa;
        --panel: #ffffff;
        --line: #d9dee7;
        --line-strong: #b6bfcd;
        --text: #18202b;
        --muted: #5d6878;
        --accent: #0f766e;
        --accent-soft: #d9f5ef;
        --danger: #b42318;
        --warn: #8a5a00;
        --readonly: #eef1f5;
        --hidden: #f4e8ea;
        --shadow: 0 14px 38px rgba(24, 32, 43, 0.08);
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        background: var(--bg);
        color: var(--text);
      }

      button,
      input,
      select,
      textarea {
        font: inherit;
      }

      button {
        border: 1px solid var(--line-strong);
        background: var(--panel);
        color: var(--text);
        border-radius: 6px;
        min-height: 34px;
        padding: 0 10px;
        cursor: pointer;
      }

      button.primary {
        border-color: var(--accent);
        background: var(--accent);
        color: #fff;
      }

      button[disabled],
      input[disabled],
      textarea[disabled],
      select[disabled] {
        cursor: not-allowed;
        opacity: 0.62;
      }

      .studio {
        display: grid;
        grid-template-rows: 52px minmax(0, 1fr);
        min-height: 100vh;
      }

      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 0 16px;
        border-bottom: 1px solid var(--line);
        background: var(--panel);
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 10px;
        min-width: 0;
      }

      .mark {
        width: 28px;
        height: 28px;
        display: grid;
        place-items: center;
        border: 1px solid var(--line-strong);
        border-radius: 7px;
        background: #eef7f4;
        color: var(--accent);
        font-weight: 800;
      }

      .brand h1 {
        margin: 0;
        font-size: 15px;
        line-height: 1.2;
      }

      .brand p,
      .muted {
        margin: 0;
        color: var(--muted);
        font-size: 12px;
      }

      .top-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        min-width: 0;
      }

      .tenant-select {
        max-width: min(44vw, 360px);
      }

      .layout {
        display: grid;
        grid-template-columns: 260px minmax(0, 1fr) 340px;
        min-height: 0;
      }

      .sidebar,
      .detail {
        min-height: 0;
        overflow: auto;
        background: var(--panel);
      }

      .sidebar {
        border-right: 1px solid var(--line);
        padding: 12px;
      }

      .detail {
        border-left: 1px solid var(--line);
        padding: 14px;
      }

      .main {
        min-width: 0;
        min-height: 0;
        display: grid;
        grid-template-rows: auto minmax(0, 1fr);
      }

      .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 12px 14px;
        border-bottom: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.78);
      }

      .toolbar h2,
      .panel-title {
        margin: 0;
        font-size: 15px;
      }

      .toolbar-actions {
        display: flex;
        gap: 8px;
        align-items: center;
      }

      .nav-section {
        margin-bottom: 16px;
      }

      .nav-section h2 {
        margin: 0 0 8px;
        color: var(--muted);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
      }

      .nav-item {
        width: 100%;
        display: flex;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 6px;
        text-align: left;
        border-color: transparent;
      }

      .nav-item.active {
        border-color: var(--accent);
        background: var(--accent-soft);
      }

      .badge {
        display: inline-flex;
        align-items: center;
        min-height: 20px;
        padding: 0 7px;
        border-radius: 999px;
        background: #eef1f5;
        color: var(--muted);
        font-size: 11px;
        white-space: nowrap;
      }

      .badge.danger {
        background: var(--hidden);
        color: var(--danger);
      }

      .badge.warn {
        background: #fff3cf;
        color: var(--warn);
      }

      .grid-wrap {
        min-height: 0;
        overflow: auto;
      }

      table {
        width: 100%;
        border-collapse: separate;
        border-spacing: 0;
        min-width: 720px;
      }

      th,
      td {
        border-bottom: 1px solid var(--line);
        border-right: 1px solid var(--line);
        padding: 0;
        vertical-align: top;
        background: var(--panel);
      }

      th {
        position: sticky;
        top: 0;
        z-index: 1;
        height: 38px;
        padding: 8px 10px;
        color: var(--muted);
        text-align: left;
        font-size: 12px;
        font-weight: 700;
        background: #fbfcfd;
      }

      td {
        height: 44px;
      }

      .cell-button,
      .cell-editor {
        width: 100%;
        min-height: 44px;
        border: 0;
        border-radius: 0;
        background: transparent;
        text-align: left;
        padding: 8px 10px;
      }

      .cell-button.readonly {
        background: var(--readonly);
      }

      .cell-button.hidden {
        background: var(--hidden);
        color: var(--danger);
      }

      .cell-editor {
        outline: 2px solid var(--accent);
        outline-offset: -2px;
      }

      .empty {
        display: grid;
        align-content: center;
        justify-items: center;
        gap: 8px;
        min-height: 240px;
        padding: 24px;
        color: var(--muted);
        text-align: center;
      }

      .panel {
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        margin-bottom: 12px;
        overflow: hidden;
      }

      .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid var(--line);
        background: #fbfcfd;
      }

      .panel-body {
        padding: 12px;
      }

      .kv {
        display: grid;
        grid-template-columns: 96px minmax(0, 1fr);
        gap: 8px;
        margin-bottom: 8px;
        font-size: 12px;
      }

      .kv b {
        color: var(--muted);
      }

      .member-list {
        display: grid;
        gap: 8px;
        margin-bottom: 8px;
      }

      .member-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        align-items: start;
        gap: 8px 12px;
        font-size: 12px;
      }

      .member-row b,
      .member-row span {
        min-width: 0;
        overflow-wrap: anywhere;
      }

      .member-row b {
        color: var(--muted);
      }

      .member-row span {
        justify-self: end;
        text-align: right;
      }

      .stack {
        display: grid;
        gap: 8px;
      }

      .field-input {
        width: 100%;
        min-height: 34px;
        border: 1px solid var(--line-strong);
        border-radius: 6px;
        padding: 6px 8px;
        background: #fff;
      }

      .activity {
        display: grid;
        gap: 8px;
        margin: 0;
        padding: 0;
        list-style: none;
      }

      .activity li {
        border: 1px solid var(--line);
        border-radius: 6px;
        padding: 8px;
      }

      .login {
        min-height: 100vh;
        display: grid;
        align-content: center;
        justify-items: center;
        gap: 16px;
        padding: 24px;
      }

      .login-box {
        width: min(420px, 100%);
        padding: 22px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel);
        box-shadow: var(--shadow);
      }

      .error {
        margin: 0;
        color: var(--danger);
        font-size: 12px;
      }

      @media (max-width: 980px) {
        .layout {
          grid-template-columns: 220px minmax(0, 1fr);
        }

        .detail {
          grid-column: 1 / -1;
          border-left: 0;
          border-top: 1px solid var(--line);
          max-height: 44vh;
        }
      }

      @media (max-width: 720px) {
        .studio {
          grid-template-rows: auto minmax(0, 1fr);
        }

        .topbar,
        .toolbar {
          align-items: stretch;
          flex-direction: column;
          padding: 10px;
        }

        .top-actions,
        .toolbar-actions {
          width: 100%;
          justify-content: stretch;
        }

        .top-actions > *,
        .toolbar-actions > * {
          flex: 1;
          min-width: 0;
        }

        .tenant-select {
          max-width: none;
        }

        .layout {
          grid-template-columns: 1fr;
        }

        .sidebar {
          border-right: 0;
          border-bottom: 1px solid var(--line);
          max-height: 34vh;
        }

        .grid-wrap {
          max-height: 58vh;
        }

        table {
          min-width: 620px;
        }

        .member-row {
          grid-template-columns: 1fr;
          gap: 3px;
        }

        .member-row span {
          justify-self: start;
          text-align: left;
        }
      }
    </style>
  </head>
  <body>
    <div id="app" class="login">
      <div class="login-box">
        <div class="brand">
          <div class="mark">C</div>
          <div>
            <h1>CloudTable Studio</h1>
            <p>Loading session</p>
          </div>
        </div>
      </div>
    </div>
    <script>
      const state = {
        session: null,
        tenants: [],
        catalog: null,
        fieldTypes: [],
        agentTools: [],
        workspaceId: null,
        principalId: null,
        appId: null,
        tableId: null,
        viewId: null,
        schema: null,
        viewDefinition: null,
        viewData: null,
        selectedRecordId: null,
        recordDetail: null,
        activity: [],
        memberships: [],
        editing: null,
        notice: ""
      };

      const app = document.getElementById("app");

      init().catch((error) => renderFatal(error));

      async function init() {
        const sessionResponse = await api("/v1/auth/session", { allowUnauthorized: true });
        if (!sessionResponse.ok) {
          renderLogin();
          return;
        }
        state.session = sessionResponse.body;
        state.workspaceId = state.session.activeWorkspaceId;
        state.principalId = state.session.workspaceMembership?.principalId ?? state.session.activeWorkspaceMembership?.principalId ?? null;
        await loadTenants();
        if (!state.workspaceId && state.tenants[0]) {
          await selectTenant(state.tenants[0].workspaceId);
          return;
        }
        await loadWorkspace();
      }

      async function loadTenants() {
        const tenants = await apiJson("/v1/tenants");
        state.tenants = tenants.tenants ?? [];
      }

      async function selectTenant(workspaceId) {
        const selection = await apiJson("/v1/auth/session/selection", {
          method: "POST",
          body: { workspaceId }
        });
        state.session = selection;
        state.workspaceId = selection.activeWorkspaceId;
        state.principalId = selection.workspaceMembership?.principalId ?? selection.activeWorkspaceMembership?.principalId ?? null;
        state.catalog = null;
        state.schema = null;
        state.viewData = null;
        state.selectedRecordId = null;
        await loadWorkspace();
      }

      async function loadWorkspace() {
        if (!state.workspaceId) {
          renderShell();
          return;
        }
        const [catalog, fieldTypes, agentTools] = await Promise.all([
          apiJson("/v1/workspaces/" + encodeURIComponent(state.workspaceId) + "/catalog"),
          apiJson("/v1/workspaces/" + encodeURIComponent(state.workspaceId) + "/field-types"),
          apiJson("/v1/workspaces/" + encodeURIComponent(state.workspaceId) + "/agent-tools")
        ]);
        state.catalog = catalog;
        state.fieldTypes = fieldTypes.fieldTypes ?? [];
        state.agentTools = agentTools.agentTools ?? [];
        const firstApp = (catalog.apps ?? [])[0] ?? null;
        const firstTable = firstApp?.tables?.[0] ?? (catalog.tables ?? [])[0] ?? null;
        state.appId = firstApp?.appId ?? firstApp?.id ?? null;
        state.tableId = state.tableId ?? firstTable?.tableId ?? firstTable?.id ?? null;
        const firstView = firstTable?.views?.[0] ?? null;
        state.viewId = state.viewId ?? firstView?.viewId ?? firstView?.id ?? null;
        await loadCurrentView();
      }

      async function loadCurrentView() {
        state.schema = null;
        state.viewDefinition = null;
        state.viewData = null;
        state.recordDetail = null;
        state.activity = [];
        if (!state.workspaceId || !state.tableId) {
          renderShell();
          return;
        }
        state.schema = await apiJson("/v1/tables/" + encodeURIComponent(state.tableId) + "/schema?workspaceId=" + encodeURIComponent(state.workspaceId));
        const viewId = state.viewId ?? state.schema.views?.[0]?.viewId ?? state.schema.views?.[0]?.id;
        state.viewId = viewId ?? null;
        if (state.viewId) {
          const suffix = "?workspaceId=" + encodeURIComponent(state.workspaceId);
          const [definition, rows] = await Promise.all([
            apiJson("/v1/tables/" + encodeURIComponent(state.tableId) + "/views/" + encodeURIComponent(state.viewId) + "/definition" + suffix),
            apiJson("/v1/tables/" + encodeURIComponent(state.tableId) + "/views/" + encodeURIComponent(state.viewId) + suffix)
          ]);
          state.viewDefinition = definition;
          state.viewData = rows;
        }
        renderShell();
      }

      async function loadRecord(recordId) {
        state.selectedRecordId = recordId;
        const suffix = "?workspaceId=" + encodeURIComponent(state.workspaceId);
        const [detail, activity] = await Promise.all([
          apiJson("/v1/tables/" + encodeURIComponent(state.tableId) + "/records/" + encodeURIComponent(recordId) + suffix),
          apiJson("/v1/tables/" + encodeURIComponent(state.tableId) + "/records/" + encodeURIComponent(recordId) + "/activity" + suffix).catch(() => ({ entries: [] }))
        ]);
        state.recordDetail = detail;
        state.activity = activity.entries ?? [];
        renderShell();
      }

      async function loadMemberships() {
        if (!state.workspaceId) return;
        const body = await apiJson("/v1/workspaces/" + encodeURIComponent(state.workspaceId) + "/memberships");
        state.memberships = body.memberships ?? [];
        renderShell();
      }

      async function createInvitation() {
        const email = prompt("Invite email");
        if (!email) return;
        await apiJson("/v1/workspaces/" + encodeURIComponent(state.workspaceId) + "/invitations", {
          method: "POST",
          body: {
            invitation: {
              email,
              roleKey: "workspace.member"
            }
          }
        });
        state.notice = "Invitation issued for " + email;
        renderShell();
      }

      async function createRecord() {
        if (!state.tableId) return;
        const commandId = "cmd_studio_record_" + Date.now();
        const recordId = "rec_studio_" + Date.now();
        await apiJson("/v1/tables/" + encodeURIComponent(state.tableId) + "/records", {
          method: "POST",
          body: {
            actor: { mode: "user", principalId: state.principalId },
            commandId,
            idempotencyKey: commandId,
            payload: { cells: {}, recordId },
            workspaceId: state.workspaceId
          }
        });
        state.notice = "Record create submitted";
        await loadCurrentView();
      }

      async function saveCell(recordId, field, value) {
        const commandId = "cmd_studio_cell_" + Date.now();
        await apiJson(
          "/v1/tables/" + encodeURIComponent(state.tableId) + "/records/" + encodeURIComponent(recordId) + "/cells/" + encodeURIComponent(field.fieldId),
          {
            method: "PUT",
            body: {
              actor: { mode: "user", principalId: state.principalId },
              commandId,
              idempotencyKey: commandId,
              payload: {
                fieldId: field.fieldId,
                recordId,
                value: coerceFieldValue(field, value)
              },
              workspaceId: state.workspaceId
            }
          }
        );
        state.editing = null;
        state.notice = "Cell update submitted";
        await loadCurrentView();
      }

      function renderLogin() {
        const loginUrl = "/v1/auth/google/login?redirectTo=" + encodeURIComponent(location.href);
        app.className = "login";
        app.innerHTML = '<div class="login-box stack">' +
          '<div class="brand"><div class="mark">C</div><div><h1>CloudTable Studio</h1><p>Sign in to choose a tenant and open a workspace.</p></div></div>' +
          '<button class="primary" onclick="location.href=' + JSON.stringify(loginUrl).replace(/"/g, "&quot;") + '">Continue with Google</button>' +
          '<p class="muted">Session state is read from /v1/auth/session and tenants from /v1/tenants.</p>' +
        '</div>';
      }

      function renderShell() {
        app.className = "studio";
        const tenantOptions = state.tenants.map((tenant) => {
          const label = escapeHtml(tenant.organization.name + " / " + tenant.workspace.name);
          return '<option value="' + escapeAttr(tenant.workspaceId) + '"' + (tenant.workspaceId === state.workspaceId ? " selected" : "") + '>' + label + '</option>';
        }).join("");
        app.innerHTML =
          '<header class="topbar">' +
            '<div class="brand"><div class="mark">C</div><div><h1>CloudTable Studio</h1><p>' + escapeHtml(activeTenantLabel()) + '</p></div></div>' +
            '<div class="top-actions">' +
              '<select class="field-input tenant-select" id="tenantPicker">' + tenantOptions + '</select>' +
              '<button id="refreshBtn" title="Refresh workspace">Refresh</button>' +
            '</div>' +
          '</header>' +
          '<div class="layout">' +
            '<aside class="sidebar">' + renderNavigation() + '</aside>' +
            '<main class="main">' + renderGrid() + '</main>' +
            '<aside class="detail">' + renderDetail() + '</aside>' +
          '</div>';
        bindShellEvents();
      }

      function renderNavigation() {
        if (!state.catalog) {
          return '<div class="empty">No workspace selected.</div>';
        }
        const apps = state.catalog.apps ?? [];
        const tables = flattenTables();
        return '<section class="nav-section"><h2>Apps</h2>' +
          (apps.length ? apps.map((item) => navButton("app", item.appId ?? item.id, item.name ?? item.label ?? "App")).join("") : '<p class="muted">No apps visible.</p>') +
          '</section><section class="nav-section"><h2>Tables and Views</h2>' +
          (tables.length ? tables.map(renderTableNav).join("") : '<p class="muted">No tables visible.</p>') +
          '</section>' +
          '<section class="nav-section"><h2>Access</h2>' +
            '<button class="nav-item" id="membershipsBtn"><span>Members</span><span class="badge">' + state.memberships.length + '</span></button>' +
            '<button class="nav-item" id="inviteBtn"><span>Invite</span><span class="badge">admin</span></button>' +
          '</section>';
      }

      function renderTableNav(table) {
        const tableId = table.tableId ?? table.id;
        const views = table.views ?? [];
        return '<div class="stack" style="margin-bottom:10px">' +
          '<button class="nav-item ' + (tableId === state.tableId && !state.viewId ? "active" : "") + '" data-table="' + escapeAttr(tableId) + '"><span>' + escapeHtml(table.name ?? table.label ?? tableId) + '</span><span class="badge">' + views.length + '</span></button>' +
          views.map((view) => {
            const viewId = view.viewId ?? view.id;
            return '<button class="nav-item ' + (viewId === state.viewId ? "active" : "") + '" data-table="' + escapeAttr(tableId) + '" data-view="' + escapeAttr(viewId) + '"><span>' + escapeHtml(view.name ?? view.label ?? viewId) + '</span><span class="badge">view</span></button>';
          }).join("") +
        '</div>';
      }

      function renderGrid() {
        const title = state.viewDefinition?.view?.name ?? state.viewDefinition?.definition?.name ?? state.schema?.table?.name ?? "Workspace";
        const rows = readRows();
        const fields = visibleFields();
        const denied = state.viewData?.surface?.denied === true || state.viewData?.permission?.allowed === false;
        const hiddenCount = countHiddenFields();
        return '<div class="toolbar">' +
          '<div><h2>' + escapeHtml(title) + '</h2><p class="muted">' + escapeHtml(permissionSummary()) + '</p></div>' +
          '<div class="toolbar-actions">' +
            (hiddenCount ? '<span class="badge danger">' + hiddenCount + ' hidden</span>' : '') +
            (denied ? '<span class="badge danger">denied</span>' : '') +
            '<button class="primary" id="createRecordBtn"' + (canCreate() ? "" : " disabled") + '>New</button>' +
          '</div>' +
        '</div>' +
        '<div class="grid-wrap">' +
          (denied ? '<div class="empty"><b>Access denied</b><span>The backend permission surface denied this view read.</span></div>' :
          rows.length && fields.length ? '<table><thead><tr>' + fields.map((field) => '<th>' + escapeHtml(field.label ?? field.fieldKey ?? field.fieldId) + fieldBadge(field) + '</th>').join("") + '</tr></thead><tbody>' + rows.map((row) => renderRow(row, fields)).join("") + '</tbody></table>' :
          '<div class="empty"><b>No visible records</b><span>Select another view or create a record if the action is available.</span></div>') +
        '</div>';
      }

      function renderRow(row, fields) {
        const recordId = row.recordId ?? row.id ?? row.record?.id;
        return '<tr>' + fields.map((field) => {
          const stateForField = fieldState(row, field);
          const value = rowValue(row, field);
          const editing = state.editing && state.editing.recordId === recordId && state.editing.fieldId === field.fieldId;
          if (editing) {
            return '<td>' + renderEditor(recordId, field, value) + '</td>';
          }
          const className = stateForField.readState === "hidden" ? "hidden" : stateForField.write === false ? "readonly" : "";
          const disabled = stateForField.write === false || stateForField.readState === "hidden" ? " disabled" : "";
          return '<td><button class="cell-button ' + className + '" data-record="' + escapeAttr(recordId) + '" data-field="' + escapeAttr(field.fieldId) + '"' + disabled + '>' + renderValue(value, stateForField) + '</button></td>';
        }).join("") + '</tr>';
      }

      function renderEditor(recordId, field, value) {
        const serialized = value == null ? "" : String(value);
        const editorData = ' data-save-record="' + escapeAttr(recordId) + '" data-save-field="' + escapeAttr(field.fieldId) + '" data-original-value="' + escapeAttr(serialized) + '"';
        const type = field.fieldType;
        if (type === "boolean" || type.includes("checkbox")) {
          const booleanValue = value === true ? "true" : "false";
          const booleanData = ' data-save-record="' + escapeAttr(recordId) + '" data-save-field="' + escapeAttr(field.fieldId) + '" data-original-value="' + escapeAttr(booleanValue) + '"';
          return '<select class="cell-editor"' + booleanData + '><option value="false">false</option><option value="true"' + (value === true ? " selected" : "") + '>true</option></select>';
        }
        if ((type.includes("select") || type.includes("status")) && Array.isArray(field.config?.options)) {
          return '<select class="cell-editor"' + editorData + '>' +
            '<option value=""></option>' +
            field.config.options.map((option) => {
              const optionValue = option.id ?? option.key ?? option.value ?? option.label;
              return '<option value="' + escapeAttr(optionValue) + '"' + (optionValue === value ? " selected" : "") + '>' + escapeHtml(option.label ?? optionValue) + '</option>';
            }).join("") +
          '</select>';
        }
        return '<input class="cell-editor"' + editorData + ' value="' + escapeAttr(serialized) + '" />';
      }

      function renderDetail() {
        const record = state.recordDetail?.record ?? null;
        return '<div class="panel"><div class="panel-header"><h2 class="panel-title">Record detail</h2>' + (state.selectedRecordId ? '<span class="badge">' + escapeHtml(state.selectedRecordId) + '</span>' : '') + '</div><div class="panel-body">' +
          (record ? renderRecordFields() : '<p class="muted">Select a row to inspect permission-filtered record data.</p>') +
          '</div></div>' +
          '<div class="panel"><div class="panel-header"><h2 class="panel-title">Activity</h2><span class="badge">' + state.activity.length + '</span></div><div class="panel-body">' + renderActivity() + '</div></div>' +
          '<div class="panel"><div class="panel-header"><h2 class="panel-title">Invitations and members</h2></div><div class="panel-body">' + renderMembers() + '</div></div>' +
          '<div class="panel"><div class="panel-header"><h2 class="panel-title">Backend manifests</h2></div><div class="panel-body">' +
            '<div class="kv"><b>Field types</b><span>' + state.fieldTypes.length + '</span></div>' +
            '<div class="kv"><b>Actions</b><span>' + state.agentTools.length + '</span></div>' +
            '<div class="kv"><b>Notice</b><span>' + escapeHtml(state.notice || "None") + '</span></div>' +
          '</div></div>';
      }

      function renderRecordFields() {
        const projection = state.recordDetail?.projection?.fields ?? {};
        const surface = state.recordDetail?.surface ?? {};
        return visibleFields().map((field) => {
          const value = projection[field.fieldKey] ?? projection[field.fieldId] ?? null;
          const stateForField = surface.states?.[field.fieldId] ?? {};
          return '<div class="kv"><b>' + escapeHtml(field.label ?? field.fieldKey) + '</b><span>' + renderValue(value, stateForField) + '</span></div>';
        }).join("") || '<p class="muted">No readable fields.</p>';
      }

      function renderActivity() {
        return state.activity.length
          ? '<ul class="activity">' + state.activity.slice(0, 8).map((entry) => '<li><b>' + escapeHtml(entry.eventType ?? entry.type ?? "event") + '</b><p class="muted">' + escapeHtml(entry.createdAt ?? entry.timestamp ?? "") + '</p></li>').join("") + '</ul>'
          : '<p class="muted">No activity visible for this record.</p>';
      }

      function renderMembers() {
        const members = state.memberships.slice(0, 6).map((membership) => '<div class="member-row"><b>' + escapeHtml(membership.userEmail ?? membership.email ?? membership.userId ?? "member") + '</b><span>' + escapeHtml(membership.workspaceRoleKey ?? membership.roleKey ?? "") + '</span></div>').join("");
        return (members ? '<div class="member-list">' + members + '</div>' : '<p class="muted">Load members to inspect invitation state.</p>') +
          '<div class="stack"><button id="detailMembersBtn">Load members</button><button id="detailInviteBtn">Create invitation</button></div>';
      }

      function bindShellEvents() {
        document.getElementById("tenantPicker")?.addEventListener("change", (event) => selectTenant(event.target.value));
        document.getElementById("refreshBtn")?.addEventListener("click", () => loadWorkspace());
        document.getElementById("createRecordBtn")?.addEventListener("click", () => createRecord().catch(renderFatal));
        document.getElementById("membershipsBtn")?.addEventListener("click", () => loadMemberships().catch(renderFatal));
        document.getElementById("detailMembersBtn")?.addEventListener("click", () => loadMemberships().catch(renderFatal));
        document.getElementById("inviteBtn")?.addEventListener("click", () => createInvitation().catch(renderFatal));
        document.getElementById("detailInviteBtn")?.addEventListener("click", () => createInvitation().catch(renderFatal));
        document.querySelectorAll("[data-table]").forEach((button) => {
          button.addEventListener("click", () => {
            state.tableId = button.dataset.table;
            state.viewId = button.dataset.view || null;
            loadCurrentView().catch(renderFatal);
          });
        });
        document.querySelectorAll("[data-record][data-field]").forEach((button) => {
          button.addEventListener("click", () => {
            const recordId = button.dataset.record;
            const fieldId = button.dataset.field;
            const field = visibleFields().find((candidate) => candidate.fieldId === fieldId);
            const row = readRows().find((candidate) => (candidate.recordId ?? candidate.id ?? candidate.record?.id) === recordId);
            const fieldAccess = row && field ? fieldState(row, field) : {};
            loadRecord(recordId).catch(renderFatal);
            if (fieldAccess.write !== false && fieldAccess.readState !== "hidden") {
              state.editing = { recordId, fieldId };
              renderShell();
            }
          });
        });
        document.querySelectorAll("[data-save-record][data-save-field]").forEach((editor) => {
          editor.addEventListener("keydown", (event) => {
            if (event.key === "Enter") saveEditor(editor).catch(renderFatal);
            if (event.key === "Escape") {
              state.editing = null;
              renderShell();
            }
          });
          editor.addEventListener("blur", () => saveEditor(editor).catch(renderFatal));
          editor.focus();
        });
      }

      async function saveEditor(editor) {
        if (editor.dataset.saving === "true") return;
        const field = visibleFields().find((candidate) => candidate.fieldId === editor.dataset.saveField);
        if (!field) return;
        if (editor.value === editor.dataset.originalValue) {
          if (!document.contains(editor)) return;
          state.editing = null;
          setTimeout(() => {
            if (!state.editing) renderShell();
          }, 0);
          return;
        }
        editor.dataset.saving = "true";
        await saveCell(editor.dataset.saveRecord, field, editor.value);
      }

      function readRows() {
        return state.viewData?.rows ?? state.viewData?.records ?? state.viewData?.data ?? [];
      }

      function visibleFields() {
        const byId = new Map((state.schema?.fields ?? []).map((field) => [field.fieldId, field]));
        const ids = state.viewDefinition?.definition?.visibleFieldIds ?? state.viewData?.fields?.map((field) => field.fieldId) ?? [];
        const fields = ids.map((id) => byId.get(id)).filter(Boolean);
        return fields.length ? fields : (state.schema?.fields ?? []);
      }

      function flattenTables() {
        const tables = [];
        for (const appItem of state.catalog?.apps ?? []) {
          for (const table of appItem.tables ?? []) tables.push(table);
        }
        for (const table of state.catalog?.tables ?? []) {
          if (!tables.some((candidate) => (candidate.tableId ?? candidate.id) === (table.tableId ?? table.id))) tables.push(table);
        }
        return tables;
      }

      function fieldState(row, field) {
        return row.surface?.states?.[field.fieldId] ?? row.states?.[field.fieldId] ?? state.viewData?.surface?.states?.[field.fieldId] ?? {};
      }

      function rowValue(row, field) {
        const fields = row.fields ?? row.projection?.fields ?? {};
        return fields[field.fieldKey] ?? fields[field.fieldId] ?? null;
      }

      function renderValue(value, fieldState) {
        if (fieldState.readState === "hidden") return '<span class="badge danger">hidden</span>';
        if (fieldState.readState === "redacted" || fieldState.redacted) return '<span class="badge warn">redacted</span>';
        if (value == null || value === "") return '<span class="muted">empty</span>';
        if (typeof value === "object") return escapeHtml(JSON.stringify(value));
        return escapeHtml(String(value));
      }

      function fieldBadge(field) {
        const manifest = state.fieldTypes.find((item) => item.type === field.fieldType || item.id === field.fieldType);
        return ' <span class="badge">' + escapeHtml(manifest?.label ?? field.fieldType) + '</span>';
      }

      function countHiddenFields() {
        const ids = new Set();
        for (const row of readRows()) {
          for (const id of row.surface?.hiddenFieldIds ?? row.hiddenFieldIds ?? []) ids.add(id);
        }
        for (const id of state.viewData?.surface?.hiddenFieldIds ?? []) ids.add(id);
        return ids.size;
      }

      function canCreate() {
        const actions = state.viewData?.surface?.actions ?? state.viewData?.actions ?? state.schema?.actions ?? [];
        if (!actions.length) return true;
        const createAction = actions.find((action) => action.commandType === "record.create" || action.id === "record.create" || action.name === "record.create");
        return createAction ? createAction.enabled !== false && createAction.allowed !== false : true;
      }

      function permissionSummary() {
        const scope = state.viewData?.permissionScope ?? state.viewDefinition?.permissionScope ?? state.schema?.permissionScope;
        if (!scope) return "Session-scoped permission surface";
        return [scope.principalId, scope.scopeHash, scope.policyRevision ?? scope.permissionsVersion].filter(Boolean).join(" · ");
      }

      function activeTenantLabel() {
        const tenant = state.tenants.find((item) => item.workspaceId === state.workspaceId);
        return tenant ? tenant.organization.name + " / " + tenant.workspace.name : "No tenant selected";
      }

      function coerceFieldValue(field, raw) {
        if (field.fieldType.includes("number")) return raw === "" ? null : Number(raw);
        if (field.fieldType === "boolean" || field.fieldType.includes("checkbox")) return raw === "true";
        return raw === "" ? null : raw;
      }

      async function apiJson(path, options = {}) {
        const response = await api(path, options);
        if (!response.ok) throw new Error(response.body?.message ?? "Request failed: " + path);
        return response.body;
      }

      async function api(path, options = {}) {
        const response = await fetch(path, {
          method: options.method ?? "GET",
          headers: options.body ? { "content-type": "application/json" } : undefined,
          body: options.body ? JSON.stringify(options.body) : undefined
        });
        let body = null;
        try {
          body = await response.json();
        } catch {}
        if (!response.ok && !options.allowUnauthorized) {
          throw new Error(body?.message ?? response.status + " " + response.statusText);
        }
        return { body, ok: response.ok, status: response.status };
      }

      function renderFatal(error) {
        app.className = "login";
        app.innerHTML = '<div class="login-box stack"><div class="brand"><div class="mark">C</div><div><h1>CloudTable Studio</h1><p>Something needs attention.</p></div></div><p class="error">' + escapeHtml(error.message ?? String(error)) + '</p><button onclick="location.reload()">Reload</button></div>';
      }

      function navButton(kind, id, label) {
        return '<button class="nav-item ' + (state.appId === id ? "active" : "") + '" data-' + kind + '="' + escapeAttr(id) + '"><span>' + escapeHtml(label) + '</span></button>';
      }

      function escapeHtml(value) {
        return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
      }

      function escapeAttr(value) {
        return escapeHtml(value);
      }
    </script>
  </body>
</html>`;
