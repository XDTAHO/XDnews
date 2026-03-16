export async function onRequest(context) {
  const { request, env, params } = context;
  const action = params.action[0]; // 取得路由動作，例如 'getPosts' 或 'getFile'
  const url = new URL(request.url);

  // ==========================================
  // 1. 讀取公告列表：直接讀取 Cloudflare KV (極速)
  // ==========================================
  if (request.method === 'GET' && action === 'getPosts') {
    let posts = await env.NOTICE_BOARD_KV.get('ALL_POSTS', { type: 'json' });
    
    // 避險機制：如果 KV 是空的，臨時去 GAS 抓一份
    if (!posts) {
      const res = await fetch(`${env.GAS_URL}?action=getPosts&api_secret=${env.API_SECRET}`);
      const json = await res.json();
      posts = json.data;
      if (posts) await env.NOTICE_BOARD_KV.put('ALL_POSTS', JSON.stringify(posts));
    }
    
    return new Response(JSON.stringify({ success: true, data: posts }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // ==========================================
  // 2. 檔案代理與快取：將 Base64 轉回實體檔案並存入 CF CDN
  // ==========================================
  if (request.method === 'GET' && action === 'getFile') {
    const fileId = url.searchParams.get('id');
    const cache = caches.default;
    
    // 檢查 CF CDN 是否已經有這個檔案的快取
    let cachedResponse = await cache.match(request);
    if (cachedResponse) return cachedResponse;

    // 若無快取，向 GAS 索取檔案 (GAS 會回傳 Base64 JSON)
    const res = await fetch(`${env.GAS_URL}?action=getFileBlob&fileId=${fileId}&api_secret=${env.API_SECRET}`);
    const json = await res.json();
    
    if (json.success && json.data) {
      // 將 Base64 解碼還原為二進位 (Binary) 資料流
      const binaryString = atob(json.data.base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const fileResponse = new Response(bytes, {
        headers: {
          'Content-Type': json.data.mime,
          // 設定邊緣快取 7 天 (604800 秒)，徹底解決連結過期與配額問題
          'Cache-Control': 'public, max-age=604800',
          'Content-Disposition': `inline; filename="${encodeURIComponent(json.data.name)}"`
        }
      });
      
      // 存入 CF 快取
      context.waitUntil(cache.put(request, fileResponse.clone()));
      return fileResponse;
    }
    return new Response(JSON.stringify({ error: 'File not found' }), { status: 404 });
  }

  // ==========================================
  // 3. 通用 API 轉發 (登入、存檔、刪除等操作)
  // ==========================================
  const gasUrl = new URL(env.GAS_URL);
  // 複製前端傳來的參數
  url.searchParams.forEach((val, key) => gasUrl.searchParams.append(key, val));
  gasUrl.searchParams.set('action', action);
  gasUrl.searchParams.set('api_secret', env.API_SECRET);

  const fetchOpts = { method: request.method, headers: request.headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    fetchOpts.body = await request.text(); // 轉發 POST Body
  }

  const response = await fetch(gasUrl.toString(), fetchOpts);
  
  // 原封不動回傳 GAS 的處理結果
  return new Response(response.body, response);
}
