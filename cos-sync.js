(function () {
  const CONFIG_KEY = "run-platform-cos-config-v1";
  const SDK_URL = "https://unpkg.com/cos-js-sdk-v5/dist/cos-js-sdk-v5.min.js";
  const SALT_TEXT = "run-platform-private-sync-v1";
  const DEFAULT_BUCKET = "running-platform-1323797631";
  const DEFAULT_REGION = "ap-beijing";

  class CosSync {
    constructor() {
      this.config = this.loadConfig();
      this.pin = "";
      this.username = this.config.username || "";
      this.authAction = "login";
      this.unlocked = false;
      this.cos = null;
    }

    loadConfig() {
      try {
        return JSON.parse(localStorage.getItem(CONFIG_KEY)) || {};
      } catch {
        return {};
      }
    }

    saveConfig(nextConfig = {}) {
      this.config = { ...this.config, ...nextConfig };
      localStorage.setItem(CONFIG_KEY, JSON.stringify(this.config));
    }

    async register({ username, password, credentialUrl }) {
      this.authAction = "register";
      await this.openSession({ username, password, credentialUrl });
      const remote = await this.pull();
      if (remote) throw new Error("这个用户名已经存在，请直接登录或换一个用户名");
      await this.push(emptyState());
      return null;
    }

    async login({ username, password, credentialUrl }) {
      this.authAction = "login";
      await this.openSession({ username, password, credentialUrl });
      const remote = await this.pull();
      if (!remote) throw new Error("未找到这个账号的数据，请先注册");
      return remote;
    }

    async openSession({ username, password, credentialUrl }) {
      const cleanUsername = normalizeUsername(username);
      if (!cleanUsername) throw new Error("请输入 2-32 位用户名，只能包含字母、数字、下划线和短横线");
      if (!password || password.length < 4) throw new Error("密码 / PIN 至少需要 4 位");
      this.saveConfig({
        bucket: DEFAULT_BUCKET,
        region: DEFAULT_REGION,
        key: userKey(cleanUsername),
        credentialUrl,
        username: cleanUsername
      });
      this.pin = password;
      this.username = cleanUsername;
      this.unlocked = true;
      await this.initCos();
    }

    lock() {
      this.pin = "";
      this.username = "";
      this.unlocked = false;
      this.cos = null;
    }

    async initCos() {
      const { credentialUrl } = this.config;
      if (!credentialUrl) throw new Error("请填写临时密钥接口，前端不能保存腾讯云永久密钥");
      await this.loadSdk();
      this.cos = new COS({
        getAuthorization: async (_options, callback) => {
          const response = await fetch(credentialUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              action: this.authAction,
              username: this.username,
              password: this.pin,
              scope: "running-platform",
              key: this.config.key
            })
          });
          if (!response.ok) throw new Error("获取 COS 临时密钥失败");
          const data = await response.json();
          callback({
            TmpSecretId: data.TmpSecretId || data.credentials?.tmpSecretId,
            TmpSecretKey: data.TmpSecretKey || data.credentials?.tmpSecretKey,
            SecurityToken: data.SecurityToken || data.credentials?.sessionToken,
            StartTime: data.StartTime || data.startTime,
            ExpiredTime: data.ExpiredTime || data.expiredTime
          });
        }
      });
    }

    async loadSdk() {
      if (window.COS) return window.COS;
      await new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${SDK_URL}"]`);
        if (existing) {
          existing.addEventListener("load", resolve, { once: true });
          existing.addEventListener("error", reject, { once: true });
          return;
        }
        const script = document.createElement("script");
        script.src = SDK_URL;
        script.async = true;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
      if (!window.COS) throw new Error("COS SDK 加载失败");
      return window.COS;
    }

    async pull() {
      this.ensureReady();
      try {
        const result = await this.cosGetObject();
        const encrypted = JSON.parse(result.Body);
        return decryptState(encrypted, this.pin);
      } catch (error) {
        const status = error.statusCode || error.status || error.code;
        if (status === 404 || String(error.message || "").includes("NoSuchKey")) {
          return null;
        }
        throw error;
      }
    }

    async push(state) {
      this.ensureReady();
      const encrypted = await encryptState(state, this.pin);
      await this.cosPutObject(JSON.stringify(encrypted));
      return { pushedAt: Date.now() };
    }

    async sync(state) {
      const remote = await this.pull();
      if (!remote) {
        await this.push(state);
        return null;
      }
      return remote;
    }

    cosGetObject() {
      const { bucket, region, key } = this.config;
      return new Promise((resolve, reject) => {
        this.cos.getObject({ Bucket: bucket, Region: region, Key: key }, (error, data) => {
          if (error) reject(error);
          else resolve(data);
        });
      });
    }

    cosPutObject(body) {
      const { bucket, region, key } = this.config;
      return new Promise((resolve, reject) => {
        this.cos.putObject({
          Bucket: bucket,
          Region: region,
          Key: key,
          Body: body,
          ContentType: "application/json"
        }, (error, data) => {
          if (error) reject(error);
          else resolve(data);
        });
      });
    }

    ensureReady() {
      if (!this.unlocked || !this.cos) throw new Error("请先登录账号");
      const { bucket, region, key } = this.config;
      if (!bucket || !region || !key) throw new Error("请填写 COS Bucket、Region 和数据文件 Key");
    }
  }

  async function encryptState(state, pin) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(pin);
    const payload = new TextEncoder().encode(JSON.stringify({
      version: 1,
      updatedAt: Date.now(),
      state
    }));
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload);
    return {
      version: 1,
      algorithm: "AES-GCM",
      iv: toBase64(iv),
      data: toBase64(new Uint8Array(cipher))
    };
  }

  async function decryptState(encrypted, pin) {
    const key = await deriveKey(pin);
    const iv = fromBase64(encrypted.iv);
    const data = fromBase64(encrypted.data);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    const payload = JSON.parse(new TextDecoder().decode(plain));
    return payload.state;
  }

  async function deriveKey(pin) {
    const baseKey = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({
      name: "PBKDF2",
      salt: new TextEncoder().encode(SALT_TEXT),
      iterations: 180000,
      hash: "SHA-256"
    }, baseKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  async function sha256(value) {
    const bytes = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  function toBase64(bytes) {
    return btoa(String.fromCharCode(...bytes));
  }

  function fromBase64(value) {
    return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  }

  function normalizeUsername(value) {
    const username = String(value || "").trim().toLowerCase();
    return /^[a-z0-9_-]{2,32}$/.test(username) ? username : "";
  }

  function userKey(username) {
    return `users/${username}/encrypted-data.json`;
  }

  function emptyState() {
    return {
      runs: [],
      weights: [],
      deletedRunIds: [],
      deletedWeightIds: [],
      goalDistance: 21.0975,
      settingsUpdatedAt: Date.now(),
      lastSyncedAt: 0
    };
  }

  window.RunCosSync = CosSync;
})();
