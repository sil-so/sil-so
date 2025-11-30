export default {
  async scheduled(controller, env, ctx) {
    const RESET_CRON = "0 0 * * 1"; // Mondays at midnight

    try {
      // 1. Fetch latest data from API
      const response = await fetch(
        `https://whatpulse.org/api/v1/users/${env.WHATPULSE_USER_ID}`,
        {
          headers: {
            Authorization: `Bearer ${env.WHATPULSE_API_TOKEN}`,
            Accept: "application/json",
          },
        }
      );

      if (!response.ok) {
        throw new Error(`WhatPulse API Error: ${response.status}`);
      }

      const json = await response.json();
      if (!json.user?.totals) {
        throw new Error("Structure mismatch: 'user.totals' not found");
      }

      // 2. Parse current stats
      const currentMiles = parseFloat(json.user.totals.distance_miles || 0);
      const currentClicks = parseInt(json.user.totals.clicks || 0);

      // 3. Get Baseline (Start of week)
      let baselineMiles = parseFloat(
        await env.WHATPULSE_DATA.get("baseline_miles")
      );
      let baselineClicks = parseInt(
        await env.WHATPULSE_DATA.get("baseline_clicks")
      );

      // 4. Check if we need to reset the baseline (Monday OR First Run)
      const isResetTime = controller.cron === RESET_CRON;
      const isFirstRun = isNaN(baselineMiles) || isNaN(baselineClicks);

      if (isResetTime || isFirstRun) {
        await env.WHATPULSE_DATA.put("baseline_miles", currentMiles.toString());
        await env.WHATPULSE_DATA.put(
          "baseline_clicks",
          currentClicks.toString()
        );
        baselineMiles = currentMiles;
        baselineClicks = currentClicks;
      }

      // 5. Calculate Weekly Progress
      const weeklyKm = ((currentMiles - baselineMiles) * 1.60934).toFixed(2);
      const weeklyClicks = currentClicks - baselineClicks;

      const stats = {
        distance: new Intl.NumberFormat("en-US").format(weeklyKm),
        clicks: new Intl.NumberFormat("en-US", {
          notation: "compact",
          maximumFractionDigits: 1,
        }).format(weeklyClicks),
        updatedAt: new Date().toISOString(),
      };

      // 6. Save to KV
      await env.WHATPULSE_DATA.put("stats", JSON.stringify(stats));
      console.log("Stats updated:", stats);
    } catch (error) {
      console.error("Scheduled Task Error:", error.message);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Prepare request for Assets
    // We strip conditional headers to force the Asset to return the full HTML body
    // Otherwise, it might return "304 Not Modified" and we can't rewrite an empty body.
    const newHeaders = new Headers(request.headers);
    newHeaders.delete("If-None-Match");
    newHeaders.delete("If-Modified-Since");

    const response = await env.ASSETS.fetch(
      new Request(request, { headers: newHeaders })
    );

    // 2. Only intercept HTML requests
    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("text/html")) {
      return response;
    }

    // 3. Get Data and Rewrite
    const statsData = await env.WHATPULSE_DATA.get("stats", { type: "json" });

    // Fallback if KV is empty (prevents site crashing on fresh deploy)
    const data = statsData || { distance: "--", clicks: "--", updatedAt: null };

    const transformed = new HTMLRewriter()
      .on("#activity-mouse-travel", new ElementHandler(data.distance))
      .on("#activity-mouse-clicks", new ElementHandler(data.clicks))
      .on(
        "#activity-last-update",
        new ElementHandler(formatUpdateTime(data.updatedAt))
      )
      .transform(response);

    // 4. Return new response with Caching enabled
    const finalResponse = new Response(transformed.body, transformed);
    finalResponse.headers.set("Cache-Control", "public, max-age=60");

    return finalResponse;
  },
};

// --- Helpers ---

class ElementHandler {
  constructor(content) {
    this.content = content;
  }
  element(element) {
    if (this.content !== undefined && this.content !== null) {
      element.setInnerContent(this.content);
    }
  }
}

function formatUpdateTime(isoString) {
  if (!isoString) return "";
  return new Date(isoString).toLocaleTimeString("en-US", {
    hour: "numeric",
    hour12: true,
    timeZone: "Europe/Amsterdam",
  });
}
