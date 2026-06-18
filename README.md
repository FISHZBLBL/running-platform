# Running Platform

跑步数据记录、分析和预测平台 V1。前端使用 Vite + React + TypeScript，后端使用 Netlify Functions，生产数据存储在腾讯云 COS。

## Local Development

```bash
npm install
npm run netlify:dev
```

如果没有配置 COS 环境变量，Netlify Functions 会在本地使用 `.netlify/local-data/` 作为开发回退存储。生产环境必须在 Netlify Site settings 中配置 `.env.example` 里的变量。

## Deploy

1. 将仓库推送到 `https://github.com/FISHZBLBL/running-platform`。
2. 在 Netlify 选择该 GitHub 仓库创建站点。
3. Build command 使用 `npm run build`，publish directory 使用 `dist`。
4. 配置环境变量：
   - `COS_SECRET_ID`
   - `COS_SECRET_KEY`
   - `COS_BUCKET=running-platform-1323797631`
   - `COS_REGION=ap-beijing`
   - `COS_DOMAIN=running-platform-1323797631.cos.ap-beijing.myqcloud.com`
   - `JWT_SECRET`
   - `INVITE_CODE=FISH_Z`

## Scripts

```bash
npm run dev
npm run netlify:dev
npm run test
npm run build
```
