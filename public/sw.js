const SHELL_CACHE_PREFIX = "project-manager-shell-";
const META_CACHE_NAME = "project-manager-sw-meta-v1";
const RUNTIME_CACHE_NAME = "project-manager-runtime-v1";
const ACTIVE_SHELL_POINTER = new URL("/__project-manager-sw/active-shell", self.location.origin).href;
const STAGED_SHELL_POINTER = new URL("/__project-manager-sw/staged-shell", self.location.origin).href;
const STATIC_SHELL = [
  "/manifest.webmanifest",
  "/theme-init.js",
  "/icons/icon-192.png",
  "/icons/icon-512.png"
];

const HASHED_ASSET = /^\/assets\/(.+)-[A-Za-z0-9_-]+\.([A-Za-z0-9]+)$/;
let activeShellCacheName = null;
let shellRefreshPromise = null;
let queuedShellRefreshResponse = null;

function newShellCacheName() {
  return `${SHELL_CACHE_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function hashedAssetsFromHtml(html) {
  const assets = new Set();
  const attribute = /(?:src|href)=["']([^"']+)["']/g;
  for (const match of html.matchAll(attribute)) {
    const url = new URL(match[1], self.location.origin);
    if (url.origin === self.location.origin && HASHED_ASSET.test(url.pathname)) {
      assets.add(url.pathname);
    }
  }
  return [...assets];
}

async function readPointer(key) {
  const metadata = await caches.open(META_CACHE_NAME);
  const response = await metadata.match(key);
  if (!response) return null;
  const name = (await response.text()).trim();
  return name.startsWith(SHELL_CACHE_PREFIX) ? name : null;
}

async function writePointer(key, cacheName) {
  const metadata = await caches.open(META_CACHE_NAME);
  await metadata.put(
    key,
    new Response(cacheName, {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }
    })
  );
}

async function deletePointer(key) {
  const metadata = await caches.open(META_CACHE_NAME);
  await metadata.delete(key);
}

function newestShellName(cacheNames) {
  const shellNames = cacheNames.filter((name) => name.startsWith(SHELL_CACHE_PREFIX));
  const timestamped = shellNames
    .map((name) => {
      const suffix = name.slice(SHELL_CACHE_PREFIX.length);
      const separator = suffix.indexOf("-");
      return { name, timestamp: separator > 0 ? Number.parseInt(suffix.slice(0, separator), 36) : Number.NaN };
    })
    .filter(({ timestamp }) => Number.isFinite(timestamp));
  if (timestamped.length > 0) {
    timestamped.sort((left, right) => left.timestamp - right.timestamp);
    return timestamped.at(-1).name;
  }
  return shellNames.sort().at(-1) ?? null;
}

async function stageCompleteShell(indexResponse, html) {
  const stagedName = newShellCacheName();
  const staged = await caches.open(stagedName);
  try {
    if (!indexResponse.ok) {
      throw new Error(`Could not cache app shell: ${indexResponse.status}`);
    }

    const hashedAssets = hashedAssetsFromHtml(html);
    const staticRequests = STATIC_SHELL.map((path) => new Request(path, { cache: "no-cache" }));
    // Write the HTML last. Every candidate therefore has all resources used by
    // that exact document before it can become active. Unhashed files bypass a
    // potentially stale browser HTTP cache; content-hashed assets stay cheap.
    await staged.addAll([...staticRequests, ...hashedAssets]);
    await staged.put("/", indexResponse);
    return stagedName;
  } catch (error) {
    await caches.delete(stagedName);
    throw error;
  }
}

async function stageInstallShell() {
  const indexResponse = await fetch("/", { cache: "no-cache" });
  if (!indexResponse.ok) {
    throw new Error(`Could not cache app shell: ${indexResponse.status}`);
  }
  const html = await indexResponse.clone().text();
  const stagedName = await stageCompleteShell(indexResponse, html);
  try {
    // Install and activate can run in separate worker executions. Persist the
    // complete candidate name without changing the current active pointer.
    await writePointer(STAGED_SHELL_POINTER, stagedName);
  } catch (error) {
    await caches.delete(stagedName);
    throw error;
  }
}

async function archiveRuntimeHashedAssets(previousName) {
  if (!previousName) return;
  const cacheNames = await caches.keys();
  if (!cacheNames.includes(RUNTIME_CACHE_NAME) || !cacheNames.includes(previousName)) return;

  const [runtime, previous] = await Promise.all([
    caches.open(RUNTIME_CACHE_NAME),
    caches.open(previousName)
  ]);
  const requests = await runtime.keys();
  await Promise.all(
    requests.map(async (request) => {
      const url = new URL(request.url);
      if (url.origin !== self.location.origin || !HASHED_ASSET.test(url.pathname)) return;
      const response = await runtime.match(request);
      if (response) await previous.put(request, response);
    })
  );
}

async function promoteShell(stagedName) {
  const cacheNames = await caches.keys();
  if (!cacheNames.includes(stagedName)) {
    throw new Error("The staged app shell cache is missing");
  }
  const staged = await caches.open(stagedName);
  if (!(await staged.match("/"))) {
    throw new Error("The staged app shell is incomplete");
  }

  const pointedPreviousName = await readPointer(ACTIVE_SHELL_POINTER);
  const previousName =
    pointedPreviousName && cacheNames.includes(pointedPreviousName)
      ? pointedPreviousName
      : newestShellName(cacheNames.filter((name) => name !== stagedName));

  // Preserve lazy chunks that the previous app generation has already used.
  // Once copied, the retained previous shell is self-contained for those tabs
  // and the fixed runtime cache can be reclaimed after the pointer switches.
  await archiveRuntimeHashedAssets(previousName);

  // Replacing this single metadata response is the commit point. Fetches can
  // observe the previous complete shell or this complete candidate, never a
  // document whose content-hashed assets are only partly cached.
  await writePointer(ACTIVE_SHELL_POINTER, stagedName);
  activeShellCacheName = stagedName;

  // Preserve one previous shell for already-open tabs. Also protect a waiting
  // worker's install candidate from a concurrent refresh by this active worker.
  const pendingInstallName = await readPointer(STAGED_SHELL_POINTER).catch(() => null);
  const keep = new Set([stagedName, previousName, pendingInstallName].filter(Boolean));
  await Promise.allSettled([
    // Runtime entries belong to the previous document graph. Clear them only
    // after the new active pointer has committed successfully.
    caches.delete(RUNTIME_CACHE_NAME),
    ...cacheNames
      .filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && !keep.has(name))
      .map((name) => caches.delete(name))
  ]);
}

async function activateStagedShell() {
  const stagedName = await readPointer(STAGED_SHELL_POINTER);
  if (!stagedName) {
    throw new Error("No complete staged app shell is available");
  }
  await promoteShell(stagedName);
  await deletePointer(STAGED_SHELL_POINTER).catch(() => undefined);
}

async function getActiveShellCacheName() {
  if (activeShellCacheName) return activeShellCacheName;
  const pointedName = await readPointer(ACTIVE_SHELL_POINTER);
  const cacheNames = await caches.keys();
  if (pointedName && cacheNames.includes(pointedName)) {
    activeShellCacheName = pointedName;
    return pointedName;
  }

  // Cache metadata and cached responses can be evicted independently. If the
  // pointer disappeared, recover the newest remaining complete generation.
  const fallback = newestShellName(cacheNames);
  activeShellCacheName = fallback;
  return fallback;
}

async function responsesHaveSameBody(left, right) {
  if (!left || !right) return false;
  const leftEtag = left.headers.get("ETag");
  const rightEtag = right.headers.get("ETag");
  if (leftEtag && rightEtag) return leftEtag === rightEtag;
  const leftLength = left.headers.get("Content-Length");
  const rightLength = right.headers.get("Content-Length");
  if (leftLength && rightLength && leftLength !== rightLength) return false;

  const [leftBytes, rightBytes] = await Promise.all([left.arrayBuffer(), right.arrayBuffer()]);
  if (leftBytes.byteLength !== rightBytes.byteLength) return false;
  const leftView = new Uint8Array(leftBytes);
  const rightView = new Uint8Array(rightBytes);
  return leftView.every((value, index) => value === rightView[index]);
}

async function candidateMatchesActiveShell(stagedName, html) {
  const activeName = await getActiveShellCacheName();
  if (!activeName || activeName === stagedName) return false;
  const [active, staged] = await Promise.all([caches.open(activeName), caches.open(stagedName)]);
  const activeIndex = await active.match("/");
  if (!activeIndex || (await activeIndex.text()) !== html) return false;

  for (const path of [...STATIC_SHELL, ...hashedAssetsFromHtml(html)]) {
    const [activeResponse, stagedResponse] = await Promise.all([active.match(path), staged.match(path)]);
    if (HASHED_ASSET.test(path)) {
      if (!activeResponse || !stagedResponse) return false;
    } else if (!(await responsesHaveSameBody(activeResponse, stagedResponse))) {
      return false;
    }
  }
  return true;
}

async function refreshShellFromNavigation(indexResponse) {
  if (!indexResponse.ok || !indexResponse.headers.get("Content-Type")?.includes("text/html")) return;
  const html = await indexResponse.clone().text();
  const stagedName = await stageCompleteShell(indexResponse, html);
  try {
    if (await candidateMatchesActiveShell(stagedName, html)) {
      await caches.delete(stagedName);
      return;
    }
    await promoteShell(stagedName);
  } catch (error) {
    // promoteShell only rejects before changing ACTIVE_SHELL_POINTER, so a
    // failed refresh can discard its candidate while the old shell remains.
    await caches.delete(stagedName);
    throw error;
  }
}

function scheduleShellRefresh(indexResponse) {
  // Coalesce simultaneous navigations and retain the newest response for one
  // follow-up pass if a refresh is already running.
  queuedShellRefreshResponse = indexResponse;
  if (shellRefreshPromise) return shellRefreshPromise;
  shellRefreshPromise = (async () => {
    while (queuedShellRefreshResponse) {
      const response = queuedShellRefreshResponse;
      queuedShellRefreshResponse = null;
      await refreshShellFromNavigation(response);
    }
  })().finally(() => {
    shellRefreshPromise = null;
  });
  return shellRefreshPromise;
}

async function matchShell(request) {
  const activeName = await getActiveShellCacheName();
  if (!activeName) return undefined;
  const active = await caches.open(activeName);
  const activeMatch = await active.match(request);
  if (activeMatch) return activeMatch;

  // The retained previous generation can satisfy a late lazy-chunk request
  // from a tab that loaded before the active pointer changed.
  const cacheNames = await caches.keys();
  for (const name of cacheNames) {
    if (name.startsWith(SHELL_CACHE_PREFIX) && name !== activeName) {
      const cached = await (await caches.open(name)).match(request);
      if (cached) return cached;
    }
  }
  return undefined;
}

function cacheFirst(request) {
  const result = (async () => {
    const shellMatch = await matchShell(request);
    if (shellMatch) return { response: shellMatch, runtime: null, copy: null };

    const runtime = await caches.open(RUNTIME_CACHE_NAME);
    const runtimeMatch = await runtime.match(request);
    if (runtimeMatch) return { response: runtimeMatch, runtime: null, copy: null };

    const response = await fetch(request);
    return { response, runtime, copy: response.ok ? response.clone() : null };
  })();

  return {
    response: result.then(({ response }) => response),
    cacheWrite: result.then(async ({ runtime, copy }) => {
      if (runtime && copy) await runtime.put(request, copy);
    })
  };
}

function navigationNetworkFirst(request, preloadResponse) {
  const result = (async () => {
    try {
      const preloaded = await preloadResponse;
      const response = preloaded ?? (await fetch(request));
      return { response, refresh: response.ok ? response.clone() : null };
    } catch {
      // Navigations never update an active cache in place. Offline fallback is
      // always the document belonging to the committed active generation.
      const fallback = await matchShell(new Request("/"));
      return { response: fallback ?? Response.error(), refresh: null };
    }
  })();

  return {
    response: result.then(({ response }) => response),
    shellRefresh: result.then(({ refresh }) => (refresh ? scheduleShellRefresh(refresh) : undefined))
  };
}

function resourceNetworkFirst(request) {
  const result = (async () => {
    const runtime = await caches.open(RUNTIME_CACHE_NAME);
    try {
      const response = await fetch(request);
      return { response, runtime, copy: response.ok ? response.clone() : null };
    } catch {
      const cached = (await matchShell(request)) ?? (await runtime.match(request));
      return { response: cached ?? Response.error(), runtime: null, copy: null };
    }
  })();

  return {
    response: result.then(({ response }) => response),
    cacheWrite: result.then(async ({ runtime, copy }) => {
      if (runtime && copy) await runtime.put(request, copy);
    })
  };
}

self.addEventListener("install", (event) => {
  event.waitUntil(stageInstallShell().then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    activateStagedShell().then(async () => {
      await self.registration.navigationPreload?.enable();
      await self.clients.claim();
    })
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    const task = navigationNetworkFirst(request, event.preloadResponse);
    event.respondWith(task.response);
    event.waitUntil(task.shellRefresh);
    return;
  }

  if (HASHED_ASSET.test(url.pathname)) {
    const task = cacheFirst(request);
    event.respondWith(task.response);
    event.waitUntil(task.cacheWrite);
    return;
  }

  const task = resourceNetworkFirst(request);
  event.respondWith(task.response);
  event.waitUntil(task.cacheWrite);
});
