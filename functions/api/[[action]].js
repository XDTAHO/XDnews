export async function onRequest(context) {
  const { request, env, params } = context;
  const action = params.action[0];
  const url = new URL(request.url);

  // 防呆機制：取得 KV (如果沒綁定也不會整個系統崩潰)
  const kv = env.NOTICE_BOARD_KV;

  // ==========================================
  // 1. 讀取公告列表 (支援條件過濾)
  // ==========================================
  if (action === 'getPosts') {
    let posts = null;

    // 嘗試從 KV 拿資料
    if (kv) {
       try { posts = await kv.get('ALL_POSTS', { type: 'json' }); } catch(e) { console.log("KV 讀取失敗"); }
    }

    // 如果 KV 沒資料 (或沒綁定)，退回向 GAS 索取
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

      // 順手存回 KV
      if (kv && posts) {
         await kv.put('ALL_POSTS', JSON.stringify(posts));
      }
    } else {
      // 如果資料是從 KV 來的，我們要在 Cloudflare 端執行「日期與關鍵字」過濾
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
      } catch(e) { /* 忽略解析錯誤，回傳全部 */ }
    }

    // 確保永遠回傳陣列，避免前端 map() 報錯
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
