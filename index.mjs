import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { startVeniceOpenAiProxyServer, discoverSessionFiles } from "./src/proxy.mjs";

function runLoginUtility(args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["./scripts/login.mjs", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || `venice-login.mjs exited with code ${code}`));
    });
  });
}

async function main() {
  const sessionFiles = discoverSessionFiles();
  const restoreResults = [];

  for (const sessionFile of sessionFiles) {
    try {
      const output = await runLoginUtility(["--restore-only", `--session-file=${sessionFile}`]);
      let parsed = null;
      try {
        parsed = JSON.parse(output);
      } catch {
        // ignore
      }
      restoreResults.push({ sessionFile, ok: true, data: parsed });
    } catch (error) {
      restoreResults.push({ sessionFile, ok: false, error: error.message });
    }
  }

  const anyOk = restoreResults.some((r) => r.ok);
  if (!anyOk && sessionFiles.length <= 1) {
    console.error("Saved session restore failed. Running login utility...");
    const fallbackArgs =
      process.env.VENICE_LOGIN_METHOD?.trim().toLowerCase() === "google"
        ? ["--google", `--session-file=${sessionFiles[0]}`]
        : [`--session-file=${sessionFiles[0]}`];
    try {
      const output = await runLoginUtility(fallbackArgs);
      restoreResults.push({ sessionFile: sessionFiles[0], ok: true, data: JSON.parse(output) });
    } catch (e) {
      console.error(`Login failed: ${e.message}`);
    }
  }

  console.log(`Loaded account pool (${sessionFiles.length} session file(s)):`);
  for (const res of restoreResults) {
    const base = path.basename(res.sessionFile);
    if (res.ok) {
      const email = res.data?.email || "active";
      console.log(`  ✓ ${base}: ${email}`);
    } else {
      console.log(`  ✗ ${base}: ${res.error || "failed"}`);
    }
  }

  const { host, port } = await startVeniceOpenAiProxyServer();
  console.log(`Venice OpenAI proxy listening on http://${host}:${port}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
