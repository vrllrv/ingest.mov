export default {
  async fetch(request) {
    const url = new URL(request.url);

    // Default to index.html for root
    let pathname = url.pathname;
    if (pathname === '/') {
      pathname = '/index.html';
    }

    // Try to fetch the file
    try {
      return await ASSETS.fetch(request);
    } catch (e) {
      // Return index.html for 404s (for SPA support)
      return await ASSETS.fetch(new Request(new URL('/index.html', url).toString(), request));
    }
  }
};
