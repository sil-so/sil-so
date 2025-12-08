export async function handleScheduled(controller, env, ctx) {
  const RESET_CRON = "0 23 * * SUN";
  try {
    const response = await fetch(
      `https://whatpulse.org/api/v1/users/${env.WHATPULSE_USER_ID}`,
      {
        headers: {
          Authorization: `Bearer ${env.WHATPULSE_API_TOKEN}`,
          Accept: "application/json"
        }
      }
    );

    if (!response.ok)
      throw new Error(`WhatPulse API Error: ${response.status}`);

    const json = await response.json();
    if (!json.user?.totals) throw new Error("Structure mismatch");

    const currentMiles = parseFloat(json.user.totals.distance_miles || 0);
    const currentClicks = parseInt(json.user.totals.clicks || 0);

    let baselineMiles = parseFloat(
      await env.WHATPULSE_DATA.get("baseline_miles")
    );
    let baselineClicks = parseInt(
      await env.WHATPULSE_DATA.get("baseline_clicks")
    );

    // Allow manual testing via "Test" button (controller.cron is empty string)
    const isManualTest = controller.cron === "" || !controller.cron;
    const isResetTime = controller.cron === RESET_CRON;
    const isFirstRun = isNaN(baselineMiles) || isNaN(baselineClicks);

    if (isResetTime || isFirstRun || isManualTest) {
      await env.WHATPULSE_DATA.put("baseline_miles", currentMiles.toString());
      await env.WHATPULSE_DATA.put("baseline_clicks", currentClicks.toString());
      baselineMiles = currentMiles;
      baselineClicks = currentClicks;
    }

    const weeklyKm = ((currentMiles - baselineMiles) * 1.60934).toFixed(2);
    const weeklyClicks = currentClicks - baselineClicks;

    const stats = {
      distance: new Intl.NumberFormat("en-US").format(weeklyKm),
      clicks: new Intl.NumberFormat("en-US", {
        notation: "compact",
        maximumFractionDigits: 1
      }).format(weeklyClicks),
      updatedAt: new Date().toISOString()
    };

    await env.WHATPULSE_DATA.put("stats", JSON.stringify(stats));
  } catch (error) {
    console.error(error.message);
  }
}

export async function injectWhatPulseStats(response, env, handlers) {
  const { AssetPathHandler, SrcSetHandler, LinkHandler, TextHandler } =
    handlers;

  const contentType = response.headers.get("content-type");
  if (contentType && contentType.includes("text/html")) {
    const statsData = await env.WHATPULSE_DATA.get("stats", { type: "json" });
    const data = statsData || {
      distance: "--",
      clicks: "--",
      updatedAt: null
    };

    return (
      new HTMLRewriter()
        .on("link[href]", new AssetPathHandler("href"))
        .on("script[src]", new AssetPathHandler("src"))
        .on("img[src]", new AssetPathHandler("src"))
        .on("img[srcset]", new SrcSetHandler())
        .on("a[href]", new LinkHandler())
        // Specific WhatPulse Handlers
        .on("#activity-mouse-travel", new TextHandler(data.distance))
        .on("#activity-mouse-clicks", new TextHandler(data.clicks))
        .on(
          "#activity-last-update",
          new TextHandler(formatUpdateTime(data.updatedAt))
        )
        .transform(response)
    );
  }

  return response;
}

function formatUpdateTime(isoString) {
  if (!isoString) return "";
  const date = new Date(isoString);
  return date
    .toLocaleTimeString("en-US", {
      hour: "numeric",
      hour12: true,
      timeZone: "Europe/Amsterdam",
      timeZoneName: "shortOffset"
    })
    .replace("GMT", "UTC");
}
