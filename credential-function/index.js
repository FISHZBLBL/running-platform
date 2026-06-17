const crypto = require("crypto");
const tencentcloud = require("tencentcloud-sdk-nodejs-sts");
const COS = require("cos-nodejs-sdk-v5");

const StsClient = tencentcloud.sts.v20180813.Client;

const COS_BUCKET = process.env.COS_BUCKET || "running-platform-1323797631";
const COS_REGION = process.env.COS_REGION || "ap-beijing";
const ACCOUNT_PREFIX = "_accounts";

exports.main = async (event) => {
  if (event?.httpMethod === "OPTIONS") return json(204, {});

  const body = parseBody(event);
  const action = body.action === "register" ? "register" : "login";
  const username = normalizeUsername(body.username);
  const password = String(body.password || "");
  const requestedKey = String(body.key || "");

  if (!username) return json(400, { error: "Invalid username" });
  if (password.length < 4) return json(400, { error: "Password must be at least 4 characters" });

  const userDataKey = `users/${username}/encrypted-data.json`;
  if (requestedKey && requestedKey !== userDataKey) {
    return json(403, { error: "Key does not match username" });
  }

  const cos = createCosClient();
  const accountKey = `${ACCOUNT_PREFIX}/${username}.json`;

  if (action === "register") {
    const existing = await getAccount(cos, accountKey);
    if (existing) return json(409, { error: "Username already exists" });
    await putAccount(cos, accountKey, createAccount(username, password));
  } else {
    const account = await getAccount(cos, accountKey);
    if (!account) return json(404, { error: "Account not found" });
    if (!verifyPassword(password, account)) return json(401, { error: "Invalid username or password" });
  }

  const credentials = await assumeCosRole(userDataKey);
  return json(200, credentials);
};

function createCosClient() {
  return new COS({
    SecretId: process.env.TENCENTCLOUD_SECRETID,
    SecretKey: process.env.TENCENTCLOUD_SECRETKEY
  });
}

async function getAccount(cos, key) {
  try {
    const result = await cosGetObject(cos, key);
    return JSON.parse(result.Body.toString("utf8"));
  } catch (error) {
    if (error.statusCode === 404 || error.code === "NoSuchKey") return null;
    throw error;
  }
}

async function putAccount(cos, key, account) {
  return cosPutObject(cos, key, JSON.stringify(account));
}

function createAccount(username, password) {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    version: 1,
    username,
    salt,
    passwordHash: hashPassword(password, salt),
    createdAt: Date.now()
  };
}

function verifyPassword(password, account) {
  const expected = account.passwordHash || "";
  const actual = hashPassword(password, account.salt || "");
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 180000, 32, "sha256").toString("hex");
}

async function assumeCosRole(userDataKey) {
  const roleArn = process.env.ROLE_ARN;
  if (!roleArn) throw new Error("Missing ROLE_ARN");

  const client = new StsClient({
    credential: {
      secretId: process.env.TENCENTCLOUD_SECRETID,
      secretKey: process.env.TENCENTCLOUD_SECRETKEY
    },
    region: "ap-guangzhou",
    profile: {
      httpProfile: { endpoint: "sts.tencentcloudapi.com" }
    }
  });

  const appId = COS_BUCKET.split("-").at(-1);
  const resource = `qcs::cos:${COS_REGION}:uid/${appId}:${COS_BUCKET}/${userDataKey}`;
  const policy = {
    version: "2.0",
    statement: [{
      effect: "allow",
      action: [
        "name/cos:GetObject",
        "name/cos:PutObject"
      ],
      resource: [resource]
    }]
  };

  const result = await client.AssumeRole({
    RoleArn: roleArn,
    RoleSessionName: "running-platform-user",
    DurationSeconds: 1800,
    Policy: JSON.stringify(policy)
  });

  return {
    TmpSecretId: result.Credentials.TmpSecretId,
    TmpSecretKey: result.Credentials.TmpSecretKey,
    SecurityToken: result.Credentials.Token,
    ExpiredTime: result.ExpiredTime,
    StartTime: Math.floor(Date.now() / 1000)
  };
}

function cosGetObject(cos, key) {
  return new Promise((resolve, reject) => {
    cos.getObject({ Bucket: COS_BUCKET, Region: COS_REGION, Key: key }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

function cosPutObject(cos, key, body) {
  return new Promise((resolve, reject) => {
    cos.putObject({
      Bucket: COS_BUCKET,
      Region: COS_REGION,
      Key: key,
      Body: body,
      ContentType: "application/json"
    }, (error, data) => {
      if (error) reject(error);
      else resolve(data);
    });
  });
}

function parseBody(event) {
  if (!event) return {};
  if (typeof event.body === "string") {
    try {
      return JSON.parse(event.body);
    } catch {
      return {};
    }
  }
  return event.body || event;
}

function normalizeUsername(value) {
  const username = String(value || "").trim().toLowerCase();
  return /^[a-z0-9_-]{2,32}$/.test(username) ? username : "";
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST,OPTIONS",
      "access-control-allow-headers": "content-type"
    },
    body: JSON.stringify(body)
  };
}
