import { describe, it, expect } from "vitest";

import { stripUnsupportedParams } from "../../open-sse/translator/concerns/paramSupport.js";

describe("stripUnsupportedParams", () => {
  it("flattens Cloudflare AI OpenAI content-part arrays", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "hello " },
            { type: "image_url", image_url: { url: "data:image/png;base64,xx" } },
            { type: "text", text: "world" },
          ],
        },
      ],
    };

    expect(() => stripUnsupportedParams("cloudflare-ai", "@cf/meta/llama-3.1-8b-instruct", body)).not.toThrow();
    expect(body.messages[0].content).toBe("hello world");
  });

  it("still drops unsupported GitHub model params", () => {
    const body = { temperature: 0.7, top_p: 1 };

    stripUnsupportedParams("github", "gpt-5.4", body);

    expect(body).toEqual({ top_p: 1 });
  });

  it("clamps VolcEngine Ark GLM max token fields to the model output ceiling", () => {
    const body = {
      max_tokens: 131072,
      max_completion_tokens: 131072,
      max_output_tokens: 131072,
    };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body).toEqual({
      max_tokens: 128000,
      max_completion_tokens: 128000,
      max_output_tokens: 128000,
    });
  });

  it("keeps VolcEngine Ark GLM max tokens when already under the ceiling", () => {
    const body = { max_tokens: 64000 };

    stripUnsupportedParams("volcengine-ark", "GLM-5.2", body);

    expect(body.max_tokens).toBe(64000);
  });

  // VolcEngine Ark caps Kimi max_tokens at the endpoint level (32768),
  // even though Kimi-K2.7-Code advertises maxOutput 262144. The rule's
  // explicit maxOutputCap must clamp via min(modelCeiling, endpointCap).
  it("clamps VolcEngine Ark Kimi max tokens to the 32768 endpoint cap", () => {
    const body = {
      max_tokens: 262144,
      max_completion_tokens: 262144,
      max_output_tokens: 262144,
    };

    stripUnsupportedParams("volcengine-ark", "kimi-k2.7-code", body);

    expect(body).toEqual({
      max_tokens: 32768,
      max_completion_tokens: 32768,
      max_output_tokens: 32768,
    });
  });

  it("keeps VolcEngine Ark Kimi max tokens when already under the endpoint cap", () => {
    const body = { max_tokens: 16384 };

    stripUnsupportedParams("volcengine-ark", "kimi-k2.7-code", body);

    expect(body.max_tokens).toBe(16384);
  });

  it("does not clamp Kimi max tokens on non-volcengine-ark providers", () => {
    const body = { max_tokens: 262144 };

    // A different provider must not hit the volcengine-ark Kimi rule.
    stripUnsupportedParams("moonshot", "kimi-k2.7-code", body);

    expect(body.max_tokens).toBe(262144);
  });
});
