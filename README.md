# Running Platform

跑步数据记录、分析和预测平台 V1。前端使用 Vite + React + TypeScript，后端使用 Netlify Functions，生产数据存储在腾讯云 COS。

## Local Development

```bash
npm install
npm run netlify:dev
```

如果没有配置 COS 环境变量，Netlify Functions 会在本地使用 `.netlify/local-data/` 作为开发回退存储。生产环境必须在 Netlify Site settings 中配置 `.env.example` 里的变量。

DeepSeek 智能分析使用“用户自带 API Key”模式。`npm run dev` 会在本地把 AI 函数桥接到 Vite，并将加密后的 Key 与分析缓存写入未提交的 `.netlify/local-data/`；如果已安装 Netlify CLI，也可使用 `npm run netlify:dev`。本地开发不会把 Key 写进浏览器或线上环境。Key 以 AES-256-GCM 加密，密钥通过 HKDF 从 `JWT_SECRET` 派生。修改生产环境的 `JWT_SECRET` 会使已经保存的 DeepSeek Key 无法解密，修改前应安排迁移或让用户重新配置。

## Deploy

1. 将仓库推送到 `https://github.com/FISHZBLBL/running-platform`。
2. 在 Netlify 选择该 GitHub 仓库创建站点。
3. Build command 使用 `npm run build`，publish directory 使用 `dist`。
4. 配置环境变量：
   - `COS_SECRET_ID`
   - `COS_SECRET_KEY`
   - `COS_BUCKET=running-platform-1323797631`
   - `COS_REGION=ap-beijing`
   - `COS_DOMAIN=running-platform-1323797631.cos.accelerate.myqcloud.com`
   - `COS_MAX_ATTEMPTS=3`
   - `COS_REQUEST_TIMEOUT_MS=15000`
   - `JWT_SECRET`
   - `INVITE_CODE`：使用私密随机值，不要把真实邀请码提交到 GitHub

Netlify Functions 不在腾讯云内网中运行，所以 `COS_DOMAIN` 应使用公网全球加速域名，不要使用 `cos-internal` 内网全球加速域名。

## Scripts

```bash
npm run dev
npm run netlify:dev
npm run test
npm run build
```
