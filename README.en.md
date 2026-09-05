<div align="center">
  
<img style="width:60px" src="https://raw.githubusercontent.com/link9596/one-bucket/refs/heads/main/favicon.svg" alt=""><h1>OneBucket</h1>

**A multi-bucket cloud storage drive / file manager built on Cloudflare Workers**

Supports **Cloudflare R2** and any **S3-compatible object storage**. Pages frontend + Worker backend, ready out of the box.

[简体中文](./README.md) · English

---
[![GitHub license](https://img.shields.io/github/license/link9596/one-bucket)](https://github.com/link9596/one-bucket/blob/main/LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?style=flat-square&logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/link9596/one-bucket)

[**⚡ Quick Start**](#quick-start) · [**☁️ Live Demo**](https://r2-file.lkin.cn/web/demo/OneBucket-demo.html) · [**💬 Feedback**](https://github.com/link9596/one-bucket/issues) · [**🛡️ Security**](#security-design) · [**💡 FAQ**](#faq)

</div>

---

## Introduction

OneBucket is a lightweight cloud storage management tool deployed on **Cloudflare Workers**. You can connect multiple storage buckets (R2 or any S3-compatible object storage) in a single admin panel, and manage files — upload, download, preview, edit inline, rename, delete — through a web UI. It can also generate public shareable links for your files.

## 应用截图

<table rules="none">
  <tr>
    <td><img src="https://r2-file.lkin.cn/screenshot/onebucket1.jpg" width="auto" height="600" alt="main"/></td>
    <td><img src="https://r2-file.lkin.cn/screenshot/onebucket2.jpg" width="auto" height="600" alt="mg"/></td>
  </tr>
</table>

## Features

### 📁 File Management

- **Multi-bucket** — manage multiple storage buckets (R2 / any S3-compatible service) visually in the admin panel, add / edit / remove configs
- **Multilingual** — Supports switching between Chinese and English following browser language settings
- **Directory browsing** — breadcrumb path navigation, folder hierarchy display, file size / upload time display
- **Batch upload** — queued multi-file upload with **3-way concurrency**, per-file real-time progress bars, success / failure stats
- **New folder** — create directory placeholder objects in one click
- **Download** — streaming download with correct Chinese filename handling (RFC 5987)
- **Online preview** — with a `public domain` configured, preview images / audio / video inline and copy public direct links
- **Export all links** — copy a "filename + link" table for all files in the current directory to the clipboard in one click
- **Inline text editing** — edit and save text files up to 2MB inline (MIME auto-detected)
- **Rename** — rename files and folders (folders handled recursively, with object-count safeguards)
- **Delete** — single file, recursive folder, and **batch delete**
- **Login rate limiting** — max 5 failed attempts in 15 minutes to deter brute force
- **Login history** — records IP / UA / time for each login; delete individual records or revoke all sessions
- **Password change** — automatically revokes all active sessions after a change

### 🎨 Frontend

- Light / dark theme auto-adaptation (follows system preference)
- Responsive mobile layout
- Live usage display (via the Cloudflare API)

## Quick Start

### Option 1: One-click deploy (recommended)

Click the button below and follow the Cloudflare onboarding flow:

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/link9596/one-bucket/)

During deployment, name the two KV namespaces differently to avoid the "conflict" prompt.

After deployment finishes, add the `MASTER_KEY` environment variable — the value can be a random UUID or any other sufficiently strong random string.

### Option 2: Manual deploy

**Prerequisites**
- A Cloudflare account
- Node.js 18+
**1. Install dependencies**
```bash
npm install
```
**2. Create KV Namespace and write config**
Create two KV namespaces and paste the returned `id` values into the corresponding places in `wrangler.toml`:
```bash
npx wrangler kv namespace create SESSION_KV
npx wrangler kv namespace create BUCKET_CONFIG
```
Edit `wrangler.toml`:
```toml
name = "one-bucket"
main = "worker.js"
compatibility_date = "2025-01-01"
[[kv_namespaces]]
binding = "SESSION_KV"
id = "your SESSION_KV namespace id"
[[kv_namespaces]]
binding = "BUCKET_CONFIG"
id = "your BUCKET_CONFIG namespace id"
```
**3. Set environment variables**
```bash
npx wrangler secret put MASTER_KEY   # required: master key used to encrypt bucket credentials
npx wrangler secret put ADMIN_URL    # optional: frontend URL; if left unset, the default frontend of this project is used
```
> `MASTER_KEY` is the encryption key for sensitive bucket credentials. You can generate it with a random UUID generator or any other sufficiently strong random string, and store it safely — if it is lost, the encrypted bucket credentials can no longer be decrypted and must be reconfigured.
**4. Deploy the Worker**
```bash
npx wrangler deploy
```
That's it — visit your URL and your OneBucket is ready to use.
- The first time you open the frontend, you'll be guided through the "initialize password" flow
- After logging in, add a bucket config in the "bucket list" panel
- Save, and you're ready to upload / manage files
---
**5. Deploy a custom frontend (optional)**
If you want to build your own custom frontend, deploy `index.html` or the frontend you develop to any static host (e.g. GitHub Pages), then point the `ADMIN_URL` Worker environment variable to your frontend URL.
## Configuration
### Environment variables
| Variable | Required | Description |
| --- | --- | --- |
| `MASTER_KEY` | ✅ | Master key used to AES-GCM encrypt bucket `secretAccessKey` / `apiToken` |
| `ADMIN_URL` | ❌ | Frontend URL; if unset, the project's default frontend `https://link9596.github.io/one-bucket` is used |
### KV bindings & purpose
| Binding | Purpose |
| --- | --- |
| `SESSION_KV` | Session tokens, login rate-limit counters, login history |
| `BUCKET_CONFIG` | Bucket config list (with encrypted credentials), admin password hash |
### Bucket config fields
| Field | Description |
| --- | --- |
| `id` | Bucket identifier |
| `name` | Name shown in the frontend |
| `endpoint` | S3-compatible endpoint (e.g. R2's `https://<account>.r2.cloudflarestorage.com`) |
| `accessKeyId` | Bucket Access Key |
| `secretAccessKey` | Bucket Secret Key |
| `publicDomain` | Bucket public access domain (optional); when set, files get public direct links |
| `accountId` | Cloudflare account ID (used for usage queries), optional |
| `apiToken` | Cloudflare API Token (used for usage queries), optional |
## Project Structure
```
one-bucket/
├── worker.js          # Cloudflare Worker backend (storage gateway + API + auth)
├── index.html         # Example frontend single-page app (no separate build required)
├── wrangler.toml      # Worker config (KV bindings, etc.)
├── package.json       # Dependencies: aws4fetch, fast-xml-parser
├── package-lock.json
└── README.md
```
## Security Design
- **Password storage** — PBKDF2-SHA256, 100,000 iterations, per-user random 16-byte salt; comparison uses `crypto.subtle.timingSafeEqual` to resist timing attacks
- **Sessions** — `crypto.randomUUID()` random tokens stored only in KV; cookies set with `HttpOnly; Secure; SameSite=Strict`
- **Rate limiting** — keyed by `CF-Connecting-IP`; max 5 failed logins per 15-minute window
- **Credential encryption** — bucket keys and API tokens are encrypted with AES-GCM (random 12-byte IV) before storage; the master key is derived from `MASTER_KEY` (SHA-256)
- **Path safety** — a unified `sanitizeKey()` blocks path traversal (`../`, `..\`, `%2e` encoded variants, `..` segments)
- **SSRF protection** — the static-asset proxy validates that the target origin matches `ADMIN_URL` and only forwards a whitelist of headers
- **CSRF protection** — sensitive operations such as logout validate the `Origin` header
- **Password-change safety** — requires the old password and a valid session, and force-revokes all sessions afterwards
## API Reference
Our backend provides a rich set of APIs, so you can build your own frontend pages or plugins on top of it.
> Except where noted, business endpoints require a session (cookie or `Authorization: Bearer <token>`) and a target bucket via the `bucketId` query parameter.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/login` | Login with password |
| POST | `/logout` | Logout |
| GET | `/admin/password-status` | Check whether the admin password is set |
| POST | `/admin/change-password` | Initialize / change password |
| GET | `/admin/buckets` | Get bucket config list |
| POST | `/admin/buckets` | Save bucket config list |
| GET | `/admin/login-history` | Get login history |
| POST | `/admin/delete-login-history` | Delete a login record |
| POST | `/admin/update-session` | Refresh the current session timestamp |
| GET | `/list?bucketId=&path=` | List directory contents |
| POST | `/upload?bucketId=&path=` | Upload a file (multipart/form-data) |
| POST | `/mkdir?bucketId=&path=` | Create a folder |
| DELETE | `/del?bucketId=&key=` | Delete a file / folder (recursive) |
| POST | `/del-batch?bucketId=` | Batch delete |
| GET | `/download?bucketId=&key=` | Download a file (streaming) |
| GET | `/read?bucketId=&key=` | Read text content (≤ 2MB) |
| PUT | `/write?bucketId=&key=` | Save text content (≤ 2MB) |
| POST | `/rename?bucketId=&oldKey=&newName=` | Rename a file / folder |
| GET | `/usage?bucketId=` | Query bucket usage (requires `apiToken`) |

## FAQ

**Q: Why is `MASTER_KEY` required?**
`MASTER_KEY` is used to encrypt the buckets' Secret Keys and API Tokens so that credentials are never stored in plaintext. The Worker refuses to serve requests when it is unset.

**Q: What happens if `ADMIN_URL` is not set?**
The Worker proxies static assets from `https://link9596.github.io/one-bucket` by default. It works fine without setting it. However, if you need to build your own frontend, configure `ADMIN_URL` to point to your frontend URL.

**Q: Which storages are supported?**
Any S3-compatible object storage: Cloudflare R2, AWS S3, MinIO, Backblaze B2, Alibaba Cloud OSS, and more.

**Q: Are there size limits for upload / download?**
Files are streamed for upload and download, so they don't rely on Worker memory buffering and can handle large files (limited mainly by Cloudflare Workers request-body limits and your object storage provider's limits). Inline text editing (`/read`, `/write`) is limited to 2MB; single-file rename is limited to 100MB; folder rename is limited to 1,000 objects.

## License
GPL-3.0 License
