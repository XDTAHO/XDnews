export async function onRequest(context) {
  const { request, env, params } = context;
  const action = params.action[0];
  const url = new URL(request.url);
  const kv = env.NOTICE_BOARD_KV;

  // ==========================================
  // 0. 處理 Sync Webhook (接收 GAS 更新通知並寫入 KV)
  // ==========================================
  if (action === 'sync') {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    // 驗證是否真的是從 GAS 傳來的
    const authHeader = request.headers.get('Authorization');
    if (authHeader !== `Bearer ${env.API_SECRET}`) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    try {
      // 向 GAS 索取最新的公告列表
      const gasUrl = `${env.GAS_URL}?action=getPosts&api_secret=${env.API_SECRET}`;
      const res = await fetch(gasUrl);
      const json = await res.json();

      if (json.success && kv) {
        // 成功！寫入 CF KV 資料庫
        await kv.put('ALL_POSTS', JSON.stringify(json.data));
        return new Response(JSON.stringify({ success: true, message: 'KV Database Synced' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      throw new Error('Failed to fetch data from GAS or KV not bound');
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), { status: 500 });
    }
  }

  // ==========================================
  // 1. 讀取公告列表 (前端畫面呼叫)
  // ==========================================
  if (action === 'getPosts') {
    let posts = null;

    if (kv) {
       try { posts = await kv.get('ALL_POSTS', { type: 'json' }); } catch(e) { /* 忽略 */ }
    }

    if (!posts) {
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
      if (kv && posts) await kv.put('ALL_POSTS', JSON.stringify(posts));
    } else {
      try {
        const reqClone = request.clone();
        const body = await reqClone.json();
        if (body && body.filters && Array.isArray(posts)) {
          const q = (body.filters.search || "").toLowerCase();
          const dStart = body.filters.dateStart || "";
          const dEnd = body.filters.dateEnd || "";
          posts = posts.filter(p => {
            if (q && !p.title.toLowerCase().includes(q)) return false;
            const pDate = p.date.split(' ')[0];
            if (dStart && pDate < dStart) return false;
            if (dEnd && pDate > dEnd) return false;
            return true;
          });
        }
      } catch(e) {}
    }

    return new Response(JSON.stringify({ success: true, data: posts || [] }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ==========================================
  // 2. 檔案代理與快取
  // ==========================================
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
          'Cache-Control': 'public, max-age=604800',
          'Content-Disposition': `inline; filename="${encodeURIComponent(json.data.name)}"`
        }
      });
      context.waitUntil(cache.put(request, fileResponse.clone()));
      return fileResponse;
    }
    return new Response(JSON.stringify({ error: 'File not found' }), { status: 404 });
  }

  // ==========================================
  // 3. 其他操作轉發 (登入、存檔等)
  // ==========================================
  const gasUrl = new URL(env.GAS_URL);
  url.searchParams.forEach((val, key) => gasUrl.searchParams.append(key, val));
  gasUrl.searchParams.set('action', action);
  gasUrl.searchParams.set('api_secret', env.API_SECRET);

  const fetchOpts = { method: request.method, headers: request.headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') fetchOpts.body = await request.text();
  
  const response = await fetch(gasUrl.toString(), fetchOpts);
  return new Response(response.body, response);
}
