import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { RuntimeRequestId } from "@t3tools/contracts";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

describe("approval action availability", () => {
  it.each([
    { name: "offline or revoked device", disabled: true, canRespond: true },
    { name: "lost native response capability", disabled: false, canRespond: false },
  ])("disables both primary and extra options for $name", ({ disabled, canRespond }) => {
    const respond = vi.fn();
    const html = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={RuntimeRequestId.make("request-1")}
        isResponding={false}
        disabled={disabled}
        canRespond={canRespond}
        onRespondToApproval={respond}
      />,
    );
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => /\sdisabled(?:=""|[\s>])/.test(button))).toBe(true);
    expect(respond).not.toHaveBeenCalled();
  });

  it("keeps the same actions enabled when the native response is live", () => {
    const html = renderToStaticMarkup(
      <ComposerPendingApprovalActions
        requestId={RuntimeRequestId.make("request-1")}
        isResponding={false}
        canRespond
        onRespondToApproval={vi.fn()}
      />,
    );
    const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map((match) => match[0]);
    expect(buttons).toHaveLength(3);
    expect(buttons.every((button) => !/\sdisabled(?:=""|[\s>])/.test(button))).toBe(true);
  });
});
