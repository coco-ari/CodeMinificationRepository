import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderUserInputAnswers,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

const NullableMcpElicitationString = Schema.NullOr(Schema.String);
const McpElicitationMetadata = Schema.Struct({
  app: Schema.optionalKey(NullableMcpElicitationString),
  app_name: Schema.optionalKey(NullableMcpElicitationString),
  appName: Schema.optionalKey(NullableMcpElicitationString),
  connector_name: Schema.optionalKey(NullableMcpElicitationString),
  connectorName: Schema.optionalKey(NullableMcpElicitationString),
  allowPersistentApproval: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  persist: Schema.optionalKey(
    Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  ),
  target: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        app: Schema.optionalKey(NullableMcpElicitationString),
        name: Schema.optionalKey(NullableMcpElicitationString),
      }),
    ),
  ),
  tool_params: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        app: Schema.optionalKey(NullableMcpElicitationString),
        app_name: Schema.optionalKey(NullableMcpElicitationString),
      }),
    ),
  ),
});
const McpElicitationFormField = Schema.Struct({
  type: Schema.optionalKey(NullableMcpElicitationString),
  title: Schema.optionalKey(NullableMcpElicitationString),
  description: Schema.optionalKey(NullableMcpElicitationString),
  default: Schema.optionalKey(Schema.Json),
  enum: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  enumNames: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
  oneOf: Schema.optionalKey(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({
          const: Schema.String,
          title: Schema.optionalKey(NullableMcpElicitationString),
        }),
      ),
    ),
  ),
});
const McpElicitationForm = Schema.Struct({
  properties: Schema.optionalKey(Schema.Record(Schema.String, McpElicitationFormField)),
  required: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))),
});
const isMcpElicitationMetadata = Schema.is(McpElicitationMetadata);
const isMcpElicitationForm = Schema.is(McpElicitationForm);

type McpElicitationPersistenceDecision = Extract<
  ProviderApprovalDecision,
  "acceptForSession" | "acceptAlways"
>;

function mcpElicitationPersistenceDecision(
  value: string,
): McpElicitationPersistenceDecision | null {
  const normalized = value.toLowerCase();
  if (normalized.includes("session")) return "acceptForSession";
  if (
    normalized.includes("always") ||
    normalized.includes("permanent") ||
    normalized.includes("forever") ||
    normalized.includes("persistent")
  ) {
    return "acceptAlways";
  }
  return null;
}

function mcpElicitationFormFields(payload: EffectCodexSchema.McpServerElicitationRequestParams) {
  if (payload.mode === "url" || !isMcpElicitationForm(payload.requestedSchema)) {
    return undefined;
  }
  return payload.requestedSchema;
}

function mcpElicitationFieldOptions(field: typeof McpElicitationFormField.Type) {
  if (field.oneOf) {
    return field.oneOf.map((option) => ({ value: option.const, label: option.title }));
  }
  return (field.enum ?? []).map((value, index) => ({
    value,
    label: field.enumNames?.[index],
  }));
}

function isMcpElicitationPersistenceField(
  key: string,
  field: typeof McpElicitationFormField.Type,
): boolean {
  return (
    mcpElicitationPersistenceDecision(key) !== null ||
    key.toLowerCase() === "persist" ||
    mcpElicitationPersistenceDecision(field.title ?? "") !== null ||
    mcpElicitationPersistenceDecision(field.description ?? "") !== null
  );
}

export function describeMcpElicitation(
  payload: EffectCodexSchema.McpServerElicitationRequestParams,
): { readonly appName: string; readonly options: ReadonlyArray<ProviderApprovalOption> } {
  const metadata = isMcpElicitationMetadata(payload._meta) ? payload._meta : undefined;
  const appName =
    metadata?.app_name ??
    metadata?.appName ??
    metadata?.app ??
    metadata?.target?.app ??
    metadata?.target?.name ??
    metadata?.tool_params?.app_name ??
    metadata?.tool_params?.app ??
    payload.message.match(/^Allow ChatGPT to use (.+?)\?$/i)?.[1] ??
    metadata?.connector_name ??
    metadata?.connectorName ??
    payload.serverName;
  const persistenceOptions = new Map<McpElicitationPersistenceDecision, string>();
  const persist = metadata?.persist;
  for (const value of typeof persist === "string" ? [persist] : (persist ?? [])) {
    const decision = mcpElicitationPersistenceDecision(value);
    if (decision) persistenceOptions.set(decision, "");
  }
  if (metadata?.allowPersistentApproval) {
    persistenceOptions.set("acceptAlways", "");
  }

  const form = mcpElicitationFormFields(payload);
  for (const [key, field] of Object.entries(form?.properties ?? {})) {
    for (const option of mcpElicitationFieldOptions(field)) {
      const decision = mcpElicitationPersistenceDecision(option.value);
      if (decision) persistenceOptions.set(decision, option.label ?? "");
    }
    if (field.type === "boolean" && isMcpElicitationPersistenceField(key, field)) {
      persistenceOptions.set("acceptAlways", field.title ?? "");
    }
  }

  return {
    appName,
    options: [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      ...(persistenceOptions.has("acceptForSession") &&
      toMcpElicitationResponse(payload, "acceptForSession").action === "accept"
        ? [
            {
              decision: "acceptForSession" as const,
              label: persistenceOptions.get("acceptForSession") || "Always allow this session",
            },
          ]
        : []),
      ...(persistenceOptions.has("acceptAlways") &&
      toMcpElicitationResponse(payload, "acceptAlways").action === "accept"
        ? [
            {
              decision: "acceptAlways" as const,
              label: persistenceOptions.get("acceptAlways") || "Always allow",
            },
          ]
        : []),
      { decision: "accept", label: "Approve" },
    ],
  };
}

