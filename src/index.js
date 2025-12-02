import { getAssetFromKV } from '@cloudflare/kv-asset-handler';

export default {
  async fetch(request, env) {
    try {
      return await getAssetFromKV(request, {
        mapRequestToAssetKey: ({ request }) => {
          let { pathname } = new URL(request.url);
          pathname = pathname === '/' ? '/index.html' : pathname;
          return new Request(new URL(pathname, request.url), request);
        }
      });
    } catch (e) {
      let pathname = new URL(request.url).pathname;
      return new Response(`"${pathname}" not found`, {
        status: 404,
        statusText: 'not found',
      });
    }
  }
};
