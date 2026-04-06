import dotenv from "dotenv";
import fetch from "node-fetch";
import fs from "fs";

dotenv.config();

const key = process.env.NIM_API_KEY_1 || process.env.NIM_API_KEY_2 || process.env.NIM_API_KEY_3;

if (!key) {
  console.error("No NIM API key found in .env");
  process.exit(1);
}

async function listModels() {
  try {
    const res = await fetch("https://integrate.api.nvidia.com/v1/models", {
      headers: { Authorization: `Bearer ${key}` }
    });
    if (!res.ok) {
      throw new Error(`NIM models request failed: ${res.status} ${res.statusText}`);
    }

    const payload: unknown = await res.json();
    const models = extractModelIds(payload);
    fs.writeFileSync("models.json", JSON.stringify(models, null, 2), "utf-8");
  } catch (e) {
    console.error(e);
  }
}

function extractModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || !("data" in payload)) {
    throw new Error("Unexpected NIM models payload: missing data field");
  }

  const data = (payload as { data: unknown }).data;
  if (!Array.isArray(data)) {
    throw new Error("Unexpected NIM models payload: data is not an array");
  }

  return data
    .map((item) => {
      if (!item || typeof item !== "object" || !("id" in item)) return null;
      const id = (item as { id: unknown }).id;
      return typeof id === "string" ? id : null;
    })
    .filter((id): id is string => Boolean(id));
}

listModels();
