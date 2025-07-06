export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Redirect www → non-www
    if (url.hostname === "www.sil.so") {
      url.hostname = "sil.so";
      return Response.redirect(url.toString(), 301);
    }

    return env.ASSETS.fetch(request);
  }
}
