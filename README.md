<div align="center">

# 🪣 OneBucket

**一个基于 Cloudflare Workers 的多桶云存储网盘 / 文件管理器**

支持 **Cloudflare R2** 及任意 **S3 兼容对象存储**，Pages 前端 + Worker 后端，开箱即用。

[简体中文](./README.md) · [English](./README.en.md) 

---

[![GitHub license](https://img.shields.io/github/license/link9596/one-bucket)](https://github.com/link9596/one-bucket/blob/main/LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)


[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/link9596/Cloudflare-Typecho)

[**⌨️ 快速开始**](#快速开始) · [**☁️ 在线预览**](https://link9596.github.io/one-bucket) · [**💬 反馈**](https://github.com/link9596/one-bucket/issues) · [**🛡️ 安全**](#安全设计) · [**💡 常见问题**](#常见问题)

</div>

---

## 项目简介

OneBucket 是一个部署在 **Cloudflare Workers** 上的轻量级云存储管理工具。你可以在一个后台里同时接入多个存储桶（R2 或任何兼容 S3 协议的对象存储），通过网页界面完成文件的上传、下载、预览、在线编辑、重命名、删除等操作，并可直接生成文件的公共直链用于分享。

## 功能特性

### 📁 文件管理
- **多桶管理**：在后台可视化管理多个存储桶（R2 / 任意 S3 兼容服务），支持增删改配置
- **目录浏览**：面包屑路径导航、文件夹层级展示、文件大小 / 上传时间展示
- **批量上传**：多文件队列上传，**3 路并发**，逐文件实时进度条，成功 / 失败统计
- **新建文件夹**：一键创建目录占位对象
- **下载文件**：流式下载，正确处理中文文件名（RFC 5987）
- **在线预览**：配置 `公共域名` 后可直接预览图片 / 音视频等，并复制公共直链
- **导出全部链接**：一键复制当前目录所有文件的「文件名 + 链接」表格到剪贴板
- **在线文本编辑**：≤ 2MB 的文本文件可直接在线编辑并保存（自动识别 MIME 类型）
- **重命名**：支持文件与文件夹重命名（文件夹递归处理，含对象数上限保护）
- **删除**：单文件删除、文件夹递归删除、**批量删除**
- **登录限流**：15 分钟内最多 5 次失败尝试，防止暴力破解
- **登录历史**：记录每次登录的 IP / UA / 时间，可单条删除或一键注销全部会话
- **修改密码**：修改后自动撤销所有已登录会话

### 🎨 前端
- 亮色 / 暗色主题自适应（跟随系统）
- 移动端响应式布局
- 实时用量显示（通过 Cloudflare API）

## 快速开始

### 方式一：一键部署（推荐）

点击下方按钮，按 Cloudflare 引导完成部署即可：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/link9596/one-bucket/)

### 方式二：手动部署

**前置要求**

- 一个 Cloudflare 账号
- Node.js 18+

**1. 安装依赖**

```bash
npm install
```

**2. 创建 KV Namespace 并写入配置**

创建两个 KV 命名空间，并把返回的 `id` 填入 `wrangler.toml` 的对应位置：

```bash
npx wrangler kv namespace create SESSION_KV
npx wrangler kv namespace create BUCKET_CONFIG
```

编辑 `wrangler.toml`：

```toml
name = "one-bucket"
main = "worker.js"
compatibility_date = "2025-01-01"

[[kv_namespaces]]
binding = "SESSION_KV"
id = "你的 SESSION_KV 命名空间 id"

[[kv_namespaces]]
binding = "BUCKET_CONFIG"
id = "你的 BUCKET_CONFIG 命名空间 id"
```

**3. 设置环境变量**

```bash
npx wrangler secret put MASTER_KEY   # 必填：用于加密桶凭证的主密钥
npx wrangler secret put ADMIN_URL    # 可选：前端地址，不填则默认使用本项目前端地址
```

> `MASTER_KEY` 是桶敏感凭证的加密密钥，可以使用随机UUID生成器或其他足够强度的随机字符串，并妥善保管——丢失将导致已加密的桶凭证无法解密，必须重新配置。

**4. 部署 Worker**

```bash
npx wrangler deploy
```

至此，访问你的URL，你的OneBucket已经可以正常使用

- 首次打开前端会自动进入「初始化密码」流程
- 登录后在「桶列表」中新增存储桶配置
- 保存后即可开始上传 / 管理文件

---

**5. 部署前端（可选）**

如果你需要自己搭建自定义前端页面，可以将 `index.html` 或者你开发的前端页面部署到任意静态托管（如 GitHub Pages），然后通过 `ADMIN_URL` Worker环境变量指向你的前端地址。

## 配置说明

### 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `MASTER_KEY` | ✅ | 用于 AES-GCM 加密桶 `secretAccessKey` / `apiToken` 的主密钥 |
| `ADMIN_URL` | ❌ | 前端地址，不填则默认使用本项目前端 `https://link9596.github.io/one-bucket` |

### KV 绑定与用途
| 绑定 | 用途 |
| --- | --- |
| `SESSION_KV` | 会话 token、登录限流计数、登录历史 |
| `BUCKET_CONFIG` | 桶配置列表（含加密凭证）、管理员密码哈希 |

### 存储桶配置字段

| 字段 | 说明 |
| --- | --- |
| `id` | 桶标识 |
| `name` | 显示在前台的名称 |
| `endpoint` | S3 兼容端点地址（如 R2 的 `https://<account>.r2.cloudflarestorage.com`） |
| `accessKeyId` | 存储桶 Access Key |
| `secretAccessKey` | 存储桶 Secret Key |
| `publicDomain` | 存储桶公共访问域名（可选），配置后文件可获得公共直链 |
| `accountId` | Cloudflare 账号 ID（用于用量查询），可选填 |
| `apiToken` | Cloudflare API Token（用于用量查询），可选填 |


## 目录结构

```
one-bucket/
├── worker.js          # Cloudflare Worker 后端（存储网关 + API + 鉴权）
├── index.html         # 前端单页应用示例（无需单独构建）
├── wrangler.toml      # Worker 配置（KV 绑定等）
├── package.json       # 依赖项：aws4fetch、fast-xml-parser
├── package-lock.json
└── README.md
```

## 安全设计

- **密码存储**：PBKDF2-SHA256，100,000 次迭代，每用户随机 16 字节盐；比较使用 `crypto.subtle.timingSafeEqual` 防时序攻击
- **会话**：`crypto.randomUUID()` 随机 token，仅存 KV；Cookie 设置 `HttpOnly; Secure; SameSite=Strict`
- **限流**：按 `CF-Connecting-IP` 记录，15 分钟窗口内最多 5 次失败登录
- **凭证加密**：桶密钥与 API Token 以 AES-GCM（随机 12 字节 IV）加密后入库，主密钥来自 `MASTER_KEY`（SHA-256 派生）
- **路径安全**：统一 `sanitizeKey()` 拦截路径遍历（`../`、`..\`、`%2e` 编码变体、`..` 片段）
- **SSRF 防护**：静态资源代理校验目标 origin 必须与 `ADMIN_URL` 一致，仅透传白名单请求头
- **CSRF 防护**：登出等敏感操作校验 `Origin` 头
- **改密安全**：修改密码要求旧密码 + 有效会话，成功后强制撤销全部会话

## API 接口

我们的后端提供了非常丰富的API，你可以基于此开发出适合你的前端页面或者插件。

> 除标注外，业务接口均需携带会话（Cookie 或 `Authorization: Bearer <token>`），并通过 `bucketId` 指定目标桶。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/login` | 登录（密码） |
| POST | `/logout` | 登出 |
| GET | `/admin/password-status` | 查询管理员密码是否已设置 |
| POST | `/admin/change-password` | 初始化 / 修改密码 |
| GET | `/admin/buckets` | 获取桶配置列表 |
| POST | `/admin/buckets` | 保存桶配置列表 |
| GET | `/admin/login-history` | 获取登录历史 |
| POST | `/admin/delete-login-history` | 删除指定登录记录 |
| POST | `/admin/update-session` | 刷新当前会话时间 |
| GET | `/list?bucketId=&path=` | 列出目录内容 |
| POST | `/upload?bucketId=&path=` | 上传文件（multipart/form-data） |
| POST | `/mkdir?bucketId=&path=` | 新建文件夹 |
| DELETE | `/del?bucketId=&key=` | 删除文件 / 文件夹（递归） |
| POST | `/del-batch?bucketId=` | 批量删除 |
| GET | `/download?bucketId=&key=` | 下载文件（流式） |
| GET | `/read?bucketId=&key=` | 读取文本内容（≤ 2MB） |
| PUT | `/write?bucketId=&key=` | 保存文本内容（≤ 2MB） |
| POST | `/rename?bucketId=&oldKey=&newName=` | 重命名文件 / 文件夹 |
| GET | `/usage?bucketId=` | 查询桶用量（需 `apiToken`） |

## 常见问题

**Q：为什么需要 `MASTER_KEY`？**

`MASTER_KEY` 用于加密存储桶的 Secret Key 和 API Token，避免明文凭证入库。未设置时 Worker 会拒绝服务。

**Q：`ADMIN_URL` 不设置会怎样？**

Worker 默认把静态资源代理到 `https://link9596.github.io/one-bucket`。不设置这个也能正常允许。但如果你需要自行搭建前端，请配置 `ADMIN_URL` 指向你的前端地址。

**Q：支持哪些存储？**

任何兼容 S3 协议的对象存储均可，包括 Cloudflare R2、AWS S3、MinIO、Backblaze B2、阿里云 OSS 等。

**Q：上传 / 下载大小有限制吗？**

文件通过流式上传 / 下载，不依赖 Worker 内存缓冲，可支持较大文件（但主要受 Cloudflare Workers 请求体限制影响以及对象存储服务商限制）。在线文本编辑（`/read`、`/write`）限制为 2MB，单个文件重命名限制为 100MB，文件夹重命名限制为 1000 个对象。

## License

GPL-3.0 license
