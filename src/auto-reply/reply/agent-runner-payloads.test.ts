import { describe, expect, it } from "vitest";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";

const baseParams = {
  isHeartbeat: false,
  didLogHeartbeatStrip: false,
  blockStreamingEnabled: false,
  blockReplyPipeline: null,
  replyToMode: "off" as const,
};

async function expectSameTargetRepliesSuppressed(params: { provider: string; to: string }) {
  const { replyPayloads } = await buildReplyPayloads({
    ...baseParams,
    payloads: [{ text: "hello world!" }],
    messageProvider: "heartbeat",
    originatingChannel: "feishu",
    originatingTo: "ou_abc123",
    messagingToolSentTexts: ["different message"],
    messagingToolSentTargets: [{ tool: "message", provider: params.provider, to: params.to }],
  });

  expect(replyPayloads).toHaveLength(0);
}

describe("buildReplyPayloads media filter integration", () => {
  it("strips media URL from payload when in messagingToolSentMediaUrls", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0].mediaUrl).toBeUndefined();
  });

  it("preserves media URL when not in messagingToolSentMediaUrls", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentMediaUrls: ["file:///tmp/other.jpg"],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0].mediaUrl).toBe("file:///tmp/photo.jpg");
  });

  it("normalizes sent media URLs before deduping normalized reply media", async () => {
    const normalizeMediaPaths = async (payload: { mediaUrl?: string; mediaUrls?: string[] }) => {
      const normalizeMedia = (value?: string) =>
        value === "./out/photo.jpg" ? "/tmp/workspace/out/photo.jpg" : value;
      return {
        ...payload,
        mediaUrl: normalizeMedia(payload.mediaUrl),
        mediaUrls: payload.mediaUrls?.map((value) => normalizeMedia(value) ?? value),
      };
    };

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello", mediaUrl: "./out/photo.jpg" }],
      messagingToolSentMediaUrls: ["./out/photo.jpg"],
      normalizeMediaPaths,
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]).toMatchObject({
      text: "hello",
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
  });

  it("drops only invalid media when reply media normalization fails", async () => {
    const normalizeMediaPaths = async (payload: { mediaUrl?: string }) => {
      if (payload.mediaUrl === "./bad.png") {
        throw new Error("Path escapes sandbox root");
      }
      return payload;
    };

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [
        { text: "keep text", mediaUrl: "./bad.png", audioAsVoice: true },
        { text: "keep second" },
      ],
      normalizeMediaPaths,
    });

    expect(replyPayloads).toHaveLength(2);
    expect(replyPayloads[0]).toMatchObject({
      text: "keep text",
      mediaUrl: undefined,
      mediaUrls: undefined,
      audioAsVoice: false,
    });
    expect(replyPayloads[1]).toMatchObject({
      text: "keep second",
    });
  });

  it("applies media filter after text filter", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
    });

    // Text filter removes the payload entirely (text matched), so nothing remains.
    expect(replyPayloads).toHaveLength(0);
  });

  it("does not dedupe text for cross-target messaging sends", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!" }],
      messageProvider: "telegram",
      originatingTo: "telegram:123",
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentTargets: [{ tool: "discord", provider: "discord", to: "channel:C1" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("hello world!");
  });

  it("does not dedupe media for cross-target messaging sends", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }],
      messageProvider: "telegram",
      originatingTo: "telegram:123",
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.mediaUrl).toBe("file:///tmp/photo.jpg");
  });

  it("suppresses same-target replies when messageProvider is synthetic but originatingChannel is set", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!" }],
      messageProvider: "heartbeat",
      originatingChannel: "telegram",
      originatingTo: "268300329",
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("suppresses same-target replies when message tool target provider is generic", async () => {
    await expectSameTargetRepliesSuppressed({ provider: "message", to: "ou_abc123" });
  });

  it("suppresses same-target replies when target provider is channel alias", async () => {
    await expectSameTargetRepliesSuppressed({ provider: "lark", to: "ou_abc123" });
  });

  it("drops already-streamed text-only finals after successful block streaming", async () => {
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => true,
      isAborted: () => false,
      hasSentPayload: (payload) =>
        payload.text === "response" && !payload.mediaUrl && !payload.mediaUrls,
      enqueue: () => {},
      flush: async () => {},
      stop: () => {},
      hasBuffered: () => false,
    };
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "all",
      payloads: [{ text: "response", replyToId: "post-123" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("preserves unsent image_generate media after the caption already streamed", async () => {
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => true,
      isAborted: () => false,
      hasSentPayload: (payload) =>
        payload.text === "caption" && !payload.mediaUrl && !payload.mediaUrls?.length,
      enqueue: () => {},
      flush: async () => {},
      stop: () => {},
      hasBuffered: () => false,
    };
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "all",
      payloads: [
        {
          text: "caption",
          mediaUrls: ["/tmp/tool-image-generation/generated.png"],
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]).toMatchObject({
      text: undefined,
      mediaUrls: ["/tmp/tool-image-generation/generated.png"],
    });
  });

  it("keeps leftover generated media after a real block pipeline streams the caption", async () => {
    const streamed: Array<{ text?: string; mediaUrls?: string[] }> = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async (payload) => {
        streamed.push({ text: payload.text, mediaUrls: payload.mediaUrls });
      },
      timeoutMs: 5000,
    });

    pipeline.enqueue({ text: "给你一张图" });
    await pipeline.flush();

    expect(pipeline.didStream()).toBe(true);
    expect(streamed).toEqual([{ text: "给你一张图", mediaUrls: undefined }]);

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "off",
      payloads: [
        {
          text: "给你一张图",
          mediaUrls: ["/tmp/tool-image-generation/diana.png"],
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]).toMatchObject({
      text: undefined,
      mediaUrls: ["/tmp/tool-image-generation/diana.png"],
    });
  });

  it("does not resend media that the block pipeline already delivered", async () => {
    const mediaUrls = ["/tmp/tool-image-generation/generated.png"];
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => true,
      isAborted: () => false,
      hasSentPayload: (payload) => payload.text === "caption" || Boolean(payload.mediaUrls?.length),
      enqueue: () => {},
      flush: async () => {},
      stop: () => {},
      hasBuffered: () => false,
    };
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "off",
      payloads: [{ text: "caption", mediaUrls }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("drops all final payloads during silent turns, including media-only payloads", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      silentExpected: true,
      payloads: [{ text: "NO_REPLY", mediaUrl: "file:///tmp/photo.jpg" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("deduplicates final payloads against directly sent block keys regardless of replyToId", async () => {
    // When block streaming is not active but directlySentBlockKeys has entries
    // (e.g. from pre-tool flush), the key should match even if replyToId differs.
    const { createBlockReplyContentKey } = await import("./block-reply-pipeline.js");
    const directlySentBlockKeys = new Set<string>();
    directlySentBlockKeys.add(
      createBlockReplyContentKey({ text: "response", replyToId: "post-1" }),
    );

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      directlySentBlockKeys,
      replyToMode: "off",
      payloads: [{ text: "response" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("does not suppress same-target replies when accountId differs", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!" }],
      messageProvider: "heartbeat",
      originatingChannel: "telegram",
      originatingTo: "268300329",
      accountId: "personal",
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [
        {
          tool: "telegram",
          provider: "telegram",
          to: "268300329",
          accountId: "work",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("hello world!");
  });
});
