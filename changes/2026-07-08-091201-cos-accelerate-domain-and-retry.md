# 2026-07-08 09:12:01 +08:00 COS 全球加速域名与请求重试

## 改动内容
- COS 服务端请求现在优先使用 `COS_DOMAIN` 作为真实请求 Host，不再固定拼接 `running-platform-1323797631.cos.ap-beijing.myqcloud.com`。
- `.env.example` 和 `README.md` 中的 `COS_DOMAIN` 示例改为公网全球加速域名：`running-platform-1323797631.cos.accelerate.myqcloud.com`。
- 新增可选环境变量：
  - `COS_MAX_ATTEMPTS=3`
  - `COS_REQUEST_TIMEOUT_MS=15000`
- COS 请求增加轻量重试：遇到网络错误、408、429 或 5xx 时自动重试，降低跨云网络波动导致保存失败的概率。
- README 明确说明 Netlify Functions 不应使用 `cos-internal` 内网全球加速域名。

## 为什么做这个改动
- 线上报错显示 Netlify Functions 连接普通北京 COS 域名超时：`UND_ERR_CONNECT_TIMEOUT`。
- 用户已为 COS 存储桶开启全球加速，但旧代码没有真正使用 `COS_DOMAIN` 作为写入请求域名。
- Netlify 与腾讯 COS 属于跨云访问，偶发连接超时需要通过加速域名和自动重试共同缓解。

## 解决的问题
- 让跑步记录、体重记录、跑鞋图片、截图上传等所有 COS 读写都可以走公网全球加速域名。
- 减少保存数据时因为单次网络超时导致整次保存失败的情况。
- 后续如果需要调整超时或重试次数，可以直接通过 Netlify 环境变量配置，不需要改代码。

## 部署后需要同步的配置
- 在 Netlify 环境变量中把 `COS_DOMAIN` 改为：
  `running-platform-1323797631.cos.accelerate.myqcloud.com`
- 不要在 Netlify 使用：
  `running-platform-1323797631.cos-internal.accelerate.tencentcos.cn`
