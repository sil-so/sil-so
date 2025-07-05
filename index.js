export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/') {
      return env.ASSETS.fetch(new Request(new URL('/index.html', request.url), request));
    }

    try {
      return await env.ASSETS.fetch(request);
    } catch (error) {
      const hasExtension = url.pathname.split('/').pop().includes('.');
      if (!hasExtension) {
        try {
          const htmlRequest = new Request(new URL(url.pathname + '.html', request.url), request);
          return await env.ASSETS.fetch(htmlRequest);
        } catch (htmlError) {
        }
      }
    }

    const notFoundRequest = new Request(new URL('/404.html', request.url), request);
    return env.ASSETS.fetch(notFoundRequest);
  }
};