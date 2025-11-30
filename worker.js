export default {
  async scheduled(controller, env, ctx) {
    const RESET_CRON = "0 0 * * 1";

    try {
      const userID = env.WHATPULSE_USER_ID;
      const token = env.WHATPULSE_API_TOKEN;
      const response = await fetch(`https://whatpulse.org/api/v1/users/${userID}`, {
        headers: {
          "Authorization": `Bearer ${token}`,
          "Accept": "application/json"
        }
      });

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
        console.error("Structure mismatch: 'user.totals' not found in response");
        console.log("Full JSON:", JSON.stringify(json));
        return; 
      }

      let baselineMiles = parseFloat(await env.WHATPULSE_DATA.get("baseline_miles"));
      let baselineClicks = parseInt(await env.WHATPULSE_DATA.get("baseline_clicks"));

      const isResetTime = controller.cron === RESET_CRON;
      const isFirstRun = isNaN(baselineMiles) || isNaN(baselineClicks);

      if (isResetTime || isFirstRun) {
        await env.WHATPULSE_DATA.put("baseline_miles", currentMiles.toString());
        await env.WHATPULSE_DATA.put("baseline_clicks", currentClicks.toString());
        baselineMiles = currentMiles;
        baselineClicks = currentClicks;
        console.log("Weekly Baseline Reset Performed");
      }

      const weeklyMiles = currentMiles - baselineMiles;
      const weeklyClicks = currentClicks - baselineClicks;

      const weeklyKm = (weeklyMiles * 1.60934).toFixed(2);

      const stats = {
        distance: new Intl.NumberFormat('en-US').format(weeklyKm),
        clicks: new Intl.NumberFormat('en-US', { notation: "compact", maximumFractionDigits: 1 }).format(weeklyClicks),
        updatedAt: new Date().toISOString()
      };

      await env.WHATPULSE_DATA.put("stats", JSON.stringify(stats));
      console.log("Updated Stats Successfully:", stats);

    } catch (error) {
      console.error("Worker Error:", error.message);
      console.error(error.stack);
    }
  },

  async fetch(request, env, ctx) {
    const response = await env.ASSETS.fetch(request);
    const contentType = response.headers.get("content-type");

    if (contentType && contentType.includes("text/html")) {
      const statsData = await env.WHATPULSE_DATA.get("stats", { type: "json" });
      
      if (statsData) {
        return new HTMLRewriter()
          .on("#activity-mouse-travel", new ElementHandler(statsData.distance))
          .on("#activity-mouse-clicks", new ElementHandler(statsData.clicks))
          .on("#activity-last-update", new ElementHandler(formatUpdateTime(statsData.updatedAt)))
          .transform(response);
      }
    }
    return response;
  }
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
  return new Date(isoString).toLocaleTimeString('en-US', {
    hour: 'numeric',
    hour12: true,
    timeZone: 'Europe/Amsterdam'
  });
}
