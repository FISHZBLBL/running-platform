# 跑步趋势预测平台

这是一个纯前端静态网站，可部署到 GitHub Pages、Netlify、Vercel 或任意静态托管服务。

## 本地打开

直接双击 `index.html` 即可使用。

如果希望局域网设备访问，可运行：

```bat
start-server.cmd
```

然后用 `http://电脑局域网IP:4173` 访问。

## 部署到 GitHub Pages

1. 新建一个 GitHub 仓库，例如 `running-predictor`。
2. 把本目录里的所有文件上传到仓库根目录：
   - `index.html`
   - `styles.css`
   - `app.js`
   - `start-server.cmd`
   - `.nojekyll`
   - `README.md`
3. 在 GitHub 仓库页面进入 `Settings` -> `Pages`。
4. `Build and deployment` 选择：
   - Source: `Deploy from a branch`
   - Branch: `main`
   - Folder: `/root`
5. 保存后等待 1-2 分钟，GitHub 会生成公网地址：

```text
https://你的用户名.github.io/running-predictor/
```

## 数据说明

当前版本采用“本地优先 + 账号弹窗 + 腾讯云 COS 直连测试同步”：

- 打开网站会先显示登录/注册对话框。
- Bucket 和 Region 已内置在前端代码中：
  - Bucket: `running-platform-1323797631`
  - Region: `ap-beijing`
- 注册用户名后，云端数据会保存到该用户名对应的 COS 路径：
  - `users/<username>/encrypted-data.json`
- 密码 / PIN 会用于解密和加密该账号的数据。
- 腾讯云 SecretId / SecretKey 由你在登录框输入，用于浏览器直连 COS。
- 同步失败时不会丢数据，下次手动同步或重新登录后会继续合并。
- 截图只在当前页面临时预览，不写入本地缓存，也不上传云端。
- 识别/核对后的结构化文本数据才会保存。
- 密码 / PIN 不会保存到浏览器配置中，只在当前页面会话内使用。

## 腾讯云 COS 配置

存储桶已经固定为：

```text
Bucket: running-platform-1323797631
Region: ap-beijing
Key: users/<username>/encrypted-data.json
```

COS 里只保存一个加密 JSON 文件，例如：

```text
users/fish/encrypted-data.json
```

文件内容不是明文跑步数据，而是类似：

```text
{
  "version": 1,
  "algorithm": "AES-GCM",
  "iv": "...",
  "data": "..."
}
```

## 当前直连测试版说明

当前版本为了先验证 COS 读写链路，允许你在浏览器中输入腾讯云 `SecretId` / `SecretKey` 直接写 COS。

请注意：

```text
不要把 SecretId / SecretKey 写进 GitHub 代码
不要把截图或含密钥的页面发给别人
确认可用后，建议再切回云函数/临时密钥方案
```

账号密码在当前直连测试版里主要用于加密/解密数据。用户名决定 COS 目录，密码不上传到 COS。

## COS 权限建议

- Bucket 不要开放公共写入。
- CORS 允许你的网站域名访问 COS。
- SecretId / SecretKey 对应的 CAM 用户建议只给这个 Bucket 的读写权限。

## 推荐部署组合

- GitHub：保存代码。
- GitHub Pages 或腾讯云静态网站托管：发布网页。
- 腾讯云 COS：保存加密后的私人跑步数据 JSON。
- 未来 OCR：用云函数识别截图，识别后只保存文本数据。

## GitHub 需要上传

```text
index.html
styles.css
app.js
cos-sync.js
.nojekyll
README.md
```

## COS CORS 建议

```text
Allow-Origin: https://fishzblbl.github.io
Allow-Methods: GET, PUT, POST, OPTIONS, HEAD
Allow-Headers: *
Expose-Headers: ETag
Allow-Credentials: 不启用
Max-Age: 600
```
