import { expect, it } from 'vite-plus/test';
import * as Schema from 'effect/Schema';
import { OrchestrationV2Command, KeybindingRule, UsageSummaryInput, McpAppCallToolInput, ServerSettingsPatch } from '@t3tools/contracts';
import { liteNegativeCases } from '../../../../../../test/helpers/t3-lite-negative-cases.mjs';
import { authorizeProductRpc } from '../../../../../../agent-demo/t3-adapters/rpc-policy.mjs';
import { assertPersonalSettingsPatch } from '../../../../../../agent-demo/t3-adapters/settings-preferences.mjs';
import { PRODUCT_CAPABILITY_DISABLED } from '../../../../../../agent-demo/t3-adapters/product-profile.mjs';

it('every real lite negative payload decodes through native contracts before product rejection', () => {
  const env = { AUTOOPS_DEMO_PROFILE: 'project-assistant-lite-v1' };
  for (const [method, payload] of liteNegativeCases('existing-thread', undefined)) {
    switch (method) {
      case 'orchestration.dispatchCommand': Schema.decodeUnknownSync(Schema.toCodecJson(OrchestrationV2Command))(payload); break;
      case 'server.upsertKeybinding': Schema.decodeUnknownSync(Schema.toCodecJson(KeybindingRule))(payload); break;
      case 'server.getUsageSummary': Schema.decodeUnknownSync(Schema.toCodecJson(UsageSummaryInput))(payload); break;
      case 'mcpApps.callTool': Schema.decodeUnknownSync(Schema.toCodecJson(McpAppCallToolInput))(payload); break;
      case 'server.updateSettings': Schema.decodeUnknownSync(Schema.toCodecJson(ServerSettingsPatch))(payload.patch); break;
      default: throw new Error(`Unvalidated RPC ${method}`);
    }
    try {
      if (method === 'server.updateSettings') assertPersonalSettingsPatch(payload.patch, env);
      else authorizeProductRpc(method, payload, env);
      throw new Error(`Product policy allowed ${method}`);
    } catch (error) {
      expect(error).toMatchObject({ code: PRODUCT_CAPABILITY_DISABLED });
    }
  }
});
