const STAGE_KEY = "__CODEX_DYNAMIC_SKIN_ASSET_STAGE__";
const PATH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,511}$/;
const GENERATION_PATTERN = /^[A-Za-z0-9._:-]{1,160}$/;
const MEDIA_TYPE_PATTERN = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i;
const DEFAULT_CHUNK_BYTES = 768 * 1024;
const MIN_CHUNK_BYTES = 3;
const MAX_CHUNK_BYTES = 1024 * 1024;

function json(value) {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/gu, (character) => ({
    "<": "\\u003c", ">": "\\u003e", "&": "\\u0026",
    "\u2028": "\\u2028", "\u2029": "\\u2029",
  })[character]);
}

function normalizeAssets(assets) {
  if (!Array.isArray(assets) || assets.length === 0 || assets.length > 128) {
    throw new TypeError("renderer asset list must contain 1 to 128 entries");
  }
  const seen = new Set();
  return assets.map((asset) => {
    if (!asset || typeof asset !== "object" || !PATH_PATTERN.test(asset.path ?? "")
      || asset.path.startsWith("/") || asset.path.includes("..") || seen.has(asset.path)) {
      throw new TypeError("renderer asset path is invalid or duplicated");
    }
    if (!MEDIA_TYPE_PATTERN.test(asset.mediaType ?? "")) {
      throw new TypeError(`renderer asset media type is invalid: ${asset.path}`);
    }
    const bytes = Buffer.isBuffer(asset.bytes) ? asset.bytes : Buffer.from(asset.bytes ?? []);
    if (bytes.length === 0) throw new TypeError(`renderer asset is empty: ${asset.path}`);
    seen.add(asset.path);
    return { path: asset.path, mediaType: asset.mediaType, bytes };
  });
}

function cleanupExpression(generation) {
  return `(() => {
    const key = ${json(STAGE_KEY)};
    const stage = globalThis[key];
    if (!stage || stage.generation !== ${json(generation)}) return false;
    for (const url of stage.urls || []) { try { URL.revokeObjectURL(url); } catch {} }
    delete globalThis[key];
    return true;
  })()`;
}

export async function revokeRendererAssetUrls(session, assetUrls) {
  if (!session || typeof session.evaluate !== "function") return false;
  const urls = [...new Set(Object.values(assetUrls ?? {}).filter((value) =>
    typeof value === "string" && value.startsWith("blob:app:")))];
  if (urls.length === 0) return false;
  return session.evaluate(`(() => {
    for (const url of ${json(urls)}) { try { URL.revokeObjectURL(url); } catch {} }
    return true;
  })()`);
}

export async function stageRendererAssets(session, assets, generation, options = {}) {
  if (!session || typeof session.evaluate !== "function") {
    throw new TypeError("renderer session must provide evaluate(expression)");
  }
  if (!GENERATION_PATTERN.test(generation ?? "")) {
    throw new TypeError("renderer asset generation is invalid");
  }
  const normalized = normalizeAssets(assets);
  const chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
  if (!Number.isSafeInteger(chunkBytes) || chunkBytes < MIN_CHUNK_BYTES
    || chunkBytes > MAX_CHUNK_BYTES) {
    throw new TypeError("renderer asset chunk size is invalid");
  }
  const descriptors = normalized.map(({ path, mediaType }) => ({ path, mediaType }));
  await session.evaluate(`(() => {
    const key = ${json(STAGE_KEY)};
    const previous = globalThis[key];
    if (previous) {
      for (const url of previous.urls || []) { try { URL.revokeObjectURL(url); } catch {} }
    }
    globalThis[key] = {
      generation: ${json(generation)},
      descriptors: ${json(descriptors)},
      chunks: Object.create(null),
      urls: [],
    };
    for (const descriptor of globalThis[key].descriptors) {
      globalThis[key].chunks[descriptor.path] = [];
    }
    return true;
  })()`);

  try {
    for (const asset of normalized) {
      for (let offset = 0; offset < asset.bytes.length; offset += chunkBytes) {
        const encoded = asset.bytes.subarray(offset, offset + chunkBytes).toString("base64");
        await session.evaluate(`(() => {
          const stage = globalThis[${json(STAGE_KEY)}];
          if (!stage || stage.generation !== ${json(generation)}) {
            throw new Error("renderer asset stage was replaced");
          }
          stage.chunks[${json(asset.path)}].push(${json(encoded)});
          return true;
        })()`);
      }
    }
    const result = await session.evaluate(`(() => {
      const __CODEX_DYNAMIC_SKIN_FINALIZE_ASSETS__ = true;
      const key = ${json(STAGE_KEY)};
      const stage = globalThis[key];
      if (!stage || stage.generation !== ${json(generation)}) {
        throw new Error("renderer asset stage was replaced");
      }
      const entries = [];
      for (const descriptor of stage.descriptors) {
        const parts = stage.chunks[descriptor.path].map((encoded) => {
          const binary = atob(encoded);
          const bytes = new Uint8Array(binary.length);
          for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
          return bytes;
        });
        const url = URL.createObjectURL(new Blob(parts, { type: descriptor.mediaType }));
        stage.urls.push(url);
        entries.push([descriptor.path, url]);
        delete stage.chunks[descriptor.path];
      }
      delete globalThis[key];
      return Object.fromEntries(entries);
    })()`);
    return JSON.parse(JSON.stringify(result));
  } catch (error) {
    await session.evaluate(cleanupExpression(generation)).catch(() => {});
    throw error;
  }
}
