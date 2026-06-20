import type { Page } from 'playwright';

/**
 * Installs a network intercept on the page. `pattern` is a Playwright URL
 * glob (e.g. `**\/api/links`). An optional `method` filter scopes the route
 * so a story can simulate a single failing endpoint (POST /api/links) without
 * breaking sibling requests on the same path (GET /api/links). The intercept
 * stays active for the remainder of the story.
 */
export async function runIntercept(
  page: Page,
  pattern: string,
  respond: { status: number; body?: unknown },
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
): Promise<void> {
  await page.route(pattern, async (route) => {
    if (method && route.request().method() !== method) {
      await route.fallback();
      return;
    }
    // Only declare a JSON body when one is supplied. Forcing
    // `application/json` on an empty body made consumers that call
    // `res.json()` throw on what is really an empty response.
    if (respond.body === undefined) {
      await route.fulfill({ status: respond.status });
      return;
    }
    await route.fulfill({
      status: respond.status,
      contentType: 'application/json',
      body: JSON.stringify(respond.body),
    });
  });
}
