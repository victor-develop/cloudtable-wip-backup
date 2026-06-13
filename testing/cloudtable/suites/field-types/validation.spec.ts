import { describe, expect, it } from "vitest";

import { createFieldTypeRegistry } from "../../../../src/core/field-types/registry";
import type { NormalizedCellValue } from "../../../../src/core/field-types/types";

const registry = createFieldTypeRegistry();

describe("cloudtable field-type validation", () => {
  it("removes placeholder schema metadata from hardened modules", () => {
    const hardenedTypes = [
      "text.single_line",
      "text.long",
      "number.decimal",
      "boolean.checkbox",
      "select.single",
      "select.multi",
      "status.semantic",
      "date.date",
      "date.datetime",
      "principal.user",
      "relation.record",
      "computed.readonly"
    ] as const;

    for (const type of hardenedTypes) {
      const definition = registry.require(type);
      expect(definition.configSchema.description).not.toContain("Placeholder");
      expect(definition.valueSchema.description).not.toContain("Placeholder");
    }
  });

  it("rejects malformed configs with stable diagnostics", () => {
    expect(
      registry.require("number.decimal").validateConfig(
        { precision: -1, display: "weird" },
        { fieldType: "number.decimal" }
      )
    ).toEqual({
      valid: false,
      errors: [
        "Field configuration precision must be a non-negative integer.",
        "Field configuration display must be one of: plain, currency, percent."
      ]
    });

    expect(
      registry.require("boolean.checkbox").validateConfig(
        { unexpected: true },
        { fieldType: "boolean.checkbox" }
      )
    ).toEqual({
      valid: false,
      errors: ["Field configuration contains unsupported property: unexpected."]
    });

    expect(
      registry.require("principal.user").validateConfig(
        { allowedRoleIds: ["admin", "admin", ""] },
        { fieldType: "principal.user" }
      )
    ).toEqual({
      valid: false,
      errors: [
        "allowedRoleIds entries must be unique: admin.",
        "allowedRoleIds entry 2 must be a non-empty string."
      ]
    });

    expect(
      registry.require("principal.user").validateConfig(
        { workflowBindingAlias: "row.owner" },
        { fieldType: "principal.user" }
      )
    ).toEqual({
      valid: false,
      errors: ["workflowBindingAlias row.owner requires rowOwner to be true."]
    });

    expect(
      registry.require("relation.record").validateConfig(
        { allowMultiple: "yes" },
        { fieldType: "relation.record" }
      )
    ).toEqual({
      valid: false,
      errors: [
        "Field configuration targetTableId must be a non-empty string.",
        "Field configuration allowMultiple must be a boolean."
      ]
    });

    expect(
      registry.require("computed.readonly").validateConfig(
        { expression: "", dependsOnFieldIds: ["fld_1", "fld_1"] },
        { fieldType: "computed.readonly" }
      )
    ).toEqual({
      valid: false,
      errors: [
        "Field configuration expression must be a non-empty string.",
        "dependsOnFieldIds entries must be unique: fld_1."
      ]
    });

    expect(
      registry.require("computed.readonly").validateConfig(
        {
          resultValueType: "number",
          rollup: {
            grouping: {
              sourceFieldId: "fld_account",
              strategy: "single_relation"
            },
            operationId: "count_records",
            sourceTableId: "tbl_tickets"
          }
        },
        { fieldType: "computed.readonly" }
      )
    ).toEqual({
      valid: true,
      errors: []
    });

    expect(
      registry.require("computed.readonly").validateConfig(
        {
          lookup: {
            sourceFieldId: "fld_account",
            targetFieldId: "fld_name"
          }
        },
        { fieldType: "computed.readonly" }
      )
    ).toEqual({
      valid: true,
      errors: []
    });

    expect(
      registry.require("computed.readonly").validateConfig(
        {
          expression: "source.value",
          rollup: {
            grouping: {
              sourceFieldId: "fld_account",
              strategy: "single_relation"
            },
            operationId: "count_records",
            sourceTableId: "tbl_tickets"
          }
        },
        { fieldType: "computed.readonly" }
      )
    ).toEqual({
      valid: false,
      errors: ["Field configuration must not mix expression, lookup, and rollup on computed.readonly."]
    });

    expect(
      registry.require("text.single_line").validateConfig(
        { maxLength: 120 },
        { fieldType: "text.single_line" }
      )
    ).toEqual({
      valid: false,
      errors: ["Field configuration contains unsupported property: maxLength."]
    });

    expect(
      registry.require("text.long").validateConfig(
        { richText: true },
        { fieldType: "text.long" }
      )
    ).toEqual({
      valid: false,
      errors: ["Field configuration contains unsupported property: richText."]
    });

    expect(
      registry.require("select.single").validateConfig(
        {
          options: [
            { id: 42, label: "Ready", extra: true },
            { id: "ready", label: "" },
            { id: "ready", label: "Duplicate" }
          ]
        },
        { fieldType: "select.single" }
      )
    ).toEqual({
      valid: false,
      errors: [
        "Field option 0 contains unsupported property: extra.",
        "Field option 0 id must be a non-empty string.",
        "Field option 1 label must be a non-empty string.",
        "Field option ids must be unique: ready."
      ]
    });

    expect(
      registry.require("status.semantic").validateConfig(
        {
          options: [
            { id: "todo", label: "Todo" },
            { id: "doing", label: "Doing", semantic: "moving" }
          ]
        },
        { fieldType: "status.semantic" }
      )
    ).toEqual({
      valid: false,
      errors: [
        "Status option todo is missing a semantic value.",
        "Status option doing has unsupported semantic: moving."
      ]
    });
  });

  it("rejects malformed normalized values instead of silently accepting them", () => {
    const invalidNumber = registry.require("number.decimal").normalize("4.567", {
      fieldConfig: { precision: 2 },
      fieldType: "number.decimal"
    });
    expect(invalidNumber.warnings).toEqual([]);
    expect(
      registry.require("number.decimal").validateValue(invalidNumber.value, {
        fieldConfig: { precision: 2 },
        fieldType: "number.decimal"
      })
    ).toEqual({
      valid: false,
      errors: ["Expected number.decimal value to use at most 2 decimal places."]
    });

    const invalidBoolean = registry.require("boolean.checkbox").normalize("maybe", {
      fieldConfig: {},
      fieldType: "boolean.checkbox"
    });
    expect(invalidBoolean.warnings).toEqual([
      {
        code: "boolean.invalid",
        message: 'Could not normalize "maybe" as a boolean value.'
      }
    ]);
    expect(
      registry.require("boolean.checkbox").validateValue(invalidBoolean.value, {
        fieldConfig: {},
        fieldType: "boolean.checkbox"
      })
    ).toEqual({
      valid: false,
      errors: ["Expected boolean.checkbox value to be a boolean or null."]
    });

    const invalidDate = registry.require("date.date").normalize("2026-02-30", {
      fieldConfig: {},
      fieldType: "date.date"
    });
    expect(invalidDate.warnings).toEqual([
      {
        code: "date.invalid",
        message: 'Could not normalize "2026-02-30" as an ISO date.'
      }
    ]);
    expect(
      registry.require("date.date").validateValue(invalidDate.value, {
        fieldConfig: {},
        fieldType: "date.date"
      })
    ).toEqual({
      valid: false,
      errors: ["Expected date.date value to use YYYY-MM-DD format."]
    });

    const invalidDatetime = registry.require("date.datetime").normalize("2026-06-06T00:00:00", {
      fieldConfig: {},
      fieldType: "date.datetime"
    });
    expect(invalidDatetime.warnings).toEqual([
      {
        code: "datetime.invalid",
        message: 'Could not normalize "2026-06-06T00:00:00" as an ISO datetime.'
      }
    ]);
    expect(
      registry.require("date.datetime").validateValue(invalidDatetime.value, {
        fieldConfig: {},
        fieldType: "date.datetime"
      })
    ).toEqual({
      valid: false,
      errors: ["Expected date.datetime value to use an ISO datetime with timezone."]
    });

    const invalidPrincipalValue = {
      isEmpty: false,
      raw: ["user_1", "user_1"],
      refs: ["user_1", "user_1"],
      valueType: "principal.user",
      version: 1
    } satisfies NormalizedCellValue;
    expect(
      registry.require("principal.user").validateValue(invalidPrincipalValue, {
        fieldConfig: {},
        fieldType: "principal.user"
      })
    ).toEqual({
      valid: false,
      errors: ["Expected principal.user value entries to be unique: user_1."]
    });

    const invalidRelationValue = {
      isEmpty: false,
      raw: ["rec_1", "rec_2"],
      refs: ["rec_1", "rec_2"],
      valueType: "relation.record",
      version: 1
    } satisfies NormalizedCellValue;
    expect(
      registry.require("relation.record").validateValue(invalidRelationValue, {
        fieldConfig: { allowMultiple: false, targetTableId: "tbl_related" },
        fieldType: "relation.record"
      })
    ).toEqual({
      valid: false,
      errors: ["Expected relation.record value to contain at most one record id."]
    });

    const invalidComputedValue = {
      isEmpty: false,
      raw: Symbol("bad-payload") as never,
      valueType: "computed.readonly",
      version: 1
    } satisfies NormalizedCellValue;
    expect(
      registry.require("computed.readonly").validateValue(invalidComputedValue, {
        fieldConfig: { expression: "source.value" },
        fieldType: "computed.readonly"
      })
    ).toEqual({
      valid: false,
      errors: ["Expected computed.readonly value to contain a JSON-serializable payload."]
    });

    const invalidSingleLineValue = {
      isEmpty: false,
      raw: 42,
      tokens: ["42"],
      valueType: "text.single_line",
      version: 1
    } satisfies NormalizedCellValue;
    expect(
      registry.require("text.single_line").validateValue(invalidSingleLineValue, {
        fieldConfig: {},
        fieldType: "text.single_line"
      })
    ).toEqual({
      valid: false,
      errors: ["Expected text.single_line value to be a string or null."]
    });

    const invalidLongTextValue = {
      isEmpty: false,
      raw: "Alpha Beta",
      tokens: ["alpha", ""],
      valueType: "text.long",
      version: 1
    } satisfies NormalizedCellValue;
    expect(
      registry.require("text.long").validateValue(invalidLongTextValue, {
        fieldConfig: {},
        fieldType: "text.long"
      })
    ).toEqual({
      valid: false,
      errors: ["Expected text.long tokens to contain non-empty normalized strings."]
    });

    const invalidSelect = registry.require("select.single").normalize("missing", {
      fieldConfig: {
        options: [{ id: "ready", label: "Ready" }]
      },
      fieldType: "select.single"
    });
    expect(invalidSelect.warnings).toEqual([]);
    expect(
      registry.require("select.single").validateValue(invalidSelect.value, {
        fieldConfig: {
          options: [{ id: "ready", label: "Ready" }]
        },
        fieldType: "select.single"
      })
    ).toEqual({
      valid: false,
      errors: ["Unknown option id for select.single: missing."]
    });

    const invalidMultiSelectValue = {
      isEmpty: false,
      raw: ["alpha", "alpha", ""],
      tokens: ["alpha", "alpha"],
      valueType: "select.multi",
      version: 1
    } satisfies NormalizedCellValue;
    expect(
      registry.require("select.multi").validateValue(invalidMultiSelectValue, {
        fieldConfig: {
          options: [
            { id: "alpha", label: "Alpha" },
            { id: "beta", label: "Beta" }
          ]
        },
        fieldType: "select.multi"
      })
    ).toEqual({
      valid: false,
      errors: [
        "Expected select.multi value entry 2 to be a non-empty option id.",
        "Expected select.multi value entries to be unique: alpha."
      ]
    });

    const invalidStatus = registry.require("status.semantic").normalize("missing", {
      fieldConfig: {
        options: [{ id: "todo", label: "Todo", semantic: "todo" }]
      },
      fieldType: "status.semantic"
    });
    expect(invalidStatus.warnings).toEqual([]);
    expect(
      registry.require("status.semantic").validateValue(invalidStatus.value, {
        fieldConfig: {
          options: [{ id: "todo", label: "Todo", semantic: "todo" }]
        },
        fieldType: "status.semantic"
      })
    ).toEqual({
      valid: false,
      errors: ["Unknown option id for status.semantic: missing."]
    });
  });
});
