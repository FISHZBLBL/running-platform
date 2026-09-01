import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import { Buffer } from "node:buffer";

const LOCAL_AI_FUNCTIONS = {
  "/api/ai-settings/deepseek": "/netlify/functions/ai-settings.ts",
  "/api/ai-prediction": "/netlify/functions/ai-prediction.ts"
};

async function readRequestBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function localAiFunctions() {
  return {
    name: "local-ai-functions",
    configureServer(server) {
      // Keep local API keys and analysis caches in .netlify/local-data. This mirrors
      // Netlify dev's local fallback without requiring the Netlify CLI to be installed.
      process.env.NETLIFY_DEV = "true";

      server.middlewares.use(async (request, response, next) => {
        const modulePath = LOCAL_AI_FUNCTIONS[request.url?.split("?", 1)[0] ?? ""];
        if (!modulePath) {
          next();
          return;
        }

        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(request.headers)) {
            if (Array.isArray(value)) {
              value.forEach((item) => headers.append(name, item));
            } else if (typeof value === "string") {
              headers.set(name, value);
            }
          }

          const method = request.method ?? "GET";
          const body = method === "GET" || method === "HEAD" ? undefined : await readRequestBody(request);
          const host = request.headers.host ?? "127.0.0.1";
          const functionRequest = new Request(`http://${host}${request.url ?? "/"}`, {
            method,
            headers,
            body,
            duplex: body ? "half" : undefined
          });
          const module = await server.ssrLoadModule(modulePath);
          const functionResponse = await module.default(functionRequest);

          response.statusCode = functionResponse.status;
          functionResponse.headers.forEach((value, name) => response.setHeader(name, value));
          response.end(Buffer.from(await functionResponse.arrayBuffer()));
        } catch (error) {
          const message = error instanceof Error ? error.message : "本地 AI 函数启动失败。";
          response.statusCode = 500;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: message, status: 500 }));
        }
      });
    }
  };
}

export default defineConfig({
  plugins: [react(), localAiFunctions()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./shared", import.meta.url))
    }
  },
  server: {
    port: 5173
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"]
  }
});
