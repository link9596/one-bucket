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
  history.unshift(info);
  if (history.length > MAX_HISTORY) history = history.slice(0, MAX_HISTORY);
  await env.SESSION_KV.put(LOGIN_HISTORY_KEY, JSON.stringify(history));
}

async function getLoginHistory(env) {
  const raw = await env.SESSION_KV.get(LOGIN_HISTORY_KEY, 'json');
  return raw || [];
}

async function deleteLoginHistory(env, historyId) {
  const history = await getLoginHistory(env);
  const target = history.find(item => item.id === historyId);
  if (!target) return false;
  // 删除对应会话 token
  if (target.token) {
    await env.SESSION_KV.delete(target.token);
  }
  // 从历史中移除
  const newHistory = history.filter(item => item.id !== historyId);
  await env.SESSION_KV.put(LOGIN_HISTORY_KEY, JSON.stringify(newHistory));
  return true;
}

// 清除所有会话（修改密码时调用）
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
  // 同时清空登录历史
  await env.SESSION_KV.put(LOGIN_HISTORY_KEY, JSON.stringify([]));
  return keysToDelete.length;
}

// 安全编码 S3 对象键
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
    this.bucketName = config.id; // 使用 id 作为真实桶名
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
    // CORS 配置
    const ALLOW_ORIGIN = env.ALLOW_ORIGIN || 'https://lkin.cn';
    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOW_ORIGIN,
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Requested-With",
      "Access-Control-Allow-Credentials": "true",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    const getToken = () => {
      const cookie = request.headers.get('Cookie') || '';
      const cookieToken = cookie.match(/token=([^;]+)/)?.[1];
      if (cookieToken) return cookieToken;
      const auth = request.headers.get('Authorization');
      if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
      return null;
    };

    // ---------- 登录 ----------
    if (path === "/login" && request.method === "POST") {
      const { pwd } = await request.json();
      if (!pwd) {
        return Response.json({ code: 400, msg: "请输入密码" }, { status: 400, headers: corsHeaders });
      }
      const storedHash = await getAdminPwdHash(env);
      if (!storedHash) {
        return Response.json({ code: 503, msg: "管理员密码尚未设置，请通过修改密码接口初始化" }, { status: 503, headers: corsHeaders });
      }
      const inputHash = await hashPassword(pwd);
      if (inputHash !== storedHash) {
        return Response.json({ code: 401, msg: "密码错误" }, { status: 401, headers: corsHeaders });
      }
      const token = crypto.randomUUID();
      await env.SESSION_KV.put(token, "valid", { expirationTtl: 604800 });
      const cookie = `token=${token}; HttpOnly; Secure; SameSite=Strict; Max-Age=604800; Path=/`;

      // 记录登录历史
      const historyRecord = {
        id: crypto.randomUUID(),
        time: new Date().toISOString(),
        ua: request.headers.get('User-Agent') || '',
        ip: request.headers.get('CF-Connecting-IP') || '',
        token: token // 存储完整 token，前端不显示
      };
      await addLoginHistory(env, historyRecord);

      return new Response(JSON.stringify({ code: 200, msg: "登录成功" }), {
        headers: { ...corsHeaders, 'Set-Cookie': cookie }
      });
    }

    // ---------- 登出 ----------
    if (path === "/logout" && request.method === "POST") {
      const token = getToken();
      if (token) await env.SESSION_KV.delete(token);
      return new Response(JSON.stringify({ code: 200, msg: "已登出" }), {
        headers: {
          ...corsHeaders,
          'Set-Cookie': 'token=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict'
        }
      });
    }

    // ---------- 修改密码（含初始化） ----------
    if (path === "/admin/change-password" && request.method === "POST") {
      const { oldPwd, newPwd } = await request.json();
      if (!newPwd || newPwd.length < 6) {
        return Response.json({ code: 400, msg: "新密码长度至少6位" }, { status: 400, headers: corsHeaders });
      }
      const storedHash = await getAdminPwdHash(env);
      if (storedHash) {
        if (!oldPwd) {
          return Response.json({ code: 400, msg: "请输入旧密码" }, { status: 400, headers: corsHeaders });
        }
        const oldHash = await hashPassword(oldPwd);
        if (oldHash !== storedHash) {
          return Response.json({ code: 401, msg: "旧密码错误" }, { status: 401, headers: corsHeaders });
        }
      }
      const newHash = await hashPassword(newPwd);
      await setAdminPwdHash(env, newHash);
      const deletedCount = await revokeAllSessions(env);
      return Response.json({ code: 200, msg: `密码已修改，已注销 ${deletedCount} 个会话` }, { headers: corsHeaders });
    }

    // ---------- 全局鉴权（修改密码接口需要在验证旧密码后清除会话，因此不在此处拦截） ----------
    if (path !== "/login" && path !== "/logout" && path !== "/admin/change-password") {
      const token = getToken();
      if (!token) {
        return Response.json({ code: 401, msg: "未授权" }, { status: 401, headers: corsHeaders });
      }
      const isValid = await env.SESSION_KV.get(token);
      if (!isValid) {
        return Response.json({ code: 401, msg: "token 无效或已过期" }, { status: 401, headers: corsHeaders });
      }
    }

    // ========== 登录历史管理（需鉴权） ==========
    if (path === "/admin/login-history" && request.method === "GET") {
      const history = await getLoginHistory(env);
      // 返回不包含 token 的数组
      const safeHistory = history.map(item => ({
        id: item.id,
        time: item.time,
        ua: item.ua,
        ip: item.ip
      }));
      return Response.json({ code: 200, data: safeHistory }, { headers: corsHeaders });
    }

    if (path === "/admin/delete-login-history" && request.method === "POST") {
      const { id } = await request.json();
      if (!id) {
        return Response.json({ code: 400, msg: "缺少记录ID" }, { status: 400, headers: corsHeaders });
      }
      const success = await deleteLoginHistory(env, id);
      if (!success) {
        return Response.json({ code: 404, msg: "记录不存在" }, { status: 404, headers: corsHeaders });
      }
      return Response.json({ code: 200, msg: "已删除该登录会话，对应设备需要重新登录" }, { headers: corsHeaders });
    }

    // ========== 配置管理接口 ==========
    if (path === "/admin/buckets" && request.method === "GET") {
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
      return Response.json({ code: 200, data: safe }, { headers: corsHeaders });
    }

    if (path === "/admin/buckets" && request.method === "POST") {
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
          return Response.json({ code: 400, msg: "配置不完整" }, { status: 400, headers: corsHeaders });
        }
      }
      await saveBucketsConfig(env, merged);
      return Response.json({ code: 200, msg: "配置已更新" }, { headers: corsHeaders });
    }

    // ========== 业务接口 ==========
    const bucketId = url.searchParams.get('bucketId');
    if (!bucketId) {
      return Response.json({ code: 400, msg: "缺少 bucketId 参数" }, { status: 400, headers: corsHeaders });
    }

    let bucket;
    try {
      bucket = await getBucketInstance(env, bucketId);
    } catch (e) {
      return Response.json({ code: 404, msg: e.message }, { status: 404, headers: corsHeaders });
    }

    const allConfigs = await getBucketsConfig(env);
    const bucketConf = getBucketById(allConfigs, bucketId);

    if (path === "/mkdir" && request.method === "POST") {
      let folderPath = decodeURIComponent(url.searchParams.get("path") || "");
      if (!folderPath.endsWith("/")) folderPath += "/";
      await bucket.put(folderPath, "", { httpMetadata: { contentType: "application/folder" } });
      return Response.json({ code: 200, msg: "文件夹创建成功" }, { headers: corsHeaders });
    }

    if (path === "/list" && request.method === "GET") {
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
      return Response.json({ code: 200, curPath, folders, files }, { headers: corsHeaders });
    }

    if (path === "/upload" && request.method === "POST") {
      const curPath = decodeURIComponent(url.searchParams.get("path") || "");
      const formData = await request.formData();
      const file = formData.get("file");
      if (!file) return Response.json({ code: 400, msg: "无文件" }, { headers: corsHeaders });
      const fullKey = curPath + file.name;
      await bucket.put(fullKey, file.stream(), { httpMetadata: { contentType: file.type } });
      const publicDomain = bucketConf?.publicDomain || '';
      return Response.json({
        code: 200,
        fullKey,
        url: publicDomain ? `${publicDomain}/${encodeS3Key(fullKey)}` : ''
      }, { headers: corsHeaders });
    }

    if (path === "/del" && request.method === "DELETE") {
      const fullKey = decodeURIComponent(url.searchParams.get("key"));
      if (!fullKey) return Response.json({ code: 400, msg: "缺少路径" }, { headers: corsHeaders });
      await bucket.delete(fullKey);
      return Response.json({ code: 200, msg: "删除成功" }, { headers: corsHeaders });
    }

    if (path === "/download" && request.method === "GET") {
      const fullKey = decodeURIComponent(url.searchParams.get("key") || "");
      if (!fullKey) return Response.json({ code: 400, msg: "缺少文件路径" }, { status: 400, headers: corsHeaders });
      const object = await bucket.get(fullKey);
      if (!object) return Response.json({ code: 404, msg: "文件不存在" }, { status: 404, headers: corsHeaders });
      const fileName = fullKey.split("/").pop() || "download";
      const asciiFileName = fileName.replace(/[^\x20-\x7E]/g, '_');
      const contentDisposition = `attachment; filename="${asciiFileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
      const headers = {
        ...corsHeaders,
        "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
        "Content-Disposition": contentDisposition,
        "Content-Length": String(object.size),
        "ETag": object.httpEtag || '',
      };
      return new Response(object.body, { headers });
    }

    if (path === "/read" && request.method === "GET") {
      const fullKey = decodeURIComponent(url.searchParams.get("key") || "");
      if (!fullKey) return Response.json({ code: 400, msg: "缺少文件路径" }, { status: 400, headers: corsHeaders });
      const object = await bucket.get(fullKey);
      if (!object) return Response.json({ code: 404, msg: "文件不存在" }, { status: 404, headers: corsHeaders });
      if (object.size > 2 * 1024 * 1024) return Response.json({ code: 413, msg: "文件过大，无法在线编辑" }, { status: 413, headers: corsHeaders });
      const text = await object.text();
      return Response.json({ code: 200, content: text }, { headers: corsHeaders });
    }

    if (path === "/write" && request.method === "PUT") {
      const fullKey = decodeURIComponent(url.searchParams.get("key") || "");
      if (!fullKey) return Response.json({ code: 400, msg: "缺少文件路径" }, { status: 400, headers: corsHeaders });
      const { content } = await request.json();
      if (typeof content !== "string") return Response.json({ code: 400, msg: "内容格式错误" }, { status: 400, headers: corsHeaders });
      if (new TextEncoder().encode(content).length > 2 * 1024 * 1024) return Response.json({ code: 413, msg: "内容过大，无法保存" }, { status: 413, headers: corsHeaders });

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
      return Response.json({ code: 200, msg: "保存成功" }, { headers: corsHeaders });
    }

    if (path === "/rename" && request.method === "POST") {
      const oldKey = decodeURIComponent(url.searchParams.get("oldKey") || "");
      const newName = decodeURIComponent(url.searchParams.get("newName") || "");
      if (!oldKey || !newName) return Response.json({ code: 400, msg: "缺少参数" }, { status: 400, headers: corsHeaders });
      if (newName.includes("/")) return Response.json({ code: 400, msg: "新名称不能包含 /" }, { status: 400, headers: corsHeaders });

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
      if (existing) return Response.json({ code: 409, msg: "目标名称已存在" }, { status: 409, headers: corsHeaders });

      if (!isFolder) {
        const object = await bucket.get(oldKey);
        if (!object) return Response.json({ code: 404, msg: "原文件不存在" }, { status: 404, headers: corsHeaders });
        if (object.size > 100 * 1024 * 1024) return Response.json({ code: 413, msg: "文件过大，暂不支持重命名" }, { status: 413, headers: corsHeaders });
        await bucket.put(newKey, object.body, { httpMetadata: object.httpMetadata });
        await bucket.delete(oldKey);
        return Response.json({ code: 200, msg: "重命名成功", newKey }, { headers: corsHeaders });
      } else {
        const listResult = await bucket.list({ prefix: oldKey });
        if (listResult.objects.length === 0) return Response.json({ code: 404, msg: "原文件夹不存在或为空" }, { status: 404, headers: corsHeaders });
        if (listResult.objects.length > 1000) return Response.json({ code: 413, msg: "文件夹内文件过多，暂不支持重命名" }, { status: 413, headers: corsHeaders });

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
        return Response.json({ code: 200, msg: "文件夹重命名成功", newKey }, { headers: corsHeaders });
      }
    }

    if (path === "/usage" && request.method === "GET") {
      const conf = getBucketById(allConfigs, bucketId);
      if (!conf) return Response.json({ code: 404, msg: "桶配置不存在" }, { status: 404, headers: corsHeaders });
      const usage = await getBucketUsage(conf.accountId, conf.id, conf.apiToken);
      if (usage === null) {
        return Response.json({ code: 500, msg: "获取用量失败，请检查 API Token 权限" }, { status: 500, headers: corsHeaders });
      }
      return Response.json({ code: 200, size: usage }, { headers: corsHeaders });
    }

    return Response.json({ msg: "接口不存在" }, { status: 404, headers: corsHeaders });
  }
};
