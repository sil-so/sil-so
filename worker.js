export default {
  async scheduled(controller, env, ctx) {
    const RESET_CRON = "0 0 * * 1";
    // nothing
    try {
      const userID = env.WHATPULSE_USER_ID;
      const token = env.WHATPULSE_API_TOKEN;
      const response = await fetch(
        `https://whatpulse.org/api/v1/users/${userID}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
        }
      );

      if (!response.ok) {
        console.error(`WhatPulse API Error: ${response.status}`);
        return;
      }
      const json = await response.json();

      let currentMiles = 0;
      let currentClicks = 0;

      if (json.user && json.user.totals) {
        currentMiles = parseFloat(json.user.totals.distance_miles || 0);
        currentClicks = parseInt(json.user.totals.clicks || 0);
      } else {
        console.error("Structure mismatch: 'user.totals' not found");
        return;
      }

      let baselineMiles = parseFloat(
        await env.WHATPULSE_DATA.get("baseline_miles")
      );
      let baselineClicks = parseInt(
        await env.WHATPULSE_DATA.get("baseline_clicks")
      );

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

      const weeklyMiles = currentMiles - baselineMiles;
      const weeklyClicks = currentClicks - baselineClicks;
      const weeklyKm = (weeklyMiles * 1.60934).toFixed(2);

      const stats = {
        distance: new Intl.NumberFormat("en-US").format(weeklyKm),
        clicks: new Intl.NumberFormat("en-US", {
          notation: "compact",
          maximumFractionDigits: 1,
        }).format(weeklyClicks),
        updatedAt: new Date().toISOString(),
      };

      await env.WHATPULSE_DATA.put("stats", JSON.stringify(stats));
      console.log("Updated Stats Successfully:", stats);
    } catch (error) {
      console.error("Worker Error:", error.message);
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    console.log("[fetch] Handling request for:", url.pathname);

    const newHeaders = new Headers(request.headers);
    newHeaders.delete("If-None-Match");
    newHeaders.delete("If-Modified-Since");

    const newRequest = new Request(request, {
      headers: newHeaders,
    });

    const response = await env.ASSETS.fetch(newRequest);
    const contentType = response.headers.get("content-type");
    console.log("[fetch] Content-Type:", contentType);

    if (contentType && contentType.includes("text/html")) {
      console.log("[fetch] HTML detected, fetching stats from KV...");
      const statsData = await env.WHATPULSE_DATA.get("stats", { type: "json" });
      console.log("[fetch] Stats data:", JSON.stringify(statsData));

      if (statsData) {
        console.log("[fetch] Applying HTMLRewriter transformation...");
        try {
          const transformed = new HTMLRewriter()
            .on(
              "#activity-mouse-travel",
              new ElementHandler(statsData.distance)
            )
            .on("#activity-mouse-clicks", new ElementHandler(statsData.clicks))
            .on(
              "#activity-last-update",
              new ElementHandler(formatUpdateTime(statsData.updatedAt))
            )
            .transform(response);

          // Create a new response with modified headers to avoid immutability issues
          const newResponse = new Response(transformed.body, {
            status: transformed.status,
            statusText: transformed.statusText,
            headers: new Headers(transformed.headers),
          });
          newResponse.headers.set("Cache-Control", "public, max-age=60");

          console.log(
            "[fetch] Transformation successful, returning modified response"
          );
          return newResponse;
        } catch (error) {
          console.error("[fetch] HTMLRewriter error:", error.message);
          return response;
        }
      } else {
        console.log("[fetch] No stats data found in KV");
      }
    }
    console.log("[fetch] Returning original response");
    return response;
  },
};

class ElementHandler {
  constructor(content) {
    this.content = content;
  }
  element(element) {
    if (this.content) element.setInnerContent(this.content);
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
