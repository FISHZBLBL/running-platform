# COS 临时密钥接口模板

这个目录提供一个腾讯云 SCF / CloudBase 云函数示例，用来实现账号注册/登录，并给前端签发 COS 临时密钥。

前端不会保存腾讯云永久密钥。流程是：

```text
前端提交注册/登录请求
  -> 云函数在 COS 中读取或创建 _accounts/<username>.json
  -> 云函数校验密码哈希
  -> 云函数调用 STS AssumeRole
  -> 返回只能读写 users/<username>/encrypted-data.json 的临时密钥
```

## 环境变量

```text
ROLE_ARN           腾讯云 CAM 角色 ARN
COS_BUCKET         running-platform-1323797631
COS_REGION         ap-beijing
TENCENTCLOUD_SECRETID
TENCENTCLOUD_SECRETKEY
```

## 部署注意

- 云函数需要安装 `package.json` 中的依赖。
- 云函数自身需要能读写 `_accounts/` 下的账号文件。
- 云函数返回给前端的临时密钥只允许读写当前账号的数据文件。
- 函数 HTTP 触发器需要允许你的网站域名跨域访问。
- 不要把 SecretId / SecretKey 写到前端网页。

## COS 文件结构

```text
_accounts/fish.json
users/fish/encrypted-data.json
```

`_accounts` 保存账号盐值和密码哈希，不保存明文密码。`users/<username>` 保存加密后的跑步数据。
