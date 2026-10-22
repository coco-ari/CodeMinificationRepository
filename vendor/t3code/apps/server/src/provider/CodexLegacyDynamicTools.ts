import * as Schema from "effect/Schema";
import type * as CodexSchema from "effect-codex-app-server/schema";
const textContent=Schema.is(Schema.Struct({type:Schema.Literal("text"),text:Schema.String}));
const imageContent=Schema.is(Schema.Struct({type:Schema.Literal("image"),mimeType:Schema.String,data:Schema.String}));
const encodeJson=Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
export function legacyDynamicToolResponse(response: Pick<CodexSchema.V2McpServerToolCallResponse,"content"|"isError">): CodexSchema.DynamicToolCallResponse {
  return {success:response.isError!==true,contentItems:response.content.map(content=>
    textContent(content) ? {type:"inputText",text:content.text}
      : imageContent(content) ? {type:"inputImage",imageUrl:`data:${content.mimeType};base64,${content.data}`}
      : {type:"inputText",text:encodeJson(content)})};
}
