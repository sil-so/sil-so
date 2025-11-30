export default {
  /**
   * Scheduled Cron Job
   * Runs weekly to fetch WhatPulse stats and update KV storage.
   */
  async scheduled(controller, env, ctx) {
    const RESET_CRON = "0 0 * * 1"; // Mondays at midnight

    try {
      // Fetch latest user data from WhatPulse API
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

      // Parse current API stats
      const currentMiles = parseFloat(json.user.totals.distance_miles || 0);
      const currentClicks = parseInt(json.user.totals.clicks || 0);

      // Retrieve baseline stats (start of week) from KV
      let baselineMiles = parseFloat(
        await env.WHATPULSE_DATA.get("baseline_miles")
      );
      let baselineClicks = parseInt(
        await env.WHATPULSE_DATA.get("baseline_clicks")
      );

      // Determine if baseline needs resetting (Weekly schedule or first run)
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

      // Calculate weekly progress
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

      // Update KV with formatted display data
      await env.WHATPULSE_DATA.put("stats", JSON.stringify(stats));
      console.log("Stats successfully updated:", stats);
    } catch (error) {
      console.error("Scheduled Task Error:", error.message);
    }
  },

  /**
   * HTTP Fetch Handler
   * Intercepts requests to inject stats into HTML responses.
   */
  async fetch(request, env, ctx) {
    // Remove conditional headers to ensure Cloudflare Assets returns the full HTML body for rewriting
    const newHeaders = new Headers(request.headers);
    newHeaders.delete("If-None-Match");
    newHeaders.delete("If-Modified-Since");

    const response = await env.ASSETS.fetch(
      new Request(request, { headers: newHeaders })
    );

    // Passthrough for non-HTML assets (images, css, etc.)
    const contentType = response.headers.get("content-type");
    if (!contentType || !contentType.includes("text/html")) {
      return response;
    }

    // Retrieve stats from KV (with fallback for fresh deployments)
    const statsData = await env.WHATPULSE_DATA.get("stats", { type: "json" });
    const data = statsData || { distance: "--", clicks: "--", updatedAt: null };

    // Inject data into the DOM
    const transformed = new HTMLRewriter()
      .on("#activity-mouse-travel", new ElementHandler(data.distance))
      .on("#activity-mouse-clicks", new ElementHandler(data.clicks))
      .on(
        "#activity-last-update",
        new ElementHandler(formatUpdateTime(data.updatedAt))
      )
      .transform(response);

    // Return response with edge caching enabled to minimize KV reads
    const finalResponse = new Response(transformed.body, transformed);
    finalResponse.headers.set("Cache-Control", "public, max-age=60");

    return finalResponse;
  },
};

// --- Helper Classes & Functions ---

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

/**
 * Formats an ISO date string into a localized time with UTC offset.
 * Example: "5 AM UTC+1" or "5 AM UTC+2" (depending on DST in Amsterdam)
 */
function formatUpdateTime(isoString) {
  if (!isoString) return "";

  const date = new Date(isoString);

  const timeString = date.toLocaleTimeString("en-US", {
    hour: "numeric",
    hour12: true,
    timeZone: "Europe/Amsterdam",
    timeZoneName: "shortOffset",
  });

  // Standardize offset display (GMT -> UTC)
  return timeString.replace("GMT", "UTC");
}
