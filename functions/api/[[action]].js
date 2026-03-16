export async function onRequest(context) {
  const { request, env, params } = context;
  const action = params.action[0];
  const url = new URL(request.url);

  // 1. 讀取公告列表：攔截並讀取 KV (不再限制必須是 GET)
  if (action === 'getPosts') {
    let posts = await env.NOTICE_BOARD_KV.get('ALL_POSTS', { type: 'json' });
    if (!posts) {
      // KV 無資料，轉發請求給 GAS (包含 Body)
      const gasUrl = new URL(env.GAS_URL);
      gasUrl.searchParams.set('action', 'getPosts');
      gasUrl.searchParams.set('api_secret', env.API_SECRET);
      
      const reqClone = request.clone();
      const res = await fetch(gasUrl.toString(), {
        method: request.method,
        headers: reqClone.headers,
        body: request.method === 'POST' ? await reqClone.text() : null
      });
      const json = await res.json();
      posts = json.data;
      if (posts) await env.NOTICE_BOARD_KV.put('ALL_POSTS', JSON.stringify(posts));
    }
    return new Response(JSON.stringify({ success: true, data: posts }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // 2. 檔案代理與快取
  if (request.method === 'GET' && action === 'getFile') {
    const fileId = url.searchParams.get('id');
    const cache = caches.default;
    let cachedResponse = await cache.match(request);
    if (cachedResponse) return cachedResponse;

    const res = await fetch(`${env.GAS_URL}?action=getFileBlob&fileId=${fileId}&api_secret=${env.API_SECRET}`);
    const json = await res.json();
    
    if (json.success && json.data) {
      const binaryString = atob(json.data.base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);

      const fileResponse = new Response(bytes, {
        headers: {
          'Content-Type': json.data.mime,
          'Cache-Control': 'public, max-age=604800', // 快取 7 天
          'Content-Disposition': `inline; filename="${encodeURIComponent(json.data.name)}"`
        }
      });
      context.waitUntil(cache.put(request, fileResponse.clone()));
      return fileResponse;
    }
    return new Response(JSON.stringify({ error: 'File not found' }), { status: 404 });
  }

  // 3. 其他操作轉發 (登入、存檔等)
  const gasUrl = new URL(env.GAS_URL);
  url.searchParams.forEach((val, key) => gasUrl.searchParams.append(key, val));
  gasUrl.searchParams.set('action', action);
  gasUrl.searchParams.set('api_secret', env.API_SECRET);

  const fetchOpts = { method: request.method, headers: request.headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') fetchOpts.body = await request.text();
  
  const response = await fetch(gasUrl.toString(), fetchOpts);
  return new Response(response.body, response);
}
