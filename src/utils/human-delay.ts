/**
 * Waits a randomized, human-plausible amount of time. Real users don't click
 * instantly after a page loads or between form interactions; a script that does
 * is an easy automation signal for a WAF/bot-detector to key on.
 */
export async function humanDelay(minMs = 400, maxMs = 1200): Promise<void> {
  const ms = minMs + Math.random() * (maxMs - minMs);
  await new Promise((resolve) => setTimeout(resolve, ms));
}
