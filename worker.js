// worker.js
import { AwsClient } from 'aws4fetch';
import { XMLParser } from 'fast-xml-parser';

// ========== KV 操作辅助 ==========
async function getBucketsConfig(env) {
  const data = await env.BUCKET_CONFIG.get('buckets', 'json');
  return data || [];
}

async function saveBucketsConfig(env, config) {
  await env.BUCKET_CONFIG.put('buckets', JSON.stringify(config));
}

function getBucketById(config, id) {
  return config.find(b => b.id === id);
}

// ========== 密码哈希管理 ==========
async function getAdminPwdHash(env) {
  return await env.BUCKET_CONFIG.get('admin_pwd_hash');
}

async function setAdminPwdHash(env, hash) {
  await env.BUCKET_CONFIG.put('admin_pwd_hash', hash);
}

async function hashPassword(pwd) {
  const data = new TextEncoder().encode(pwd);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// ========== 登录历史管理 ==========
const LOGIN_HISTORY_KEY = 'login_history';
const MAX_HISTORY = 25;

async function addLoginHistory(env, info) {
  const raw = await env.SESSION_KV.get(LOGIN_HISTORY_KEY, 'json');
  let history = raw || [];
  const existingIndex = history.findIndex(item => item.ip === info.ip && item.ua === info.ua);
  if (existingIndex !== -1) {
    history[existingIndex].time = info.time;
    history[existingIndex].token = info.token;
    history[existingIndex].id = info.id;
  } else {
    history.unshift(info);
    if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  }
  await env.SESSION_KV.put(LOGIN_HISTORY_KEY, JSON.stringify(history));
}

async function updateLoginHistoryByToken(env, token) {
  const raw = await env.SESSION_KV.get(LOGIN_HISTORY_KEY, 'json');
  if (!raw) return;
  let history = raw;
  const index = history.findIndex(item => item.token === token);
  if (index !== -1) {
    history[index].time = new Date().toISOString();
    await env.SESSION_KV.put(LOGIN_HISTORY_KEY, JSON.stringify(history));
  }
}

async function getLoginHistory(env) {
  const raw = await env.SESSION_KV.get(LOGIN_HISTORY_KEY, 'json');
  return raw || [];
}

async function deleteLoginHistory(env, historyId) {
  const history = await getLoginHistory(env);
  const target = history.find(item => item.id === historyId);
  if (!target) return false;
  if (target.token) {
    await env.SESSION_KV.delete(target.token);
  }
  const newHistory = history.filter(item => item.id !== historyId);
  await env.SESSION_KV.put(LOGIN_HISTORY_KEY, JSON.stringify(newHistory));
  return true;
}

async function revokeAllSessions(env) {
  let cursor;
  const keysToDelete = [];
  do {
    const listResult = await env.SESSION_KV.list({ cursor });
    keysToDelete.push(...listResult.keys.map(k => k.name));
    cursor = listResult.cursor;
  } while (cursor);
  if (keysToDelete.length > 0) {
    await Promise.all(keysToDelete.map(key => env.SESSION_KV.delete(key)));
  }
  await env.SESSION_KV.put(LOGIN_HISTORY_KEY, JSON.stringify([]));
  return keysToDelete.length;
}

function encodeS3Key(key) {
  return key.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

// ========== 存储客户端封装 ==========
class R2CompatibleClient {
  constructor(config) {
    this.config = config;
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.client = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      service: 's3',
      region: 'auto',
      endpoint: this.endpoint,
    });
    this.bucketName = config.id;
  }

  async list({ prefix = '', delimiter = '/' } = {}) {
    const url = `${this.endpoint}/${encodeURIComponent(this.bucketName)}?list-type=2&prefix=${encodeS3Key(prefix)}&delimiter=${encodeURIComponent(delimiter)}`;
    const resp = await this.client.fetch(url, { method: 'GET' });
    if (!resp.ok) throw new Error(`List failed: ${resp.status}`);
    const text = await resp.text();
    const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false });
    const result = parser.parse(text);
    const root = result?.ListBucketResult || {};
    const objects = [];
    const contents = root.Contents || [];
    if (Array.isArray(contents)) {
      for (const c of contents) {
        const key = c.Key || '';
        const size = parseInt(c.Size || '0');
        const lastModified = c.LastModified || '';
        objects.push({ key, size, uploaded: new Date(lastModified) });
      }
    } else if (contents.Key) {
      const key = contents.Key || '';
      const size = parseInt(contents.Size || '0');
      const lastModified = contents.LastModified || '';
      objects.push({ key, size, uploaded: new Date(lastModified) });
    }
    const delimitedPrefixes = [];
    const prefixes = root.CommonPrefixes || [];
    if (Array.isArray(prefixes)) {
      for (const p of prefixes) {
        const name = p.Prefix || '';
        delimitedPrefixes.push(name);
      }
    } else if (prefixes.Prefix) {
      delimitedPrefixes.push(prefixes.Prefix);
    }
    return { objects, delimitedPrefixes };
  }

  async put(key, body, { httpMetadata = {} } = {}) {
    const url = `${this.endpoint}/${encodeURIComponent(this.bucketName)}/${encodeS3Key(key)}`;
    const resp = await this.client.fetch(url, {
      method: 'PUT',
      body: body,
      headers: { 'Content-Type': httpMetadata.contentType || 'application/octet-stream' }
    });
    if (!resp.ok) throw new Error(`Put failed: ${resp.status}`);
  }

  async get(key) {
    const url = `${this.endpoint}/${encodeURIComponent(this.bucketName)}/${encodeS3Key(key)}`;
    const resp = await this.client.fetch(url, { method: 'GET' });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`Get failed: ${resp.status}`);
    const body = resp.body;
    const httpMetadata = { contentType: resp.headers.get('Content-Type') || 'application/octet-stream' };
    const size = parseInt(resp.headers.get('Content-Length') || '0');
    const httpEtag = resp.headers.get('ETag') || '';
    return {
      body,
      httpMetadata,
      size,
      httpEtag,
      text: async () => {
        const reader = body.getReader();
        const chunks = [];
        let total = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.length;
        }
        const buffer = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          buffer.set(chunk, offset);
          offset += chunk.length;
        }
        return new TextDecoder().decode(buffer);
      }
    };
  }

  async delete(key) {
    const url = `${this.endpoint}/${encodeURIComponent(this.bucketName)}/${encodeS3Key(key)}`;
    const resp = await this.client.fetch(url, { method: 'DELETE' });
    if (resp.status === 404) return;
    if (!resp.ok) throw new Error(`Delete failed: ${resp.status}`);
  }

  async head(key) {
    const url = `${this.endpoint}/${encodeURIComponent(this.bucketName)}/${encodeS3Key(key)}`;
    const resp = await this.client.fetch(url, { method: 'HEAD' });
    if (resp.status === 404) return null;
    if (resp.status === 200) return { size: parseInt(resp.headers.get('Content-Length') || '0') };
    throw new Error(`Head failed: ${resp.status}`);
  }
}

