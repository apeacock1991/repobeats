/**
 * Optional `cf-aig-authorization` for authenticated AI Gateway requests (same header as compat curl examples).
 * @see https://developers.cloudflare.com/ai-gateway/usage/chat-completion/
 * `AiOptions.extraHeaders` on `env.AI.run()` comes from generated `AiOptions` in worker-configuration.d.ts.
 */
export function withAiGatewayAuth(gatewayId: string, apiGatewayToken: string | undefined, options: AiOptions = {}): AiOptions {
  const token = apiGatewayToken?.trim();
  const mergedHeaders: Record<string, string> = {
    ...(options.extraHeaders as Record<string, string> | undefined),
  };
  if (token) {
    mergedHeaders["cf-aig-authorization"] = `Bearer ${token}`;
  }
  return {
    ...options,
    gateway: { ...options.gateway, id: gatewayId },
    ...(Object.keys(mergedHeaders).length > 0 ? { extraHeaders: mergedHeaders } : {}),
  };
}

/**
 * Shared AI run defaults used across lyric and music generation.
 * Keeps gateway id/auth/timeout/retry behavior consistent in one place.
 */
export function withGatewayRunDefaults(
  gatewayId: string,
  apiGatewayToken: string | undefined,
  requestTimeoutMs: number,
  options: AiOptions = {},
): AiOptions {
  const baseGateway = (options.gateway ?? {}) as Record<string, unknown>;
  const incomingRetries =
    baseGateway.retries && typeof baseGateway.retries === "object"
      ? (baseGateway.retries as Record<string, unknown>)
      : {};
  const mergedGateway: Record<string, unknown> = {
    ...baseGateway,
    id: gatewayId,
    requestTimeoutMs,
    retries: {
      ...incomingRetries,
      maxAttempts: 1,
    },
  };
  return withAiGatewayAuth(gatewayId, apiGatewayToken, {
    ...options,
    gateway: mergedGateway as AiOptions["gateway"],
    signal: options.signal ?? AbortSignal.timeout(requestTimeoutMs),
  });
}
