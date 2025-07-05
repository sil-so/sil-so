// _worker.js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Handle the root path explicitly to serve index.html
    if (url.pathname === '/') {
      // Create a new request for /index.html
      const newRequest = new Request(new URL('/index.html', request.url), request);
      return env.ASSETS.fetch(newRequest);
    }

    try {
      // 2. Try to fetch the asset directly (e.g., /css/style.css or /images/logo.png)
      // This is the default behavior and handles all non-HTML assets.
      return await env.ASSETS.fetch(request);
    } catch (error) {
      // 3. If the direct fetch fails, it might be a "clean URL" for an HTML page.
      // We check if the path has an extension. If it doesn't, we try adding .html.
      const hasExtension = url.pathname.split('/').pop().includes('.');
      if (!hasExtension) {
        try {
          // Construct a new request for the corresponding .html file
          const htmlRequest = new Request(new URL(url.pathname + '.html', request.url), request);
          return await env.ASSETS.fetch(htmlRequest);
        } catch (htmlError) {
          // If the .html version also doesn't exist, we'll fall through to the 404 page.
        }
      }
    }

    // 4. If all other attempts fail, serve the custom 404 page
    const notFoundRequest = new Request(new URL('/404.html', request.url), request);
    return env.ASSETS.fetch(notFoundRequest);
  }
};