// ========== 获取桶实例 ==========
async function getBucketInstance(env, bucketId) {
  const configs = await getBucketsConfig(env);
  const conf = getBucketById(configs, bucketId);
  if (!conf) throw new Error(`Bucket config not found: ${bucketId}`);
  return new R2CompatibleClient(conf);
}

// ========== 获取桶用量 ==========
async function getBucketUsage(accountId, bucketName, apiToken) {
  if (!apiToken) return null;
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${bucketName}/usage`;
  const resp = await fetch(url, {
    headers: { 'Authorization': `Bearer ${apiToken}` }
  });
  if (!resp.ok) return null;
  const json = await resp.json();
  return json.result?.payloadSize || null;
}

// ========== Worker 主函数 ==========
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ---- 前端基础地址 ----
    const frontendBase = env.ADMIN_URL || 'https://link9596.github.io/one-bucket';

    // ---- API 路径定义 ----
    const apiMap = {
      '/login': ['POST'],
      '/logout': ['POST'],
      '/admin/change-password': ['POST'],
      '/admin/buckets': ['GET', 'POST'],
      '/admin/login-history': ['GET'],
      '/admin/delete-login-history': ['POST'],
      '/admin/update-session': ['POST'],
      '/list': ['GET'],
      '/upload': ['POST'],
      '/mkdir': ['POST'],
      '/del': ['DELETE'],
      '/download': ['GET'],
      '/read': ['GET'],
      '/write': ['PUT'],
      '/rename': ['POST'],
      '/usage': ['GET'],
    };
    const isApi = apiMap[path]?.includes(method) || (path.startsWith('/admin/') && method === 'POST');

    // ---- 非 API 请求：代理到前端 ----
    if (!isApi) {
      // 静态资源匹配
      const isStatic = path.startsWith('/file/') || /\.(css|js|png|jpg|jpeg|gif|svg|ico|webp|woff2?|ttf|eot|json|xml|txt)$/.test(path);
      
      if (isStatic) {
        // 代理静态资源
        const targetUrl = new URL(path + url.search, frontendBase);
        const proxyRequest = new Request(targetUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.body,
        });
        try {
          const response = await fetch(proxyRequest);
          const headers = new Headers(response.headers);
          headers.delete('content-security-policy');
          return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        } catch (e) {
          console.error(`[Static Proxy Error] ${e.message}`);
          return new Response('Static proxy error: ' + e.message, { status: 502 });
        }
      } else {
        // SPA 路由：返回 index.html（强制 200）
        const indexUrl = frontendBase + '/index.html';
        try {
          const indexResponse = await fetch(indexUrl);
          const headers = new Headers(indexResponse.headers);
          headers.set('Content-Type', 'text/html; charset=utf-8');
          headers.delete('content-security-policy');
          return new Response(indexResponse.body, {
            status: 200,
            headers,
          });
        } catch (e) {
          console.error(`[SPA Fallback Error] ${e.message}`);
          return new Response('SPA fallback error: ' + e.message, { status: 502 });
        }
      }
    }

    // ---- API 处理（无 CORS，同源） ----
    const getToken = () => {
      const cookie = request.headers.get('Cookie') || '';
      const cookieToken = cookie.match(/token=([^;]+)/)?.[1];
      if (cookieToken) return cookieToken;
      const auth = request.headers.get('Authorization');
      if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
      return null;
    };

    // 登录
    if (path === "/login" && method === "POST") {
      const { pwd } = await request.json();
      if (!pwd) {
        return Response.json({ code: 400, msg: "请输入密码" }, { status: 400 });
      }
      const storedHash = await getAdminPwdHash(env);
      if (!storedHash) {
        return Response.json({ code: 503, msg: "管理员密码尚未设置，请通过修改密码接口初始化" }, { status: 503 });
      }
      const inputHash = await hashPassword(pwd);
      if (inputHash !== storedHash) {
        return Response.json({ code: 401, msg: "密码错误" }, { status: 401 });
      }
      const token = crypto.randomUUID();
      await env.SESSION_KV.put(token, "valid", { expirationTtl: 604800 });
      const cookie = `token=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=604800; Path=/`;

      const historyRecord = {
        id: crypto.randomUUID(),
        time: new Date().toISOString(),
        ua: request.headers.get('User-Agent') || '',
        ip: request.headers.get('CF-Connecting-IP') || '',
        token: token
      };
      await addLoginHistory(env, historyRecord);

      return new Response(JSON.stringify({ code: 200, msg: "登录成功" }), {
        headers: {
          'Content-Type': 'application/json;charset=utf-8',
          'Set-Cookie': cookie,
        }
      });
    }

    // 登出
    if (path === "/logout" && method === "POST") {
      const token = getToken();
      if (token) await env.SESSION_KV.delete(token);
      return new Response(JSON.stringify({ code: 200, msg: "已登出" }), {
        headers: {
          'Content-Type': 'application/json;charset=utf-8',
          'Set-Cookie': 'token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict'
        }
      });
    }

    // 修改密码
    if (path === "/admin/change-password" && method === "POST") {
      const { oldPwd, newPwd } = await request.json();
      if (!newPwd || newPwd.length < 6) {
        return Response.json({ code: 400, msg: "新密码长度至少6位" }, { status: 400 });
      }
      const storedHash = await getAdminPwdHash(env);
      if (storedHash) {
        if (!oldPwd) {
          return Response.json({ code: 400, msg: "请输入旧密码" }, { status: 400 });
        }
        const oldHash = await hashPassword(oldPwd);
        if (oldHash !== storedHash) {
          return Response.json({ code: 401, msg: "旧密码错误" }, { status: 401 });
        }
      }
      const newHash = await hashPassword(newPwd);
      await setAdminPwdHash(env, newHash);
      const deletedCount = await revokeAllSessions(env);
      return Response.json({ code: 200, msg: `密码已修改，已注销 ${deletedCount} 个会话` }, {
        headers: { 'Content-Type': 'application/json;charset=utf-8' }
      });
    }

    // 全局鉴权（登录、登出、改密已提前处理）
    if (path !== "/login" && path !== "/logout" && path !== "/admin/change-password") {
      const token = getToken();
      if (!token) {
        return Response.json({ code: 401, msg: "未授权" }, { status: 401 });
      }
      const isValid = await env.SESSION_KV.get(token);
      if (!isValid) {
        return Response.json({ code: 401, msg: "token 无效或已过期" }, { status: 401 });
      }
    }

    // 更新会话
    if (path === "/admin/update-session" && method === "POST") {
      const token = getToken();
      if (token) {
        await updateLoginHistoryByToken(env, token);
      }
      return Response.json({ code: 200, msg: "OK" }, {
        headers: { 'Content-Type': 'application/json;charset=utf-8' }
      });
    }

    // 登录历史
    if (path === "/admin/login-history" && method === "GET") {
      const history = await getLoginHistory(env);
      const safeHistory = history.map(item => ({
        id: item.id,
        time: item.time,
        ua: item.ua,
        ip: item.ip
      }));
      return Response.json({ code: 200, data: safeHistory }, {
        headers: { 'Content-Type': 'application/json;charset=utf-8' }
      });
    }

    if (path === "/admin/delete-login-history" && method === "POST") {
      const { id } = await request.json();
      if (!id) {
        return Response.json({ code: 400, msg: "缺少记录ID" }, { status: 400 });
      }
      const success = await deleteLoginHistory(env, id);
      if (!success) {
        return Response.json({ code: 404, msg: "记录不存在" }, { status: 404 });
      }
      return Response.json({ code: 200, msg: "已删除该登录会话" }, {
        headers: { 'Content-Type': 'application/json;charset=utf-8' }
      });
    }

    // 桶配置管理
    if (path === "/admin/buckets" && method === "GET") {
      const configs = await getBucketsConfig(env);
      const safe = configs.map(c => ({
        id: c.id,
        name: c.name,
        accountId: c.accountId,
        endpoint: c.endpoint,
        accessKeyId: c.accessKeyId,
        hasSecret: !!c.secretAccessKey,
        hasToken: !!c.apiToken,
        publicDomain: c.publicDomain || ''
      }));
      return Response.json({ code: 200, data: safe }, {
        headers: { 'Content-Type': 'application/json;charset=utf-8' }
      });
    }

    if (path === "/admin/buckets" && method === "POST") {
      const body = await request.json();
      const newConfigs = body.data || [];
      const oldConfigs = await getBucketsConfig(env);
      const merged = newConfigs.map(newItem => {
        const oldItem = oldConfigs.find(o => o.id === newItem.id);
        return {
          id: newItem.id,
          name: newItem.name,
          accountId: newItem.accountId,
          endpoint: newItem.endpoint,
          accessKeyId: newItem.accessKeyId,
          secretAccessKey: newItem.secretAccessKey || oldItem?.secretAccessKey || '',
          apiToken: newItem.apiToken || oldItem?.apiToken || '',
          publicDomain: newItem.publicDomain || oldItem?.publicDomain || ''
        };
      });
      for (const c of merged) {
        if (!c.id || !c.name || !c.endpoint || !c.accessKeyId || !c.secretAccessKey) {
          return Response.json({ code: 400, msg: "配置不完整" }, { status: 400 });
        }
      }
      await saveBucketsConfig(env, merged);
      return Response.json({ code: 200, msg: "配置已更新" }, {
        headers: { 'Content-Type': 'application/json;charset=utf-8' }
      });
    }

    // ========== 业务接口 ==========
    const bucketId = url.searchParams.get('bucketId');
    if (!bucketId) {
      return Response.json({ code: 400, msg: "缺少 bucketId 参数" }, { status: 400 });
    }

    let bucket;
    try {
      bucket = await getBucketInstance(env, bucketId);
    } catch (e) {
      return Response.json({ code: 404, msg: e.message }, { status: 404 });
    }

    const allConfigs = await getBucketsConfig(env);
    const bucketConf = getBucketById(allConfigs, bucketId);

    if (path === "/mkdir" && method === "POST") {
      let folderPath = decodeURIComponent(url.searchParams.get("path") || "");
      if (!folderPath.endsWith("/")) folderPath += "/";
      await bucket.put(folderPath, "", { httpMetadata: { contentType: "application/folder" } });
      return Response.json({ code: 200, msg: "文件夹创建成功" }, {
        headers: { 'Content-Type': 'application/json;charset=utf-8' }
      });
    }

    if (path === "/list" && method === "GET") {
      const curPath = decodeURIComponent(url.searchParams.get("path") || "");
      const res = await bucket.list({ prefix: curPath, delimiter: "/" });
      const folders = res.delimitedPrefixes.map(p => ({ name: p, isFolder: true, path: p, url: "" }));
      const publicDomain = bucketConf?.publicDomain || '';
      const files = res.objects.map(item => ({
        name: item.key.replace(curPath, ""),
        fullKey: item.key,
        size: item.size,
        uploadTime: item.uploaded,
        url: publicDomain ? `${publicDomain}/${encodeS3Key(item.key)}` : '',
        downloadUrl: `/download?bucketId=${bucketId}&key=${encodeURIComponent(item.key)}`,
        isFolder: false
      }));
      return Response.json({ code: 200, curPath, folders, files }, {
        headers: { 'Content-Type': 'application/json;charset=utf-8' }
      });
    }

    if (path === "/upload" && method === "POST") {
      const curPath = decodeURIComponent(url.searchParams.get("path") || "");
      const formData = await request.formData();
      const file = formData.get("file");
      if (!file) return Response.json({ code: 400, msg: "无文件" }, { status: 400 });
      const fullKey = curPath + file.name;
      await bucket.put(fullKey, file.stream(), { httpMetadata: { contentType: file.type } });
      const publicDomain = bucketConf?.publicDomain || '';
      return Response.json({
        code: 200,
        fullKey,
        url: publicDomain ? `${publicDomain}/${encodeS3Key(fullKey)}` : ''
      }, {
        headers: { 'Content-Type': 'application/json;charset=utf-8' }
      });
    }

    if (path === "/del" && method === "DELETE") {
      const fullKey = decodeURIComponent(url.searchParams.get("key"));
      if (!fullKey) return Response.json({ code: 400, msg: "缺少路径" }, { status: 400 });
      await bucket.delete(fullKey);
      return Response.json({ code: 200, msg: "删除成功" }, {
        headers: { 'Content-Type': 'application/json;charset=utf-8' }
      });
    }

    if (path === "/download" && method === "GET") {
      const fullKey = decodeURIComponent(url.searchParams.get("key") || "");
      if (!fullKey) return Response.json({ code: 400, msg: "缺少文件路径" }, { status: 400 });
      const object = await bucket.get(fullKey);
      if (!object) return Response.json({ code: 404, msg: "文件不存在" }, { status: 404 });
      const fileName = fullKey.split("/").pop() || "download";
      const asciiFileName = fileName.replace(/[^\x20-\x7E]/g, '_');
      const contentDisposition = `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
      const headers = {
        "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
        "Content-Disposition": contentDisposition,
        "Content-Length": String(object.size),
        "ETag": object.httpEtag || '',
      };
      return new Response(object.body, { headers });
    }

    if (path === "/read" && method === "GET") {
      const fullKey = decodeURIComponent(url.searchParams.get("key") || "");
      if (!fullKey) return Response.json({ code: 400, msg: "缺少文件路径" }, { status: 400 });
      const object = await bucket.get(fullKey);
      if (!object) return Response.json({ code: 404, msg: "文件不存在" }, { status: 404 });
      if (object.size > 2 * 1024 * 1024) return Response.json({ code: 413, msg: "文件过大，无法在线编辑" }, { status: 413 });
      const text = await object.text();
      return Response.json({ code: 200, content: text }, {
        headers: { 'Content-Type': 'application/json;charset=utf-8' }
      });
    }

    if (path === "/write" && method === "PUT") {
      const fullKey = decodeURIComponent(url.searchParams.get("key") || "");
      if (!fullKey) return Response.json({ code: 400, msg: "缺少文件路径" }, { status: 400 });
      const { content } = await request.json();
      if (typeof content !== "string") return Response.json({ code: 400, msg: "内容格式错误" }, { status: 400 });
      if (new TextEncoder().encode(content).length > 2 * 1024 * 1024) return Response.json({ code: 413, msg: "内容过大，无法保存" }, { status: 413 });

      const ext = fullKey.split('.').pop().toLowerCase();
      const mimeTypes = {
        'html': 'text/html; charset=utf-8',
        'htm': 'text/html; charset=utf-8',
        'css': 'text/css; charset=utf-8',
        'js': 'application/javascript; charset=utf-8',
        'mjs': 'application/javascript; charset=utf-8',
        'json': 'application/json; charset=utf-8',
        'txt': 'text/plain; charset=utf-8',
        'md': 'text/markdown; charset=utf-8',
        'xml': 'application/xml; charset=utf-8',
        'svg': 'image/svg+xml; charset=utf-8',
        'csv': 'text/csv; charset=utf-8',
        'yml': 'text/yaml; charset=utf-8',
        'yaml': 'text/yaml; charset=utf-8',
        'log': 'text/plain; charset=utf-8',
        'ini': 'text/plain; charset=utf-8',
        'conf': 'text/plain; charset=utf-8',
      };
      const contentType = mimeTypes[ext] || 'text/plain; charset=utf-8';
      await bucket.put(fullKey, content, { httpMetadata: { contentType } });
      return Response.json({ code: 200, msg: "保存成功" }, {
        headers: { 'Content-Type': 'application/json;charset=utf-8' }
      });
    }

    if (path === "/rename" && method === "POST") {
      const oldKey = decodeURIComponent(url.searchParams.get("oldKey") || "");
      const newName = decodeURIComponent(url.searchParams.get("newName") || "");
      if (!oldKey || !newName) return Response.json({ code: 400, msg: "缺少参数" }, { status: 400 });
      if (newName.includes("/")) return Response.json({ code: 400, msg: "新名称不能包含 /" }, { status: 400 });

      const isFolder = oldKey.endsWith("/");
      let newKey;
      if (isFolder) {
        const folderPath = oldKey.slice(0, -1);
        const lastSlash = folderPath.lastIndexOf("/");
        const parentDir = lastSlash >= 0 ? folderPath.substring(0, lastSlash + 1) : "";
        newKey = parentDir + newName + "/";
      } else {
        const lastSlash = oldKey.lastIndexOf("/");
        const dirPath = lastSlash >= 0 ? oldKey.substring(0, lastSlash + 1) : "";
        newKey = dirPath + newName;
      }

      const existing = await bucket.head(newKey);
      if (existing) return Response.json({ code: 409, msg: "目标名称已存在" }, { status: 409 });

      if (!isFolder) {
        const object = await bucket.get(oldKey);
        if (!object) return Response.json({ code: 404, msg: "原文件不存在" }, { status: 404 });
        if (object.size > 100 * 1024 * 1024) return Response.json({ code: 413, msg: "文件过大，暂不支持重命名" }, { status: 413 });
        await bucket.put(newKey, object.body, { httpMetadata: object.httpMetadata });
        await bucket.delete(oldKey);
        return Response.json({ code: 200, msg: "重命名成功", newKey }, {
          headers: { 'Content-Type': 'application/json;charset=utf-8' }
        });
      } else {
        const listResult = await bucket.list({ prefix: oldKey });
        if (listResult.objects.length === 0) return Response.json({ code: 404, msg: "原文件夹不存在或为空" }, { status: 404 });
        if (listResult.objects.length > 1000) return Response.json({ code: 413, msg: "文件夹内文件过多，暂不支持重命名" }, { status: 413 });

        for (const obj of listResult.objects) {
          const oldObjKey = obj.key;
          const relativePart = oldObjKey.substring(oldKey.length);
          const newObjKey = newKey + relativePart;
          const object = await bucket.get(oldObjKey);
          if (object) await bucket.put(newObjKey, object.body, { httpMetadata: object.httpMetadata });
        }
        for (const obj of listResult.objects) {
          await bucket.delete(obj.key);
        }
        return Response.json({ code: 200, msg: "文件夹重命名成功", newKey }, {
          headers: { 'Content-Type': 'application/json;charset=utf-8' }
        });
      }
    }

    if (path === "/usage" && method === "GET") {
      const conf = getBucketById(allConfigs, bucketId);
      if (!conf) return Response.json({ code: 404, msg: "桶配置不存在" }, { status: 404 });
      const usage = await getBucketUsage(conf.accountId, conf.id, conf.apiToken);
      if (usage === null) {
        return Response.json({ code: 500, msg: "获取用量失败，请检查 API Token 权限" }, { status: 500 });
      }
      return Response.json({ code: 200, size: usage }, {
        headers: { 'Content-Type': 'application/json;charset=utf-8' }
      });
    }

    return Response.json({ msg: "接口不存在" }, { status: 404 });
  }
};
