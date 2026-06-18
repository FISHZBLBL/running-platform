type NetlifyEnv = {
  env: {
    get(name: string): string | undefined;
  };
};

declare const Netlify: NetlifyEnv | undefined;

export function getEnv(name: string, fallback?: string): string | undefined {
  try {
    if (typeof Netlify !== "undefined") {
      const value = Netlify.env.get(name);
      if (value) {
        return value;
      }
    }
  } catch {
    // Netlify.env is not available in local unit tests.
  }
  return process.env[name] ?? fallback;
}

export function isCloudFunctionRuntime(): boolean {
  return Boolean(
    getEnv("NETLIFY") ||
      getEnv("AWS_LAMBDA_FUNCTION_NAME") ||
      getEnv("LAMBDA_TASK_ROOT") ||
      process.cwd().replace(/\\/g, "/") === "/var/task"
  );
}

export function requiredEnv(name: string): string {
  const value = getEnv(name);
  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

export function inviteCode(): string {
  return getEnv("INVITE_CODE", "FISH_Z")!;
}

export function jwtSecret(): string {
  const value = getEnv("JWT_SECRET");
  if (value) {
    return value;
  }
  if (getEnv("CONTEXT") === "production" || isCloudFunctionRuntime()) {
    throw new Error("JWT_SECRET must be configured in production.");
  }
  return "dev-only-running-platform-secret";
}
