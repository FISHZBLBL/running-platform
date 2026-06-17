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

当前版本采用“本地优先 + 账号弹窗 + 腾讯云 COS 加密同步”：

- 打开网站会先显示登录/注册对话框。
- Bucket 和 Region 已内置在前端代码中：
  - Bucket: `running-platform-1323797631`
  - Region: `ap-beijing`
- 注册用户名后，云端数据会保存到该用户名对应的 COS 路径：
  - `users/<username>/encrypted-data.json`
- 密码 / PIN 会用于解密和加密该账号的数据。
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
临时密钥接口: https://你的云函数地址/get-cos-credentials
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

## 为什么还需要临时密钥接口

不要把腾讯云 `SecretId` / `SecretKey` 写进前端网页。任何拿到网址的人都能查看前端源码，一旦密钥在网页里，就等于公开了存储桶写权限。

正确做法是：

```text
网页输入用户名和密码
  -> 请求你的临时密钥接口
  -> 接口在 COS 中创建或校验账号文件
  -> 返回只允许读写 users/<username>/encrypted-data.json 的 COS 临时密钥
  -> 前端用临时密钥读写 COS
```

这个临时密钥接口可以用腾讯云 SCF 云函数、CloudBase 云函数、轻量服务器或任意后端实现。

本项目附带了一个云函数模板：

```text
credential-function/index.js
```

部署说明在：

```text
credential-function/README.md
```

## COS 权限建议

- Bucket 不要开放公共写入。
- CORS 允许你的网站域名访问 COS。
- 临时密钥策略只允许读写一个对象 Key，例如 `users/fish/encrypted-data.json`。
- 密码校验应放在临时密钥接口里；前端登录弹窗只是使用体验，不是安全边界。

## 推荐部署组合

- GitHub：保存代码。
- GitHub Pages 或腾讯云静态网站托管：发布网页。
- 腾讯云 COS：保存加密后的私人跑步数据 JSON。
- 腾讯云 SCF / CloudBase 云函数：注册/校验账号，并签发 COS 临时密钥。
- 未来 OCR：用云函数识别截图，识别后只保存文本数据。

## 需要的临时密钥返回格式

前端期望接口返回：

```json
{
  "TmpSecretId": "...",
  "TmpSecretKey": "...",
  "SecurityToken": "...",
  "StartTime": 1710000000,
  "ExpiredTime": 1710003600
}
```

也兼容部分 SDK 常见字段：

```json
{
  "credentials": {
    "tmpSecretId": "...",
    "tmpSecretKey": "...",
    "sessionToken": "..."
  },
  "startTime": 1710000000,
  "expiredTime": 1710003600
}
```