export function toMcpElicitationResponse(
  payload: EffectCodexSchema.McpServerElicitationRequestParams,
  decision: ProviderApprovalDecision,
): EffectCodexSchema.McpServerElicitationRequestResponse {
  if (decision === "decline" || decision === "cancel") {
    return { action: decision };
  }

  if (payload.mode === "url") {
    return { action: "decline" };
  }

  const persist =
    decision === "acceptForSession"
      ? "session"
      : decision === "acceptAlways"
        ? "always"
        : undefined;
  const form = mcpElicitationFormFields(payload);
  if (
    Object.entries(form?.properties ?? {}).some(
      ([key, field]) =>
        !/^(approval|decision|consent)$/i.test(key) &&
        !isMcpElicitationPersistenceField(key, field),
    )
  )
    return { action: "decline" };
  const content: Record<string, Schema.Json> = {};

  for (const [key, field] of Object.entries(form?.properties ?? {})) {
    const options = mcpElicitationFieldOptions(field);
    const chosenOption = options.find((option) =>
      persist
        ? mcpElicitationPersistenceDecision(option.value) === decision
        : /once|accept|approve|allow/i.test(option.value) &&
          mcpElicitationPersistenceDecision(option.value) === null,
    );
    if (chosenOption) {
      content[key] = chosenOption.value;
    } else if (field.type === "boolean" && isMcpElicitationPersistenceField(key, field)) {
      content[key] = decision === "acceptAlways";
    } else if (field.default !== undefined && field.default !== null) {
      content[key] = field.default;
    }
  }

  if (form?.required?.some((key) => !Object.hasOwn(content, key))) {
    return { action: "decline" };
  }

  return {
    action: "accept",
    ...(persist ? { _meta: { persist } } : {}),
    ...(form ? { content } : {}),
  };
}

/** Ordinary MCP forms must collect an answer; approval defaults are not user input. */
export function describeMcpUserInput(payload: EffectCodexSchema.McpServerElicitationRequestParams) {
  if (payload.mode === "url") return undefined;
  const form = mcpElicitationFormFields(payload);
  const fields = Object.entries(form?.properties ?? {});
  if (
    !form ||
    fields.length === 0 ||
    fields.every(
      ([key, field]) =>
        /^(approval|decision|consent)$/i.test(key) || isMcpElicitationPersistenceField(key, field),
    )
  )
    return undefined;
  if (
    fields.some(
      ([, field]) => !["string", "boolean", "number", "integer"].includes(field.type ?? "string"),
    )
  )
    return undefined;
  // The MCP SDK validates the original schema, including required/enum/format/range.
  // Never apply schema defaults: only a value supplied by the person may be returned.
  let validate: ReturnType<AjvJsonSchemaValidator["getValidator"]>;
  try {
    validate = new AjvJsonSchemaValidator().getValidator(payload.requestedSchema as JsonSchemaType);
  } catch {
    return undefined;
  }
  const questions: Array<EffectCodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion> =
    fields.map(([id, field]) => ({
      id,
      header: field.title?.trim() || id,
      question: [payload.message, field.description].filter(Boolean).join("\n\n"),
      isOther: true,
      isSecret: false,
      options:
        field.type === "boolean"
          ? [
              { label: "true", description: "Yes" },
              { label: "false", description: "No" },
            ]
          : mcpElicitationFieldOptions(field).map((option) => ({
              label: option.value,
              description: option.label || option.value,
            })),
    }));
  return {
    questions,
    respond(
      answers: ProviderUserInputAnswers,
    ): EffectCodexSchema.McpServerElicitationRequestResponse {
      const content: Record<string, Schema.Json> = {};
      for (const [id, field] of fields) {
        const supplied = answers[id];
        const values = Array.isArray(supplied)
          ? supplied
          : supplied === undefined || supplied === null
            ? []
            : [supplied];
        if (values.length === 0) continue;
        if (values.length !== 1) return { action: "decline" };
        const value = values[0];
        if (field.type === "boolean") {
          if (value !== true && value !== false && value !== "true" && value !== "false")
            return { action: "decline" };
          content[id] = value === true || value === "true";
        } else if (field.type === "number" || field.type === "integer") {
          if (
            (typeof value !== "string" && typeof value !== "number") ||
            String(value).trim() === "" ||
            !Number.isFinite(Number(value))
          )
            return { action: "decline" };
          content[id] = Number(value);
        } else {
          if (typeof value !== "string") return { action: "decline" };
          content[id] = value;
        }
      }
      if (
        Object.keys(answers).some((id) => !fields.some(([key]) => key === id)) ||
        !validate(content).valid
      )
        return { action: "decline" };
      return { action: "accept", content };
    },
  };
}
